import { join } from 'node:path';
import * as aws from '@pulumi/aws';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { CNPG } from './config';

/**
 * CloudNativePG datastore (PR-5b).
 *
 * CNPG 1.30 removed the in-tree `barmanObjectStore`, so backups now go through the
 * Barman Cloud PLUGIN, whose webhook needs cert-manager. Install order is a real
 * dependency chain (CRDs must exist before the CRs that use them):
 *
 *   cert-manager ─┐
 *   cnpg-system ns┼─> CNPG operator ──┐          (postgresql.cnpg.io CRDs)
 *                 └─> Barman plugin ──┤          (objectstores.barmancloud.cnpg.io CRD)
 *                          S3 secret ─┼─> ObjectStore ─> Cluster ─> ScheduledBackup
 *
 * PREVIEW NOTE: `pulumi preview` runs fully offline — it never contacts the live
 * apiserver. Helm releases and CRs preview from state; the one manifest that could
 * force a live call, the Barman plugin, uses the classic `k8s.yaml.ConfigFile`
 * (v1), which renders client-side from its compiled-in schema (see below). This
 * matters because the PR preview runner's ephemeral IP is not in the Hetzner
 * firewall allow-list, so any live apiserver reach (e.g. a v2 ConfigFile's OpenAPI
 * schema fetch) would time out.
 */
