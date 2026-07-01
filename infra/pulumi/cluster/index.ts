import * as hcloud from '@pulumi/hcloud';
import { createNetwork } from './network';
import { installPlatform } from './platform';
import { createControlPlane } from './talos';
import { createWorkloads } from './workloads';

/**
 * Tidepool Kubernetes cluster (Talos on Hetzner) — PR-5a.
 *
 * Pipeline: network+firewall → baked Talos snapshot + control-plane node →
 * bootstrap+kubeconfig → CCM/CSI/autoscaler (staggered Helm) → namespaces +
 * NetworkPolicy wall + RBAC. CNPG (datastore) is the PR-5b follow-up.
 *
 * The live `pulumi up` is HUMAN-GATED at PR merge (a GitHub Environment approval);
 * `pulumi preview` creates nothing and needs no live cluster (the k8s provider's
 * kubeconfig is unknown until the cluster exists, so k8s resources preview as
 * dependent creates without connecting).
 */

// Provider: token strictly from the environment (sops-decrypted in CI). A dummy
// value is tolerated at preview (no API calls for creates on an empty state).
const token = process.env.HCLOUD_TOKEN;
if (!token) {
  throw new Error('HCLOUD_TOKEN is required (export it before `pulumi preview`/`up`)');
}
const provider = new hcloud.Provider('hcloud', { token });

const net = createNetwork(provider);
const cp = createControlPlane(provider, net);
const k8sProvider = installPlatform(cp, net);
createWorkloads(k8sProvider);

// ── Outputs ──────────────────────────────────────────────────────────────────────
export const controlPlaneIp = cp.controlPlaneIp;
export const clusterEndpoint = cp.clusterEndpoint;
export const talosImageId = cp.imageId;
export const clusterNetworkId = net.networkId;
// kubeconfig is sensitive — Pulumi masks it in output/state (encrypted by the passphrase).
export const kubeconfig = cp.kubeconfig;
