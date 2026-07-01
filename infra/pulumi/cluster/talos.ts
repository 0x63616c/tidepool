import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as command from '@pulumi/command';
import * as hcloud from '@pulumi/hcloud';
import * as pulumi from '@pulumi/pulumi';
import * as talos from '@pulumiverse/talos';
import {
  CLUSTER_NAME,
  CONTROL_PLANE_TYPE,
  KUBERNETES_VERSION,
  LABELS,
  LOCATION,
  NODE_SUBNET_CIDR,
  POD_CIDR,
  SERVICE_CIDR,
  TALOS_VERSION,
} from './config';
import type { ClusterNetwork } from './network';

/**
 * Talos control plane on Hetzner.
 *
 * Two spike gotchas drive the shape here:
 *   #1  No Talos image-from-URL on Hetzner → we BAKE a snapshot (bake-talos.sh via
 *       a command.local.Command that runs only at `up`) and boot nodes from it.
 *   #2  A Talos machine config pushed over the wire did NOT survive a hard reset →
 *       we SEED the full machine config through hcloud user-data instead, so the
 *       node re-applies it on every boot.
 *
 * The server↔config cycle (config needs the endpoint IP, server needs the config)
 * is broken with a pre-allocated Primary IP whose address is known before the
 * server exists — the same trick the legacy box program uses for its volume.
 */
export interface TalosControlPlane {
  readonly kubeconfig: pulumi.Output<string>;
  readonly clusterEndpoint: pulumi.Output<string>;
  readonly imageId: pulumi.Output<string>;
  readonly node: hcloud.Server;
  readonly controlPlaneIp: pulumi.Output<string>;
  /** Worker machine config → seeded into autoscaler-provisioned nodes as user-data. */
  readonly workerMachineConfig: pulumi.Output<string>;
}

export function createControlPlane(
  provider: hcloud.Provider,
  net: ClusterNetwork,
): TalosControlPlane {
  // ── Baked Talos snapshot (created only at apply) ───────────────────────────────
  const schematicFile = join(__dirname, 'talos-schematic.yaml');
  const schematicHash = createHash('sha256')
    .update(readFileSync(schematicFile))
    .digest('hex');

  const bake = new command.local.Command('talos-image-bake', {
    create: `bash ${join(__dirname, 'bake-talos.sh')}`,
    environment: {
      TALOS_VERSION,
      SCHEMATIC_FILE: schematicFile,
      LOCATION,
      ARCH: 'x86',
    },
    // Rebake only when the schematic or Talos version changes. HCLOUD_TOKEN is
    // inherited from the ambient environment (never embedded here).
    triggers: [schematicHash, TALOS_VERSION],
  });
  // Snapshot id the bake prints on stdout → used as every node's `image`.
  const imageId = bake.stdout.apply((s) => s.trim());

  // ── Primary IP → stable cluster endpoint (breaks the config↔server cycle) ──────
  const cpIp = new hcloud.PrimaryIp(
    'tp-cp-ip',
    {
      name: 'tidepool-cp',
      type: 'ipv4',
      location: LOCATION,
      autoDelete: false,
      labels: LABELS,
    },
    { provider },
  );
  const clusterEndpoint = pulumi.interpolate`https://${cpIp.ipAddress}:6443`;

  // ── Talos machine secrets + control-plane machine config ───────────────────────
  const secrets = new talos.machine.Secrets('talos-secrets', {
    talosVersion: TALOS_VERSION,
  });

  const cpConfig = talos.machine.getConfigurationOutput({
    clusterName: CLUSTER_NAME,
    machineType: 'controlplane',
    clusterEndpoint,
    machineSecrets: secrets.machineSecrets,
    kubernetesVersion: KUBERNETES_VERSION.replace(/^v/, ''),
    talosVersion: TALOS_VERSION,
    configPatches: [
      pulumi.jsonStringify({
        machine: {
          // External cloud provider: the Hetzner CCM owns node lifecycle +
          // routes; kubelet must start with --cloud-provider=external.
          kubelet: {
            extraArgs: { 'cloud-provider': 'external' },
            // Pin the node IP to the private subnet so the CCM can map it
            // (gotcha #3) instead of guessing the public IP.
            nodeIP: { validSubnets: [NODE_SUBNET_CIDR] },
          },
          // Boot device for the baked snapshot.
          install: { disk: '/dev/sda' },
        },
        cluster: {
          allowSchedulingOnControlPlanes: true,
          externalCloudProvider: { enabled: true },
          network: {
            podSubnets: [POD_CIDR],
            serviceSubnets: [SERVICE_CIDR],
          },
          // CCM ships the CNI/routes; disable Talos' default so they don't fight.
          proxy: {},
        },
      }),
    ],
  });

  // ── Control-plane node (boots the snapshot, self-configures from user-data) ────
  const node = new hcloud.Server(
    'tp-cp',
    {
      name: 'tidepool-cp',
      serverType: CONTROL_PLANE_TYPE,
      image: imageId,
      location: LOCATION,
      labels: { ...LABELS, role: 'control-plane' },
      userData: cpConfig.machineConfiguration,
      publicNets: [{ ipv4Enabled: true, ipv4: cpIp.id.apply((id) => Number.parseInt(id, 10)), ipv6Enabled: true }],
      firewallIds: [net.firewall.id.apply((id) => Number.parseInt(id, 10))],
      networks: [
        {
          subnetId: net.subnet.id,
          // Fixed private IP so the endpoint + CCM mapping are deterministic.
          ip: '10.10.0.10',
          // Avoid the known detach/attach-on-every-apply bug (hcloud provider #650).
          aliasIps: [],
        },
      ],
    },
    // The subnet must exist before a server can request a fixed private IP.
    { provider, dependsOn: [net.subnet] },
  );

  // ── Bootstrap etcd once, then pull the kubeconfig ──────────────────────────────
  // Both connect to the node over the network — inert at preview, run at apply.
  const bootstrap = new talos.machine.Bootstrap(
    'talos-bootstrap',
    { node: cpIp.ipAddress, clientConfiguration: secrets.clientConfiguration },
    { dependsOn: [node] },
  );

  const kube = talos.cluster.getKubeconfigOutput(
    { clientConfiguration: secrets.clientConfiguration, node: cpIp.ipAddress },
    { dependsOn: [bootstrap] },
  );

  // ── Worker machine config (autoscaler seeds this as node user-data) ────────────
  // Same secrets + endpoint, machineType=worker. No control-plane/etcd bits.
  const workerConfig = talos.machine.getConfigurationOutput({
    clusterName: CLUSTER_NAME,
    machineType: 'worker',
    clusterEndpoint,
    machineSecrets: secrets.machineSecrets,
    kubernetesVersion: KUBERNETES_VERSION.replace(/^v/, ''),
    talosVersion: TALOS_VERSION,
    configPatches: [
      pulumi.jsonStringify({
        machine: {
          kubelet: {
            extraArgs: { 'cloud-provider': 'external' },
            nodeIP: { validSubnets: [NODE_SUBNET_CIDR] },
          },
          install: { disk: '/dev/sda' },
        },
      }),
    ],
  });

  return {
    kubeconfig: kube.kubeconfigRaw,
    clusterEndpoint,
    imageId,
    node,
    controlPlaneIp: cpIp.ipAddress,
    workerMachineConfig: workerConfig.machineConfiguration,
  };
}
