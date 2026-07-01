import { describe, expect, it } from 'vitest';
import {
  assertAdminCidrsLocked,
  buildWorkerDriverRules,
  buildWorkerEgressPolicySpec,
  controlPortSourceCidrs,
  GIT_SHA_LABEL,
  gitShaLabelValue,
  pickImage,
} from './guards';

describe('assertAdminCidrsLocked (fail-closed firewall guard)', () => {
  it('throws at apply when adminCidrs contains 0.0.0.0/0', () => {
    expect(() => assertAdminCidrsLocked(['0.0.0.0/0'], true)).toThrow(/locked to operator/);
  });

  it('throws at apply on the IPv6 open range too', () => {
    expect(() => assertAdminCidrsLocked(['::/0'], true)).toThrow();
  });

  it('does NOT throw at preview (dry-run) even with an open range', () => {
    expect(() => assertAdminCidrsLocked(['0.0.0.0/0'], false)).not.toThrow();
  });

  it('does NOT throw at apply when locked to a /32', () => {
    expect(() => assertAdminCidrsLocked(['192.0.2.10/32'], true)).not.toThrow();
  });
});

describe('controlPortSourceCidrs (#4 JIT CI reachability)', () => {
  it('is admin-only when no CI runner cidr is set', () => {
    expect(controlPortSourceCidrs(['192.0.2.10/32'])).toEqual(['192.0.2.10/32']);
  });

  it('appends the CI runner /32 when set', () => {
    expect(controlPortSourceCidrs(['192.0.2.10/32'], '198.51.100.7/32')).toEqual([
      '192.0.2.10/32',
      '198.51.100.7/32',
    ]);
  });

  it('ignores an empty/whitespace runner cidr', () => {
    expect(controlPortSourceCidrs(['192.0.2.10/32'], '   ')).toEqual(['192.0.2.10/32']);
  });
});

describe('buildWorkerEgressPolicySpec (tenet-9 wall)', () => {
  const pod = '10.244.0.0/16';
  const svc = '10.96.0.0/12';
  const node = '10.10.0.0/24';
  const spec = buildWorkerEgressPolicySpec(pod, svc, node);

  it('is egress-only', () => {
    expect(spec.policyTypes).toEqual(['Egress']);
  });

  it('the :443 rule excepts every cluster-internal range (no apiserver reach)', () => {
    const egress = spec.egress as Array<Record<string, unknown>>;
    const https = egress.find((r) => {
      const ports = r.ports as Array<{ port: number }>;
      return ports?.some((p) => p.port === 443);
    });
    expect(https).toBeDefined();
    const to = (https as { to: Array<{ ipBlock?: { cidr: string; except: string[] } }> }).to;
    const ipBlock = to[0]?.ipBlock;
    expect(ipBlock?.cidr).toBe('0.0.0.0/0');
    expect(ipBlock?.except).toEqual([pod, svc, node]);
  });

  it('still permits cluster DNS', () => {
    const egress = spec.egress as Array<Record<string, unknown>>;
    const dns = egress.find((r) => {
      const ports = r.ports as Array<{ port: number }>;
      return ports?.some((p) => p.port === 53);
    });
    expect(dns).toBeDefined();
  });
});

describe('pickImage (CI auto-deploy override, fail-closed on mutable tags)', () => {
  const gitPinned = 'ghcr.io/0x63616c/tidepool-control-plane@sha256:aaa';
  const ciResolved = 'ghcr.io/0x63616c/tidepool-control-plane@sha256:bbb';

  it('uses the git-pinned config value when there is no CI override', () => {
    expect(pickImage(undefined, gitPinned)).toBe(gitPinned);
  });

  it('prefers the CI-resolved digest override when present', () => {
    expect(pickImage(ciResolved, gitPinned)).toBe(ciResolved);
  });

  it('rejects a mutable-tag override (must be @sha256-pinned, tenet 8)', () => {
    expect(() => pickImage('ghcr.io/0x63616c/tidepool-control-plane:latest', gitPinned)).toThrow();
  });
});

describe('buildWorkerDriverRules (reconciler SA least-privilege in worker ns)', () => {
  const rules = buildWorkerDriverRules();
  const ruleFor = (apiGroup: string, resource: string) =>
    rules.find((r) => r.apiGroups.includes(apiGroup) && r.resources.includes(resource));

  it('can create the per-Job creds Secret — but only create (Job ownerRef GCs it)', () => {
    // The dispatch bug: without secrets:create the control-plane SA 403s creating
    // the per-Job auth Secret and every dispatch fails. `create` is the tightest
    // possible grant (RBAC can't scope create by name); get/list/delete are NOT
    // needed because the Secret's ownerReference→Job cascades on Job teardown.
    const secrets = ruleFor('', 'secrets');
    expect(secrets?.verbs).toEqual(['create']);
  });

  it('drives Jobs (create+delete) and reads pod logs, nothing cluster-wide', () => {
    expect(ruleFor('batch', 'jobs')?.verbs).toEqual(['create', 'get', 'list', 'watch', 'delete']);
    expect(ruleFor('', 'pods/log')?.verbs).toEqual(['get']);
  });
});

describe('gitShaLabelValue (fail-open git-sha label)', () => {
  it('uses the standard tidepool/* label key', () => {
    expect(GIT_SHA_LABEL).toBe('tidepool/git-sha');
  });

  it('passes a real 40-char git sha through unchanged', () => {
    const sha = 'bcf78e0a1b2c3d4e5f60718293a4b5c6d7e8f901';
    expect(gitShaLabelValue(sha)).toBe(sha);
  });

  it('falls open to `dev` when the sha is absent (local pulumi up, no CI env)', () => {
    expect(gitShaLabelValue(undefined)).toBe('dev');
    expect(gitShaLabelValue('')).toBe('dev');
    expect(gitShaLabelValue('   ')).toBe('dev');
  });

  it('trims surrounding whitespace', () => {
    expect(gitShaLabelValue('  abc123  ')).toBe('abc123');
  });

  it('coerces an odd ref into a valid k8s label value (never a crashy manifest)', () => {
    const out = gitShaLabelValue('feature/weird ref@head');
    expect(out).toMatch(/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/);
    expect(out.length).toBeLessThanOrEqual(63);
  });

  it('bounds an over-long value to 63 chars with alphanumeric edges', () => {
    const out = gitShaLabelValue('a'.repeat(80));
    expect(out.length).toBe(63);
    expect(out).toMatch(/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/);
  });
});
