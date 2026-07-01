import * as k8s from '@pulumi/kubernetes';
import { NODE_SUBNET_CIDR, POD_CIDR, SERVICE_CIDR } from './config';
import { buildWorkerEgressPolicySpec } from './guards';

/**
 * Namespaces + the security wall (tenet 6/9). The agent-worker namespace is
 * treated as untrusted: default-deny ingress AND egress, then only the minimum
 * egress (cluster DNS + outbound HTTPS) is punched back. The reconciler's
 * ServiceAccount gets least-privilege RBAC — exactly dispatch/poll/cancel/reap on
 * Jobs — and nothing cluster-wide.
 *
 * CNPG's own namespaces (cnpg-system, cert-manager) land in PR-5b.
 */
export function createWorkloads(provider: k8s.Provider): void {
  const opts = { provider };

  const cpNs = new k8s.core.v1.Namespace(
    'ns-tidepool',
    { metadata: { name: 'tidepool', labels: { 'app.kubernetes.io/part-of': 'tidepool' } } },
    opts,
  );
  const workerNs = new k8s.core.v1.Namespace(
    'ns-tidepool-workers',
    {
      metadata: {
        name: 'tidepool-workers',
        labels: { 'app.kubernetes.io/part-of': 'tidepool', trust: 'untrusted' },
      },
    },
    opts,
  );

  // ── Default-deny wall around the untrusted worker namespace ────────────────────
  new k8s.networking.v1.NetworkPolicy(
    'workers-default-deny',
    {
      metadata: { name: 'default-deny-all', namespace: workerNs.metadata.name },
      spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] },
    },
    { ...opts, dependsOn: [workerNs] },
  );

  // Allow ONLY: DNS (to kube-dns) + outbound HTTPS to the INTERNET (git clone /
  // opencode / model APIs). The :443 rule excepts the pod/service/node ranges, so
  // workers cannot reach the apiserver or any in-cluster service. No ingress is
  // ever allowed — workers accept nothing inbound. Spec built by a pure, tested
  // helper (guards.ts) so the excepts are asserted under vitest.
  new k8s.networking.v1.NetworkPolicy(
    'workers-allow-egress',
    {
      metadata: { name: 'allow-dns-and-https-egress', namespace: workerNs.metadata.name },
      // Cast: guards.ts stays @pulumi-free (unit-testable); its shape is asserted in tests.
      spec: buildWorkerEgressPolicySpec(POD_CIDR, SERVICE_CIDR, NODE_SUBNET_CIDR) as unknown as k8s.types.input.networking.v1.NetworkPolicySpec,
    },
    { ...opts, dependsOn: [workerNs] },
  );

  // ── RBAC: reconciler SA (in tidepool) drives Jobs in tidepool-workers ──────────
  const reconcilerSa = new k8s.core.v1.ServiceAccount(
    'sa-control-plane',
    { metadata: { name: 'tidepool-control-plane', namespace: cpNs.metadata.name } },
    { ...opts, dependsOn: [cpNs] },
  );

  // Agent-worker Jobs run as this SA — no API permissions of its own.
  new k8s.core.v1.ServiceAccount(
    'sa-agent-worker',
    { metadata: { name: 'tidepool-agent-worker', namespace: workerNs.metadata.name } },
    { ...opts, dependsOn: [workerNs] },
  );

  const workerRole = new k8s.rbac.v1.Role(
    'role-agent-worker-driver',
    {
      metadata: { name: 'agent-worker-driver', namespace: workerNs.metadata.name },
      rules: [
        { apiGroups: ['batch'], resources: ['jobs'], verbs: ['create', 'get', 'list', 'watch', 'delete'] },
        { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] },
        { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
      ],
    },
    { ...opts, dependsOn: [workerNs] },
  );

  new k8s.rbac.v1.RoleBinding(
    'rb-agent-worker-driver',
    {
      metadata: { name: 'agent-worker-driver', namespace: workerNs.metadata.name },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: workerRole.metadata.name },
      subjects: [
        {
          kind: 'ServiceAccount',
          name: reconcilerSa.metadata.name,
          namespace: cpNs.metadata.name,
        },
      ],
    },
    { ...opts, dependsOn: [workerRole, reconcilerSa] },
  );
}
