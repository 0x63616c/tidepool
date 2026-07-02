import * as k8s from '@pulumi/kubernetes';
import { CNPG, NODE_SUBNET_CIDR, POD_CIDR, SERVICE_CIDR } from './config';
import {
  API_PORT,
  API_PORT_NAME,
  buildControlPlaneDeploymentSpec,
  RECONCILER_SA,
  RECONCILER_SECRET,
  type ControlPlaneImages,
  GITHUB_TOKEN_KEY,
  OPENCODE_SECRET_KEY,
  PG_APP_SECRET,
} from './control-plane-deployment';
import { buildWorkerDriverRules, buildWorkerEgressPolicySpec } from './guards';

// The CNPG-generated app secret the Deployment references (`<cluster>-app`) MUST
// track the cluster cnpg.ts creates — assert it here rather than keep a second
// literal (tenet 1). The pure builder stays @pulumi-free, so the tie lives here.
if (PG_APP_SECRET !== `${CNPG.clusterName}-app`) {
  throw new Error(
    `PG_APP_SECRET (${PG_APP_SECRET}) must equal <cluster>-app for ${CNPG.clusterName}`,
  );
}

/**
 * Namespaces + the security wall (tenet 6/9). The agent-worker namespace is
 * treated as untrusted: default-deny ingress AND egress, then only the minimum
 * egress (cluster DNS + outbound HTTPS) is punched back. The reconciler's
 * ServiceAccount gets least-privilege RBAC — exactly dispatch/poll/cancel/reap on
 * Jobs — and nothing cluster-wide.
 *
 * CNPG's own namespaces (cnpg-system, cert-manager) land in PR-5b.
 */
export function createWorkloads(
  provider: k8s.Provider,
  images: ControlPlaneImages,
  gitSha: string,
): void {
  const opts = { provider };

  const cpNs = new k8s.core.v1.Namespace(
    'ns-core',
    { metadata: { name: 'core', labels: { 'app.kubernetes.io/part-of': 'tidepool' } } },
    opts,
  );
  const workerNs = new k8s.core.v1.Namespace(
    'ns-agents',
    {
      metadata: {
        name: 'agents',
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

  // ── RBAC: reconciler SA (in core) drives Jobs in agents ────────────────────────
  const reconcilerSa = new k8s.core.v1.ServiceAccount(
    'sa-reconciler',
    {
      metadata: {
        name: RECONCILER_SA,
        namespace: cpNs.metadata.name,
        labels: { 'app.kubernetes.io/part-of': 'tidepool', 'tidepool/role': 'reconciler' },
      },
    },
    { ...opts, dependsOn: [cpNs] },
  );

  // Agent Jobs run as this SA — no API permissions of its own.
  new k8s.core.v1.ServiceAccount(
    'sa-agent',
    {
      metadata: {
        name: 'agent',
        namespace: workerNs.metadata.name,
        labels: { 'app.kubernetes.io/part-of': 'tidepool', 'tidepool/role': 'agent' },
      },
    },
    { ...opts, dependsOn: [workerNs] },
  );

  const workerRole = new k8s.rbac.v1.Role(
    'role-agent-driver',
    {
      metadata: { name: 'agent-driver', namespace: workerNs.metadata.name },
      rules: buildWorkerDriverRules() as unknown as k8s.types.input.rbac.v1.PolicyRule[],
    },
    { ...opts, dependsOn: [workerNs] },
  );

  new k8s.rbac.v1.RoleBinding(
    'rb-agent-driver',
    {
      metadata: { name: 'agent-driver', namespace: workerNs.metadata.name },
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

  // ── Control-plane runtime secrets (tenet 9) ──────────────────────────────────────
  // The reconciler's OWN creds: the GitHub token (forge + git push) and the
  // opencode auth blob it injects into worker Jobs. Delivered sops → env in the
  // infra.yml up-job → this k8s Secret (the platform.ts hcloud pattern). Values
  // come from the ambient env at APPLY, never hardcoded and never in git; empty
  // at preview so the plan renders without a live cluster. Requires the `ci` age
  // key to decrypt these two secrets — a human-approved tenet-9 widening (PR-6.5).
  const cpSecret = new k8s.core.v1.Secret(
    'control-plane-secrets',
    {
      metadata: { name: RECONCILER_SECRET, namespace: cpNs.metadata.name },
      stringData: {
        [GITHUB_TOKEN_KEY]: process.env.TIDEPOOL_FORGE_GITHUB_TOKEN ?? '',
        [OPENCODE_SECRET_KEY]: process.env.TIDEPOOL_OPENCODE_AUTH_JSON ?? '',
      },
    },
    { ...opts, dependsOn: [cpNs] },
  );

  // ── THE LIVE FLIP: the singleton reconciler on Postgres + the k8s agent-worker ──
  // Spec built by the pure, unit-tested helper. `replicas:1 + Recreate` keeps it a
  // singleton (tenet 3 + one PgMigrator). It also references the CNPG-managed
  // `pg-app` secret (created by installCnpg); if that isn't present yet
  // the pod simply waits and starts once CNPG creates it — no cross-module
  // dependsOn (createWorkloads doesn't see the cnpg resources).
  new k8s.apps.v1.Deployment(
    'reconciler',
    {
      metadata: {
        name: RECONCILER_SA,
        namespace: cpNs.metadata.name,
        labels: { 'app.kubernetes.io/part-of': 'tidepool', 'tidepool/role': 'reconciler' },
      },
      spec: buildControlPlaneDeploymentSpec(images, gitSha) as unknown as k8s.types.input.apps.v1.DeploymentSpec,
    },
    { ...opts, dependsOn: [cpSecret, reconcilerSa] },
  );

  // ClusterIP (headless-of-public) Service for the queue-control HTTP API. No
  // LoadBalancer, no Ingress — reached only via `kubectl port-forward` through
  // the /32-firewalled apiserver, so the box stays outbound-only (tenet 9).
  new k8s.core.v1.Service(
    'reconciler-api',
    {
      metadata: {
        name: RECONCILER_SA,
        namespace: cpNs.metadata.name,
        labels: { 'app.kubernetes.io/part-of': 'tidepool', 'tidepool/role': 'reconciler' },
      },
      spec: {
        type: 'ClusterIP',
        selector: { 'app.kubernetes.io/name': RECONCILER_SA, 'app.kubernetes.io/part-of': 'tidepool' },
        ports: [{ name: API_PORT_NAME, port: API_PORT, targetPort: API_PORT_NAME }],
      },
    },
    opts,
  );
}
