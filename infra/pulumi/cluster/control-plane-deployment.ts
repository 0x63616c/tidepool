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
export const CONTROL_PLANE_SA = 'tidepool-control-plane';
/** k8s Secret (created in workloads.ts) holding the reconciler's own creds. */
export const CONTROL_PLANE_SECRET = 'tidepool-control-plane-secrets';
/** CNPG auto-generated app secret: `<cluster>-app` for cluster `tidepool-pg`. */
export const PG_APP_SECRET = 'tidepool-pg-app';
/** Key in the CNPG app secret holding the full `postgresql://…` DSN. */
export const PG_URL_SECRET_KEY = 'uri';
/** Key in CONTROL_PLANE_SECRET holding the GitHub token (forge + git). */
export const GITHUB_TOKEN_KEY = 'GITHUB_TOKEN';
/** Key in CONTROL_PLANE_SECRET holding the opencode `auth.json` blob. */
export const OPENCODE_SECRET_KEY = 'opencode';
/** The untrusted namespace the reconciler dispatches worker Jobs into. */
export const WORKER_NAMESPACE = 'tidepool-workers';
/**
 * Mount dir for the opencode blob. LocalCredentialBroker reads a HARDCODED
 * `join(homedir(), '.tidepool/bootstrap/opencode-auth.json')`; with HOME=/root
 * (the base image's user) this dir + OPENCODE_FILE resolve to that exact path.
 */
export const OPENCODE_MOUNT_DIR = '/root/.tidepool/bootstrap';
export const OPENCODE_FILE = 'opencode-auth.json';

const LABELS = { 'app.kubernetes.io/name': CONTROL_PLANE_SA, 'app.kubernetes.io/part-of': 'tidepool' };
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
        serviceAccountName: CONTROL_PLANE_SA,
        containers: [
          {
            name: 'control-plane',
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
              { name: 'TIDEPOOL_WORKER_NAMESPACE', value: WORKER_NAMESPACE },
              // ── the reconciler's own creds (by reference only) ────────────
              {
                name: 'GITHUB_TOKEN',
                valueFrom: { secretKeyRef: { name: CONTROL_PLANE_SECRET, key: GITHUB_TOKEN_KEY } },
              },
              // HOME anchors the broker's hardcoded opencode-auth read path.
              { name: 'HOME', value: '/root' },
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
              secretName: CONTROL_PLANE_SECRET,
              items: [{ key: OPENCODE_SECRET_KEY, path: OPENCODE_FILE }],
            },
          },
        ],
      },
    },
  };
}
