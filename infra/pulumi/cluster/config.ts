import * as pulumi from '@pulumi/pulumi';
import { pickImage } from './guards';

/**
 * Single source of the cluster's pinned versions, machine sizes, and CIDRs
 * (tenet 1: one place per datum). Everything here is DECLARED INTENT — the real
 * `pulumi up` is human-gated (PR merge), so versions can be bumped in one edit and
 * re-reviewed. Sizes/location are `pulumi config` so the capacity-fallback chain
 * can retype nodes without touching code (mirrors the legacy box program).
 */

const cfg = new pulumi.Config('tidepool-cluster');

// ── Placement ──────────────────────────────────────────────────────────────────
export const LOCATION = cfg.get('location') ?? 'nbg1';
/** Hetzner network zone that `LOCATION` belongs to (CCM route-controller needs it). */
export const NETWORK_ZONE = cfg.get('networkZone') ?? 'eu-central';

// ── Node shapes ──────────────────────────────────────────────────────────────────
// cpx32 = 4 vCPU / 8GB shared AMD — the spike's proven size; control plane and
// worker pool both use it (workers repack to cpx42 later to amortise cold-start).
export const CONTROL_PLANE_TYPE = cfg.get('controlPlaneType') ?? 'cpx32';
export const WORKER_TYPE = cfg.get('workerType') ?? 'cpx32';
// DEFERRED: capacity-fallback node groups (cpx32→cpx42, nbg1→hel1) for when a type
// or location is sold out — a follow-up once the single-pool cluster is proven.
/** Autoscaler worker pool bounds. min=0 is the whole point (scale-to-zero, tenet 7). */
export const WORKER_MIN = cfg.getNumber('workerMin') ?? 0;
export const WORKER_MAX = cfg.getNumber('workerMax') ?? 3;

// ── Networking (dedicated cluster network; no overlap across the three CIDRs) ─────
// A cluster-owned network keeps CIDR ownership clean for the CCM route-controller
// and avoids collisions with the retiring imperative worker fleet's network.
export const NETWORK_CIDR = '10.10.0.0/16';
export const NODE_SUBNET_CIDR = '10.10.0.0/24';
export const POD_CIDR = '10.244.0.0/16';
export const SERVICE_CIDR = '10.96.0.0/12';

// ── Admin allow-list (Talos apid 50000 + kube-apiserver 6443) ────────────────────
// Locked to the operator /32(s) — tenet 9 (no broad public inbound). Comma-list via
// config; defaults to "everywhere" ONLY so a first preview renders — a real apply
// MUST set `pulumi config set tidepool-cluster:adminCidrs <ip>/32`.
export const ADMIN_CIDRS = (cfg.get('adminCidrs') ?? '0.0.0.0/0')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// CI apiserver reachability (#4): the up-job passes ITS ephemeral runner /32 here,
// so the firewall opens 6443+50000 to it THROUGH pulumi (managed state, no
// out-of-band drift) — access exists the instant the firewall is created, which is
// before Talos bootstrap (:50000) + Helm/CR apply (:6443) need it. Empty at preview
// and on operator-run applies. `adminCidrs` stays operator-only + fail-closed;
// residual: one ephemeral runner /32 lingers in state until the next apply
// overwrites it with the new runner IP (self-healing, GitHub-owned, cert-gated).
export const CI_RUNNER_CIDR = process.env.TIDEPOOL_CI_RUNNER_CIDR?.trim() || undefined;

// ── Versions (pinned to the SPIKE-PROVEN set — tenet 8, proven not guessed) ──────
export const TALOS_VERSION = cfg.get('talosVersion') ?? 'v1.13.5';
export const KUBERNETES_VERSION = cfg.get('kubernetesVersion') ?? 'v1.33.1';