export function installCnpg(provider: k8s.Provider): void {
  const opts = { provider };

  // ── cert-manager (Barman plugin webhook certs) ─────────────────────────────────
  const certManager = new k8s.helm.v3.Release(
    'cert-manager',
    {
      chart: CNPG.certManager.chart,
      version: CNPG.certManager.version,
      namespace: 'cert-manager',
      createNamespace: true,
      repositoryOpts: { repo: CNPG.certManager.repo },
      values: { crds: { enabled: true } },
    },
    opts,
  );

  const cnpgSystemNs = new k8s.core.v1.Namespace(
    'ns-cnpg-system',
    { metadata: { name: 'cnpg-system', labels: { 'app.kubernetes.io/part-of': 'tidepool' } } },
    opts,
  );

  // ── CNPG operator (postgresql.cnpg.io CRDs + controller) ───────────────────────
  const operator = new k8s.helm.v3.Release(
    'cnpg-operator',
    {
      chart: CNPG.operator.chart,
      version: CNPG.operator.version,
      namespace: cnpgSystemNs.metadata.name,
      repositoryOpts: { repo: CNPG.operator.repo },
      values: {},
    },
    { ...opts, dependsOn: [cnpgSystemNs] },
  );

  // ── Barman Cloud plugin (vendored manifest → objectstores CRD + controller) ────
  // classic ConfigFile (v1), not k8s.yaml.v2: v1 parses the manifest client-side
  // from its compiled-in schema, so preview stays offline. v2 fetches the live
  // cluster's /openapi/v2 to type the manifest — an apiserver call the firewalled
  // preview runner can't make.
  //
  // MIGRATION SAFETY (tckt_bmdbr) — the v2→v1 switch (PR #59) is a Pulumi *rename*,
  // not an in-place edit: the component's type token changes from
  // `kubernetes:yaml/v2:ConfigFile` to `kubernetes:yaml:ConfigFile`, which rewrites the
  // URN of the component AND every child object (a child URN is `<parentURN>$type::name`).
  // With no alias, Pulumi treats each new-URN child as a fresh CREATE and each old-URN
  // child as an orphaned DELETE — and orphan deletes run *after* creates, so the merge-to-
  // main apply hit the live cluster with "… already exists" on all 16 children (run
  // 28536068245). `deleteBeforeReplace` ALONE does not fix this: it only sequences a
  // resource Pulumi already sees as *replacing* one, and a pure create is not a replace, so
  // it is a no-op there. The k8s provider's own error says exactly this: "Renaming a Pulumi
  // resource: use an alias to preserve the identity, or use deleteBeforeReplace if the
  // resource needs replacement." Fix = both halves:
  //   1. `aliases: [{ type: 'kubernetes:yaml/v2:ConfigFile' }]` on the component re-
  //      establishes identity across the rename. Pulumi auto-propagates a parent alias to
  //      every child (children are parented under the ConfigFile), so each child's OLD v2
  //      URN is found in state and the live object is ADOPTED in place — no create, no
  //      collision. The vendored manifest is byte-identical to what v2 applied, so adoption
  //      is a no-op/update, never a replace.
  //   2. The `transformations` hook stamps `deleteBeforeReplace = true` on every child (a
  //      component-level option does NOT propagate to children). Belt-and-suspenders: if a
  //      child's v1-computed inputs ever DO force a replacement, it deletes-first so it still
  //      cannot collide. DB data is disposable (backups/contents don't matter), so a
  //      destructive replace of any barman child is acceptable — the only requirement is a
  //      clean gated `pulumi up`.
  // The `objectstores.barmancloud.cnpg.io` CRD is one of these children: adopted in place by
  // the alias, so the live `pg-objectstore` CR below is NOT cascade-deleted and the CNPG
  // chain (ObjectStore → Cluster → ScheduledBackup) needs no accompanying change.
  const barmanPlugin = new k8s.yaml.ConfigFile(
    'barman-cloud-plugin',
    {
      file: join(__dirname, 'manifests', `barman-cloud-plugin-${CNPG.barmanPluginVersion}.yaml`),
      transformations: [
        (_obj, childOpts) => {
          childOpts.deleteBeforeReplace = true;
        },
      ],
    },
    {
      ...opts,
      dependsOn: [certManager, cnpgSystemNs],
      aliases: [{ type: 'kubernetes:yaml/v2:ConfigFile' }],
    },
  );

  // ── S3 credentials for backups (from the sops-decrypted env at apply) ──────────
  const s3Secret = new k8s.core.v1.Secret(
    'pg-backup-s3',
    {
      metadata: { name: 'tidepool-pg-backup-s3', namespace: CNPG.namespace },
      stringData: {
        access_key_id: process.env.AWS_ACCESS_KEY_ID ?? '',
        secret_access_key: process.env.AWS_SECRET_ACCESS_KEY ?? '',
      },
    },
    opts,
  );

  // ── Backup bucket (Pulumi-managed, declarative — tenet-2, no hand-mutated infra) ─
  // Hetzner Object Storage is S3-compatible; drive it with the aws provider aimed at
  // the Hetzner endpoint (same endpoint + region the Pulumi state backend uses). Creds
  // are read from the ambient AWS_* env at apply — the sops-decrypted pair CI exports —
  // and never passed as inputs, so they never land in state. The skip* flags disable
  // the AWS-only STS / IMDS / account probes that a non-AWS S3 endpoint can't answer.
  const hetznerS3 = new aws.Provider('hetzner-s3', {
    region: CNPG.backupRegion,
    endpoints: [{ s3: CNPG.backupEndpoint }],
    s3UsePathStyle: true,
    skipCredentialsValidation: true,
    skipRequestingAccountId: true,
    skipMetadataApiCheck: true,
    skipRegionValidation: true,
  });

  // retainOnDelete: a `pulumi destroy` must never take the backups with it. Hetzner's
  // Ceph RGW is idempotent on CreateBucket (200 on an already-owned bucket in-region),
  // so a re-apply — or a bucket that happens to pre-exist — adopts rather than errors.
  const backupBucket = new aws.s3.Bucket(
    'pg-backups',
    { bucket: CNPG.backupBucket },
    { provider: hetznerS3, retainOnDelete: true },
  );

  // ── ObjectStore CR → Hetzner S3 bucket ─────────────────────────────────────────
  const objectStore = new k8s.apiextensions.CustomResource(
    'pg-objectstore',
    {
      apiVersion: 'barmancloud.cnpg.io/v1',
      kind: 'ObjectStore',
      metadata: { name: 'tidepool-pg-store', namespace: CNPG.namespace },
      spec: {
        configuration: {
          // Reference the managed bucket's name so the CR depends on it existing.
          destinationPath: pulumi.interpolate`s3://${backupBucket.bucket}/`,
          endpointURL: CNPG.backupEndpoint,
          s3Credentials: {
            accessKeyId: { name: s3Secret.metadata.name, key: 'access_key_id' },
            secretAccessKey: { name: s3Secret.metadata.name, key: 'secret_access_key' },
          },
          wal: { compression: 'gzip' },
          data: { compression: 'gzip' },
        },
        retentionPolicy: CNPG.backupRetention,
      },
    },
    { ...opts, dependsOn: [barmanPlugin, s3Secret, backupBucket] },
  );

  // ── Postgres Cluster (single instance; HA seam one field away) ─────────────────
  const cluster = new k8s.apiextensions.CustomResource(
    'pg-cluster',
    {
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'Cluster',
      metadata: { name: CNPG.clusterName, namespace: CNPG.namespace },
      spec: {
        instances: CNPG.instances,
        storage: { size: CNPG.dataSize, storageClass: CNPG.storageClass },
        walStorage: { size: CNPG.walSize, storageClass: CNPG.storageClass },
        plugins: [
          {
            name: 'barman-cloud.cloudnative-pg.io',
            isWALArchiver: true,
            parameters: { barmanObjectName: objectStore.metadata.name },
          },
        ],
      },
    },
    { ...opts, dependsOn: [operator, objectStore] },
  );

  // ── Daily scheduled backup (30d retention lives on the ObjectStore) ────────────
  new k8s.apiextensions.CustomResource(
    'pg-scheduled-backup',
    {
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'ScheduledBackup',
      metadata: { name: 'tidepool-pg-daily', namespace: CNPG.namespace },
      spec: {
        schedule: CNPG.backupSchedule,
        backupOwnerReference: 'self',
        cluster: { name: cluster.metadata.name },
        method: 'plugin',
        pluginConfiguration: { name: 'barman-cloud.cloudnative-pg.io' },
      },
    },
    { ...opts, dependsOn: [cluster] },
  );
}
