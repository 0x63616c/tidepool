import { describe, expect, it } from 'vitest';
import {
  API_PORT,
  API_PORT_NAME,
  buildControlPlaneDeploymentSpec,
  CONTROL_PLANE_SA,
  CONTROL_PLANE_SECRET,
  GITHUB_TOKEN_KEY,
  OPENCODE_FILE,
  OPENCODE_MOUNT_DIR,
  OPENCODE_SECRET_KEY,
  PG_APP_SECRET,
  PG_URL_SECRET_KEY,
  SA_CA_CERT_PATH,
  WORKER_NAMESPACE,
} from './control-plane-deployment';

/**
 * The control-plane Deployment spec is the LIVE FLIP: it flips the singleton
 * reconciler onto Postgres (`TIDEPOOL_DB_DRIVER=pg`) + the k8s agent-worker
 * (`TIDEPOOL_AGENT_WORKER=k8s`). Built by a pure, @pulumi-free function so the
 * whole manifest shape — the singleton guarantee, the env gate, and the
 * secretKeyRef wiring (no plaintext secret in the manifest) — is asserted under
 * the root vitest (tenet 12), exactly like guards.ts.
 */

const IMAGES = {
  controlPlane: 'ghcr.io/0x63616c/tidepool-control-plane@sha256:aaa',
  agentWorker: 'ghcr.io/0x63616c/tidepool-agent-worker@sha256:bbb',
} as const;

const spec = buildControlPlaneDeploymentSpec(IMAGES) as {
  replicas: number;
  strategy: { type: string };
  selector: { matchLabels: Record<string, string> };
  template: {
    metadata: { labels: Record<string, string> };
    spec: {
      serviceAccountName: string;
      containers: Array<{
        image: string;
        env: Array<{
          name: string;
          value?: string;
          valueFrom?: { secretKeyRef?: { name: string; key: string } };
        }>;
        volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
        ports?: Array<{ name: string; containerPort: number }>;
      }>;
      volumes: Array<{
        name: string;
        secret?: { secretName: string; items?: Array<{ key: string; path: string }> };
      }>;
    };
  };
};

const container = spec.template.spec.containers[0]!;
const envOf = (name: string) => container.env.find((e) => e.name === name);

describe('buildControlPlaneDeploymentSpec — singleton reconciler', () => {
  it('runs exactly one replica (single PgMigrator + tenet-3 sole mover)', () => {
    expect(spec.replicas).toBe(1);
  });

  it('uses the Recreate strategy so no two reconcilers ever overlap', () => {
    // RollingUpdate would briefly run two pods → double-dispatch + two migrators.
    expect(spec.strategy.type).toBe('Recreate');
  });

  it('runs as the least-privilege control-plane ServiceAccount', () => {
    expect(spec.template.spec.serviceAccountName).toBe(CONTROL_PLANE_SA);
  });

  it('exposes the queue-control API port for the ClusterIP Service', () => {
    expect(container.ports).toContainEqual({ name: API_PORT_NAME, containerPort: API_PORT });
  });

  it('selector matches the pod template labels (a valid Deployment)', () => {
    expect(spec.selector.matchLabels).toEqual(spec.template.metadata.labels);
  });
});

describe('buildControlPlaneDeploymentSpec — the env flip', () => {
  it('runs the pinned control-plane image', () => {
    expect(container.image).toBe(IMAGES.controlPlane);
  });

  it('selects the Postgres store driver', () => {
    expect(envOf('TIDEPOOL_DB_DRIVER')?.value).toBe('pg');
  });

  it('selects the k8s agent-worker backend', () => {
    expect(envOf('TIDEPOOL_AGENT_WORKER')?.value).toBe('k8s');
  });

  it('passes the pinned agent-worker image the reconciler dispatches', () => {
    expect(envOf('TIDEPOOL_AGENT_WORKER_IMAGE')?.value).toBe(IMAGES.agentWorker);
  });

  it('dispatches worker Jobs into the untrusted worker namespace', () => {
    expect(envOf('TIDEPOOL_WORKER_NAMESPACE')?.value).toBe(WORKER_NAMESPACE);
  });

  it('sets HOME=/root so the broker resolves the opencode auth path', () => {
    expect(envOf('HOME')?.value).toBe('/root');
  });

  it('trusts the cluster CA for apiserver TLS (NODE_EXTRA_CA_CERTS → SA ca.crt)', () => {
    // The reconciler's Bun `fetch` creates worker Jobs over the apiserver's
    // HTTPS, whose cert is signed by the internal cluster CA (not in the default
    // trust store). Without this env the TLS handshake fails and every dispatch
    // errors with a "Transport error" — dispatch silently broke at the pg/k8s
    // cutover until this. NODE_EXTRA_CA_CERTS is read by Bun at startup and adds
    // the auto-mounted SA CA to the trust store.
    expect(envOf('NODE_EXTRA_CA_CERTS')?.value).toBe(SA_CA_CERT_PATH);
  });
});

describe('buildControlPlaneDeploymentSpec — secrets by reference only', () => {
  it('sources TIDEPOOL_PG_URL from the CNPG app secret (never inline)', () => {
    const e = envOf('TIDEPOOL_PG_URL');
    expect(e?.value).toBeUndefined();
    expect(e?.valueFrom?.secretKeyRef).toEqual({ name: PG_APP_SECRET, key: PG_URL_SECRET_KEY });
  });

  it('sources GITHUB_TOKEN from the control-plane secret (never inline)', () => {
    const e = envOf('GITHUB_TOKEN');
    expect(e?.value).toBeUndefined();
    expect(e?.valueFrom?.secretKeyRef).toEqual({
      name: CONTROL_PLANE_SECRET,
      key: GITHUB_TOKEN_KEY,
    });
  });

  it('no env carries a plaintext secret value (every secret is valueFrom)', () => {
    for (const e of container.env) {
      if (e.name === 'TIDEPOOL_PG_URL' || e.name === 'GITHUB_TOKEN') {
        expect(e.value).toBeUndefined();
      }
    }
  });

  it('projects the opencode auth blob to $HOME/.tidepool/bootstrap/opencode-auth.json', () => {
    const mount = container.volumeMounts.find((m) => m.mountPath === OPENCODE_MOUNT_DIR);
    expect(mount).toBeDefined();
    expect(mount?.readOnly).toBe(true);
    const vol = spec.template.spec.volumes.find((v) => v.name === mount?.name);
    expect(vol?.secret?.secretName).toBe(CONTROL_PLANE_SECRET);
    expect(vol?.secret?.items).toContainEqual({ key: OPENCODE_SECRET_KEY, path: OPENCODE_FILE });
    // mountPath + item path must resolve to the broker's hardcoded read path.
    expect(`${OPENCODE_MOUNT_DIR}/${OPENCODE_FILE}`).toBe('/root/.tidepool/bootstrap/opencode-auth.json');
  });
});
