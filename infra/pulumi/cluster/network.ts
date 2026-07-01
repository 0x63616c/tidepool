import * as hcloud from '@pulumi/hcloud';
import type * as pulumi from '@pulumi/pulumi';
import {
  ADMIN_CIDRS,
  CI_RUNNER_CIDR,
  LABELS,
  NETWORK_CIDR,
  NETWORK_ZONE,
  NODE_SUBNET_CIDR,
  POD_CIDR,
} from './config';
import { controlPortSourceCidrs } from './guards';

/**
 * Dedicated cluster network + firewall.
 *
 * Gotcha #3 (spike): the Hetzner CCM REJECTS a node whose private IP it can't map
 * to a known network + subnet, so the cluster must own a real hcloud network and
 * every node must be attached to it (done in talos.ts). We give the CCM this
 * network's id so its route-controller can program pod routes across nodes.
 */
export interface ClusterNetwork {
  readonly network: hcloud.Network;
  readonly subnet: hcloud.NetworkSubnet;
  readonly firewall: hcloud.Firewall;
  readonly networkId: pulumi.Output<number>;
}

export function createNetwork(provider: hcloud.Provider): ClusterNetwork {
  const network = new hcloud.Network(
    'tidepool-cluster-net',
    { name: 'tidepool-cluster', ipRange: NETWORK_CIDR, labels: LABELS },
    { provider },
  );

  // Node subnet. The CCM's route-controller adds the pod-CIDR routes on top; the
  // subnet range and POD_CIDR are deliberately disjoint (see config.ts).
  const subnet = new hcloud.NetworkSubnet(
    'tidepool-cluster-subnet',
    {
      networkId: network.id.apply((id) => Number.parseInt(id, 10)),
      type: 'cloud',
      networkZone: NETWORK_ZONE,
      ipRange: NODE_SUBNET_CIDR,
    },
    { provider },
  );

  // Firewall (tenet 9: no broad public inbound). Hetzner firewalls are inbound
  // allow-lists — unmatched inbound is dropped, outbound stays open.
  //   - 6443  kube-apiserver   → admin /32(s) + (during CI apply) the runner /32
  //   - 50000 Talos apid       → admin /32(s) + (during CI apply) the runner /32
  //   - intra-network traffic  → open within NETWORK_CIDR (node<->node, kubelet,
  //                              etcd, CNI) and from the pod CIDR.
  const controlPortSources = controlPortSourceCidrs(ADMIN_CIDRS, CI_RUNNER_CIDR);
  const firewall = new hcloud.Firewall(
    'tidepool-cluster-fw',
    {
      name: 'tidepool-cluster',
      labels: LABELS,
      rules: [
        {
          direction: 'in',
          protocol: 'tcp',
          port: '6443',
          sourceIps: controlPortSources,
          description: 'kube-apiserver (admin + CI-apply runner)',
        },
        {
          direction: 'in',
          protocol: 'tcp',
          port: '50000',
          sourceIps: controlPortSources,
          description: 'Talos apid (admin + CI-apply runner)',
        },
        {
          direction: 'in',
          protocol: 'tcp',
          port: 'any',
          sourceIps: [NETWORK_CIDR, POD_CIDR],
          description: 'intra-cluster tcp (nodes + pods)',
        },
        {
          direction: 'in',
          protocol: 'udp',
          port: 'any',
          sourceIps: [NETWORK_CIDR, POD_CIDR],
          description: 'intra-cluster udp (CNI/DNS)',
        },
      ],
    },
    { provider },
  );

  return {
    network,
    subnet,
    firewall,
    networkId: network.id.apply((id) => Number.parseInt(id, 10)),
  };
}
