import { describe, expect, it } from 'vitest';
import {
  assertAdminCidrsLocked,
  buildWorkerEgressPolicySpec,
  controlPortSourceCidrs,
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