/** Helm charts. Repo URLs + versions pinned; bumpable at the gated apply. */
export const CHARTS = {
  ccm: {
    repo: 'https://charts.hetzner.cloud',
    chart: 'hcloud-cloud-controller-manager',
    version: '1.33.0',
  },
  csi: {
    repo: 'https://charts.hetzner.cloud',
    chart: 'hcloud-csi',
    version: '2.21.2',
  },
  autoscaler: {
    repo: 'https://kubernetes.github.io/autoscaler',
    chart: 'cluster-autoscaler',
    version: '9.46.0',
    // Autoscaler image the spike proved registers the hetzner cloudprovider +
    // honours min=0.
    imageTag: 'v1.32.1',
  },
} as const;

export const CLUSTER_NAME = 'tidepool';

// ── Application images (digest-pinned; PR-6.5 control-plane Deployment) ───────────
// The ghcr refs the control-plane Deployment runs + dispatches as agent-worker
// Jobs. `require` (not `get`) so a real apply FAILS CLOSED on an unpinned image —
// set both to an immutable `@sha256:<digest>` in Pulumi.production.yaml, never a
// mutable tag (reproducible rollout, tenet 8). Bumped deliberately per release.
// Auto-deploy (merge→prod): the up-job resolves the current commit's freshly-built
// image to a digest and exports it as TIDEPOOL_DEPLOY_*_IMAGE; that override wins
// over the git-pinned default so a merge rerolls with its own build. Local `pulumi
// up` (no env) uses the committed pin. pickImage fails closed on a mutable tag.
export const CONTROL_PLANE_IMAGE = pickImage(
  process.env.TIDEPOOL_DEPLOY_CONTROL_PLANE_IMAGE,
  cfg.require('controlPlaneImage'),
);
export const AGENT_WORKER_IMAGE = pickImage(
  process.env.TIDEPOOL_DEPLOY_AGENT_WORKER_IMAGE,
  cfg.require('agentWorkerImage'),
);

// ── Datastore: CloudNativePG (PR-5b) ─────────────────────────────────────────────
// CNPG 1.30 dropped the native barmanObjectStore → the Barman Cloud PLUGIN is
// mandatory, and the plugin's webhook needs cert-manager. Versions pinned; the
// plugin manifest is vendored under manifests/ (offline + deterministic preview).
export const CNPG = {
  certManager: { repo: 'https://charts.jetstack.io', chart: 'cert-manager', version: 'v1.20.3' },
  operator: {
    repo: 'https://cloudnative-pg.github.io/charts',
    chart: 'cloudnative-pg',
    version: '0.29.0',
  },
  barmanPluginVersion: 'v0.13.0', // → manifests/barman-cloud-plugin-<ver>.yaml
  // Postgres cluster.
  clusterName: 'pg', // → DSN host `pg-rw.core.svc:5432`
  namespace: 'core', // co-located with the reconciler (created in 5a)
  instances: 1, // HA seam: bump to 3 for sync replicas, no schema change
  storageClass: 'hcloud-volumes',
  dataSize: '10Gi',
  walSize: '10Gi',
  // Backups → Hetzner Object Storage (S3). The bucket is Pulumi-managed (declarative,
  // tenet-2) via an aws.Provider pointed at the Hetzner S3 endpoint — same endpoint +
  // sops-decrypted creds the Pulumi state backend already uses. Creds come from the
  // ambient AWS_* env at apply (never hardcoded / never in state). Hetzner project S3
  // keys can create buckets via the S3 API (`aws s3 mb`), so no human pre-create.
  backupBucket: 'pg-backups',
  backupEndpoint: 'https://nbg1.your-objectstorage.com',
  backupRegion: 'nbg1', // Hetzner Object Storage region (Nuremberg); == state-backend region
  backupSchedule: '0 0 3 * * *', // CNPG 6-field cron: 03:00 daily
  backupRetention: '30d',
} as const;

/**
 * Base Hetzner label every managed resource carries (greppable + reap-safe).
 * Each resource spreads this and adds its own `role` so the label schema is
 * symmetric across peers — `{ managed_by, role }` on all of them, never some.
 */
export const LABELS = { managed_by: 'tidepool' } as const;
