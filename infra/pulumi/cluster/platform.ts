import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { CHARTS, POD_CIDR, WORKER_MAX, WORKER_MIN, WORKER_TYPE, LOCATION } from './config';
import type { ClusterNetwork } from './network';
import type { TalosControlPlane } from './talos';

/**
 * Cluster platform: the Hetzner CCM, CSI driver, and cluster-autoscaler — all via
 * Helm, on the k8s provider built from the Talos-derived kubeconfig.
 *
 * PREVIEW SAFETY: the kubeconfig is an Output that is UNKNOWN until the cluster is
 * actually created, so at `pulumi preview` this provider never connects to an API
 * server — every resource below previews as a dependent create. That is what lets
 * `pulumi preview` succeed with NO live cluster.
 *
 * ORDERING (gotcha #5): a single node wedged its whole network under concurrent
 * CCM+CSI Helm churn. So the installs are SERIALISED: CCM → CSI → autoscaler, each
 * `dependsOn` the previous, never applied in parallel.
 */
export function installPlatform(cp: TalosControlPlane, net: ClusterNetwork): k8s.Provider {
  const provider = new k8s.Provider('k8s', { kubeconfig: cp.kubeconfig });
  const opts = { provider };

  // The hcloud token every platform component reads. Sourced from the ambient
  // (sops-decrypted, in CI) env at apply; flows into Pulumi state encrypted by the
  // stack passphrase. Chart convention: secret `hcloud`, key `token`.
  const token = process.env.HCLOUD_TOKEN ?? '';
  const hcloudSecret = new k8s.core.v1.Secret(
    'hcloud',
    {
      metadata: { name: 'hcloud', namespace: 'kube-system' },
      stringData: { token, network: net.networkId.apply(String) },
    },
    opts,
  );

  // ── 1) CCM — owns node lifecycle + pod routes over the private network ─────────
  const ccm = new k8s.helm.v3.Release(
    'ccm',
    {
      chart: CHARTS.ccm.chart,
      version: CHARTS.ccm.version,
      namespace: 'kube-system',
      repositoryOpts: { repo: CHARTS.ccm.repo },
      values: {
        networking: { enabled: true, clusterCIDR: POD_CIDR },
        env: { HCLOUD_NETWORK: { valueFrom: { secretKeyRef: { name: 'hcloud', key: 'network' } } } },
      },
    },
    { ...opts, dependsOn: [hcloudSecret] },
  );

  // ── 2) CSI — PVCs on hcloud-volumes (CNPG data/WAL land here in PR-5b) ──────────
  const csi = new k8s.helm.v3.Release(
    'csi',
    {
      chart: CHARTS.csi.chart,
      version: CHARTS.csi.version,
      namespace: 'kube-system',
      repositoryOpts: { repo: CHARTS.csi.repo },
      values: {},
    },
    { ...opts, dependsOn: [ccm] },
  );

  // ── 3) cluster-autoscaler — hetzner cloudprovider, worker pool min=0 ───────────
  // Worker nodes boot the same baked snapshot + the worker machine config (base64
  // user-data), attach to the cluster network + firewall (gotcha #2/#3 carried to
  // autoscaler-born nodes).
  const cloudInitB64 = cp.workerMachineConfig.apply((c) => Buffer.from(c).toString('base64'));
  new k8s.helm.v3.Release(
    'autoscaler',
    {
      chart: CHARTS.autoscaler.chart,
      version: CHARTS.autoscaler.version,
      namespace: 'kube-system',
      repositoryOpts: { repo: CHARTS.autoscaler.repo },
      values: {
        cloudProvider: 'hetzner',
        image: { tag: CHARTS.autoscaler.imageTag },
        autoscalingGroups: [
          {
            name: 'tidepool-workers',
            minSize: WORKER_MIN,
            maxSize: WORKER_MAX,
            instanceType: WORKER_TYPE,
            region: LOCATION,
          },
        ],
        extraEnv: {
          HCLOUD_IMAGE: cp.imageId,
          HCLOUD_CLOUD_INIT: cloudInitB64,
          HCLOUD_NETWORK: net.networkId.apply(String),
          HCLOUD_FIREWALL: net.firewall.id.apply(String),
        },
        extraEnvSecrets: {
          HCLOUD_TOKEN: { name: 'hcloud', key: 'token' },
        },
      },
    },
    { ...opts, dependsOn: [csi] },
  );

  return provider;
}
