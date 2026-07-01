import { join } from 'node:path';
import * as aws from '@pulumi/aws';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { CNPG } from './config';

/** Symmetric label schema for every CNPG-owned object (peer with the reconciler). */
const PG_LABELS = { 'app.kubernetes.io/part-of': 'tidepool', 'tidepool/role': 'pg' } as const;

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
  // MIGRATION SAFETY (tckt_bmdbr) — the v2→v1 switch (PR #59) is a Pulumi *rename*, not an
  // in-place edit, and it changes TWO things about every child object's URN
  // (`urn = <parentURN>$<type>::<name>`):
  //   - parent type: `kubernetes:yaml/v2:ConfigFile` → `kubernetes:yaml:ConfigFile`;
  //   - child NAME: v2 auto-prefixes children with the ConfigFile's name +colon
  //     (`barman-cloud-plugin:cnpg-system/barman-cloud`), v1 does NOT
  //     (`cnpg-system/barman-cloud`).
  // With no alias Pulumi sees the new-URN children as fresh CREATEs and the old-URN children
  // as orphaned DELETEs; orphan deletes run *after* creates, so the merge-to-main apply hit
  // the live cluster with "… already exists" on all 16 children (run 28536068245). The k8s
  // provider's own error names the fix: "Renaming a Pulumi resource: use an alias to preserve
  // the identity, or use deleteBeforeReplace if the resource needs replacement." Note
  // `deleteBeforeReplace` ALONE cannot fix this — a pure create (new URN, no identity link)
  // is not a replace, so the flag is a no-op on it. Because BOTH parent-type and name changed,
  // a component-level `type` alias is insufficient (its auto-propagated child alias keeps the
  // new, unprefixed name and so matches nothing — confirmed: preview still showed 17 create /
  // 18 delete). So we alias each child explicitly, in a transformation:
  //   1. `aliases: [{ parent: <old v2 ConfigFile URN>, name: 'barman-cloud-plugin:<v1 name>' }]`
  //      reconstructs each child's exact OLD URN (type inferred from the unchanged current
  //      type). Pulumi finds it in state and ADOPTS the live object in place under the new
  //      v1 parent — no create, no collision. v1's child id is `${ns}/${name}` (namespaced)
  //      or `${name}` (cluster-scoped) — matching CNPG's manifest — and v2's was that same id
  //      with a `barman-cloud-plugin:` prefix.
  //   2. `deleteBeforeReplace = true` on every child is the safety net: the manifest is
  //      byte-identical to what v2 applied, so adoption is a no-op/update, but if a child ever
  //      DID diff to a replacement it deletes-first so it still cannot collide. DB data is
  //      disposable (backups/contents don't matter), so a destructive barman-child replace is
  //      acceptable — the only requirement is a clean gated `pulumi up`.
  // The `objectstores.barmancloud.cnpg.io` CRD is one of these children: adopted in place, so
  // the live `pg-objectstore` CR below is NOT cascade-deleted and the CNPG chain
  // (ObjectStore → Cluster → ScheduledBackup) needs no accompanying change.
  //
  // This is verifiable offline: `pulumi preview` reads real `production` state, so a correct
  // alias shows these children as adopted/updated rather than create+delete.
  const barmanV2ConfigFileUrn = `urn:pulumi:${pulumi.getStack()}::${pulumi.getProject()}::kubernetes:yaml/v2:ConfigFile::barman-cloud-plugin`;
  const barmanPlugin = new k8s.yaml.ConfigFile(
    'barman-cloud-plugin',
    {
      file: join(__dirname, 'manifests', `barman-cloud-plugin-${CNPG.barmanPluginVersion}.yaml`),
      transformations: [
        (obj, childOpts) => {
          const metadata = (obj?.metadata ?? {}) as { name?: string; namespace?: string };
          const v1Name = metadata.namespace
            ? `${metadata.namespace}/${metadata.name}`
            : `${metadata.name}`;
          childOpts.aliases = [
            { parent: barmanV2ConfigFileUrn, name: `barman-cloud-plugin:${v1Name}` },
          ];
          childOpts.deleteBeforeReplace = true;
        },
      ],
    },
    { ...opts, dependsOn: [certManager, cnpgSystemNs] },
  );

  // ── S3 credentials for backups (from the sops-decrypted env at apply) ──────────
  const s3Secret = new k8s.core.v1.Secret(
    'pg-backup-s3',
    {
      metadata: { name: 'pg-backup-s3', namespace: CNPG.namespace, labels: PG_LABELS },
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
      metadata: { name: 'pg-store', namespace: CNPG.namespace, labels: PG_LABELS },
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
      metadata: { name: CNPG.clusterName, namespace: CNPG.namespace, labels: PG_LABELS },
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
      metadata: { name: 'pg-daily', namespace: CNPG.namespace, labels: PG_LABELS },
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
