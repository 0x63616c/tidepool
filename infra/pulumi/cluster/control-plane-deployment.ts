/**
 * Pure builder for the control-plane Deployment spec — deliberately free of any
 * `@pulumi/*` import so the manifest shape is unit-tested under the root vitest
 * (tenet 12), exactly like guards.ts. workloads.ts wraps the returned spec in a
 * `k8s.apps.v1.Deployment` and owns the resource metadata (name/namespace).
 *
 * This Deployment IS the live flip (PR-6.5): a SINGLE always-on reconciler pod
 * with the env gate set to Postgres + the k8s agent-worker. It stays a singleton
 * (`replicas: 1` + `Recreate`) because two reconcilers would double-dispatch
 * (tenet 3) and two PgMigrators would race on boot. Secrets enter ONLY by
 * reference (`secretKeyRef` / a projected secret volume) — never inline, so the
 * rendered manifest carries no secret value (tenet 9).
 */

export interface ControlPlaneImages {
  /** Digest-pinned control-plane image (ghcr) the reconciler pod runs. */
  readonly controlPlane: string;
  /** Digest-pinned agent-worker image the reconciler dispatches as Jobs. */
  readonly agentWorker: string;
}

/** ServiceAccount (created in workloads.ts) that grants the Job-driver RBAC. */
export const RECONCILER_SA = 'reconciler';
/** k8s Secret (created in workloads.ts) holding the reconciler's own creds. */
export const RECONCILER_SECRET = 'reconciler-secrets';
/** CNPG auto-generated app secret: `<cluster>-app` for cluster `pg`. */
export const PG_APP_SECRET = 'pg-app';
/** Key in the CNPG app secret holding the full `postgresql://…` DSN. */
export const PG_URL_SECRET_KEY = 'uri';
/** Key in RECONCILER_SECRET holding the GitHub token (forge + git). */
export const GITHUB_TOKEN_KEY = 'GITHUB_TOKEN';
/** Key in RECONCILER_SECRET holding the opencode `auth.json` blob. */
export const OPENCODE_SECRET_KEY = 'opencode';
/** The untrusted namespace the reconciler dispatches agent Jobs into. */
export const AGENT_NAMESPACE = 'agents';
/**
 * k8s auto-mounts the ServiceAccount CA here in every pod. We point Bun's
 * `NODE_EXTRA_CA_CERTS` at it so the reconciler's `fetch` trusts the apiserver
 * cert (signed by the internal cluster CA, absent from the default trust store).
 * Without it every worker-Job dispatch fails apiserver TLS with a "Transport
 * error" — the silent post-cutover bug this closes.
 */
export const SA_CA_CERT_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
/**
 * Mount dir for the opencode blob. LocalCredentialBroker reads a HARDCODED
 * `join(homedir(), '.tidepool/bootstrap/opencode-auth.json')`; with HOME=/root
 * (the base image's user) this dir + OPENCODE_FILE resolve to that exact path.
 */
export const OPENCODE_MOUNT_DIR = '/root/.tidepool/bootstrap';
export const OPENCODE_FILE = 'opencode-auth.json';

const LABELS = {
  'app.kubernetes.io/name': RECONCILER_SA,
  'app.kubernetes.io/part-of': 'tidepool',
  'tidepool/role': 'reconciler',
};
const OPENCODE_VOLUME = 'opencode-auth';

/** Build the `apps/v1` Deployment spec for the control-plane reconciler. */
export function buildControlPlaneDeploymentSpec(images: ControlPlaneImages): Record<string, unknown> {
  return {
    replicas: 1,
    // Recreate (not RollingUpdate): the old pod is fully torn down before the new
    // one starts, so there is never a window with two reconcilers/migrators.
    strategy: { type: 'Recreate' },
    selector: { matchLabels: LABELS },
    template: {
      metadata: { labels: LABELS },
      spec: {
        serviceAccountName: RECONCILER_SA,
        containers: [
          {
            name: 'reconciler',
            image: images.controlPlane,
            // CMD in the image is already `tp run --watch`; leave it.
            env: [
              // ── the flip ──────────────────────────────────────────────────
              { name: 'TIDEPOOL_DB_DRIVER', value: 'pg' },
              {
                name: 'TIDEPOOL_PG_URL',
                valueFrom: { secretKeyRef: { name: PG_APP_SECRET, key: PG_URL_SECRET_KEY } },
              },
              { name: 'TIDEPOOL_AGENT_WORKER', value: 'k8s' },
              { name: 'TIDEPOOL_AGENT_WORKER_IMAGE', value: images.agentWorker },
              { name: 'TIDEPOOL_AGENT_NAMESPACE', value: AGENT_NAMESPACE },
              // ── the reconciler's own creds (by reference only) ────────────
              {
                name: 'GITHUB_TOKEN',
                valueFrom: { secretKeyRef: { name: RECONCILER_SECRET, key: GITHUB_TOKEN_KEY } },
              },
              // HOME anchors the broker's hardcoded opencode-auth read path.
              { name: 'HOME', value: '/root' },
              // Trust the internal cluster CA so the reconciler's fetch can
              // verify the apiserver cert when creating worker Jobs (see
              // SA_CA_CERT_PATH). Read by Bun at startup.
              { name: 'NODE_EXTRA_CA_CERTS', value: SA_CA_CERT_PATH },
            ],
            volumeMounts: [{ name: OPENCODE_VOLUME, mountPath: OPENCODE_MOUNT_DIR, readOnly: true }],
            // CPU request but NO cpu limit (bursty boot/migrate); mem request==limit
            // — the same tenet-6 shape the agent-worker Jobs use.
            resources: {
              requests: { cpu: '250m', memory: '512Mi' },
              limits: { memory: '512Mi' },
            },
          },
        ],
        volumes: [
          {
            name: OPENCODE_VOLUME,
            secret: {
              secretName: RECONCILER_SECRET,
              items: [{ key: OPENCODE_SECRET_KEY, path: OPENCODE_FILE }],
            },
          },
        ],
      },
    },
  };
}
