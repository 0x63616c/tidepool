import * as pulumi from '@pulumi/pulumi';

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

// ── Versions (pinned) ────────────────────────────────────────────────────────────
export const TALOS_VERSION = cfg.get('talosVersion') ?? 'v1.9.2';
export const KUBERNETES_VERSION = cfg.get('kubernetesVersion') ?? 'v1.32.2';

/** Helm charts. Repo URLs + versions pinned; bumpable at the gated apply. */
export const CHARTS = {
  ccm: {
    repo: 'https://charts.hetzner.cloud',
    chart: 'hcloud-cloud-controller-manager',
    version: '1.24.0',
  },
  csi: {
    repo: 'https://charts.hetzner.cloud',
    chart: 'hcloud-csi',
    version: '2.13.0',
  },
  autoscaler: {
    repo: 'https://kubernetes.github.io/autoscaler',
    chart: 'cluster-autoscaler',
    version: '9.46.0',
    // Autoscaler image must be >= the min the spike proved (v1.32.x registers the
    // hetzner cloudprovider + honours min=0).
    imageTag: 'v1.32.0',
  },
} as const;

export const CLUSTER_NAME = 'tidepool';

/** Common Hetzner labels so every resource is greppable + reap-safe. */
export const LABELS = { managed_by: 'tidepool', component: 'cluster' } as const;
