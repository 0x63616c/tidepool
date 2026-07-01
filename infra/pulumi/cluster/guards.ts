/**
 * Pure security guards + policy builders — deliberately free of any `@pulumi/*`
 * import so they can be unit-tested under the root vitest (tenet 12: red-green the
 * fail-closed guard + the NetworkPolicy excepts). The Pulumi modules import these;
 * the tests import ONLY this file.
 */

/** IPv4/IPv6 "everything" CIDRs — never valid for the admin allow-list. */
const OPEN_CIDRS = ['0.0.0.0/0', '::/0'];

/**
 * Fail-closed: refuse to open the Talos apid (50000) + kube-apiserver (6443) to
 * the whole internet. Throws only at APPLY (`isApply`), so a first `pulumi preview`
 * with the permissive default still renders — but a real `pulumi up` cannot proceed
 * until `adminCidrs` is narrowed (tenet 9). Caller passes `!pulumi.runtime.isDryRun()`.
 */
export function assertAdminCidrsLocked(adminCidrs: readonly string[], isApply: boolean): void {
  if (!isApply) return;
  const open = adminCidrs.filter((c) => OPEN_CIDRS.includes(c.trim()));
  if (open.length > 0) {
    throw new Error(
      `refusing to apply: adminCidrs must be locked to operator /32(s), got open range(s) ` +
        `[${open.join(', ')}]. Set tidepool-cluster:adminCidrs (see Pulumi.production.yaml).`,
    );
  }
}

/**
 * Source allow-list for the control ports (kube-apiserver 6443 + Talos apid 50000):
 * the operator adminCidrs plus, when set, the CI runner's ephemeral /32 (#4). Kept
 * pure so the combination is asserted under vitest.
 */
export function controlPortSourceCidrs(
  adminCidrs: readonly string[],
  ciRunnerCidr?: string,
): string[] {
  const runner = ciRunnerCidr?.trim();
  return runner ? [...adminCidrs, runner] : [...adminCidrs];
}

/**
 * Resolve the image ref to deploy: prefer a CI-resolved digest (`override`, set
 * by the up-job from the current commit's freshly-built image) over the git-pinned
 * `fallback` in Pulumi.production.yaml. This is the merge→deploy auto-pin seam.
 * Fails CLOSED if the override is not `@sha256:`-pinned — a mutable tag would break
 * reproducible rollout (tenet 8), the same invariant `cfg.require` protects for the
 * committed value.
 */
export function pickImage(override: string | undefined, fallback: string): string {
  if (override === undefined || override === '') return fallback;
  if (!override.includes('@sha256:')) {
    throw new Error(`refusing mutable-tag image override (must be @sha256-pinned): ${override}`);
  }
  return override;
}

/** One RBAC PolicyRule (pure shape; workloads.ts maps it to the @pulumi type). */
export interface WorkerDriverRule {
  readonly apiGroups: readonly string[];
  readonly resources: readonly string[];
  readonly verbs: readonly string[];
}

/**
 * Least-privilege RBAC the reconciler SA (in `tidepool`) needs to drive worker
 * Jobs in the untrusted `agents` namespace — and nothing more:
 *  - jobs: full lifecycle (dispatch/poll/cancel/reap).
 *  - pods + pods/log: read-only, to stream worker output.
 *  - secrets: CREATE ONLY — the per-Job creds Secret (opencode auth + git token).
 *    It carries an ownerReference→Job, so k8s GC cascades it on Job teardown;
 *    the SA never needs get/list/delete on secrets (tenet 9 least-privilege).
 * Kept pure so the grant is asserted under vitest (tenet 12).
 */
export function buildWorkerDriverRules(): readonly WorkerDriverRule[] {
  return [
    { apiGroups: ['batch'], resources: ['jobs'], verbs: ['create', 'get', 'list', 'watch', 'delete'] },
    { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
    { apiGroups: [''], resources: ['secrets'], verbs: ['create'] },
  ];
}

/** The cluster-internal ranges that untrusted worker egress must NOT reach. */
export function clusterInternalCidrs(
  podCidr: string,
  serviceCidr: string,
  nodeSubnetCidr: string,
): string[] {
  return [podCidr, serviceCidr, nodeSubnetCidr];
}

/**
 * Egress NetworkPolicy spec for the untrusted worker namespace: allow cluster DNS
 * and outbound HTTPS to the INTERNET only — the `:443` rule carries an `ipBlock`
 * that excepts the pod/service/node ranges, so workers can clone git / call model
 * APIs but CANNOT reach the apiserver or any in-cluster service (tenet 9 wall).
 */
export function buildWorkerEgressPolicySpec(
  podCidr: string,
  serviceCidr: string,
  nodeSubnetCidr: string,
): Record<string, unknown> {
  return {
    podSelector: {},
    policyTypes: ['Egress'],
    egress: [
      {
        // Cluster DNS (kube-dns in kube-system).
        to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
        ports: [
          { protocol: 'UDP', port: 53 },
          { protocol: 'TCP', port: 53 },
        ],
      },
      {
        // Outbound HTTPS to the internet, MINUS all cluster-internal ranges.
        to: [
          {
            ipBlock: {
              cidr: '0.0.0.0/0',
              except: clusterInternalCidrs(podCidr, serviceCidr, nodeSubnetCidr),
            },
          },
        ],
        ports: [{ protocol: 'TCP', port: 443 }],
      },
    ],
  };
}
