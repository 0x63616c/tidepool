# NAMING.md — Tidepool

> How we name **everything** — resources, code, labels. One mechanical standard so names are
> mappable (name = code = docs = infra, 1:1), predictable (you never decide, the pattern tells you),
> and generative (new thing → copy the pattern). Low cognitive load is the point; agents especially
> need a standard they can't misapply. This is ch.1 of the conventions guide; other chapters follow.

## The six rules

1. **One word per concept.** The word never changes; only the *separator* flips per medium —
   kebab for hcloud/k8s/DNS, `UPPER_SNAKE` for env, `camel`/`Pascal` for code. Drift is the *word*
   changing (`cp` vs `control-plane`), never the separator. ✅ `main` ↔ `MAIN` ↔ `Main`.
2. **`tp` = CLI only.** Everything else is `tidepool` or bare. ❌ `tp-main` server, `tp-work-*` Job.
   ✅ `tp ticket ls`.
3. **Scope carries the qualifier.** Bare inside a tidepool-exclusive boundary (the Hetzner project,
   the dedicated cluster); qualify only at *shared* boundaries. ❌ Deployment `tidepool-control-plane`
   inside ns `tidepool`. ✅ Deployment `reconciler`; env `TIDEPOOL_*`; `~/.kube` context `tidepool`.
4. **Symmetry.** Peers carry the identical label schema — all-or-none. ❌ some hcloud resources
   labelled `role=`, peers bare. ✅ every managed resource: `{ managed_by, role }`.
5. **Descriptive beats terse** — spend +1–2 words for intuition, esp. for agents. ❌ `cp`, `password`.
   ✅ `control-plane`, `admin_pg_password`.
6. **Name by layer.** `machine` (nodes) vs `workload` (Jobs) never share a word. A ticket binds at
   the workload, never the machine.

## Layers

| layer | concept | name |
|---|---|---|
| machine | always-on node / burst pool | `main` / `worker-<hash>` |
| workload | agent Jobs (opencode doing a ticket) | ns `agents`, SA `agent`, Job `work-<tckt>-<id>` / `review-<tckt>-<id>`, label `tidepool/role=agent`, kind `work\|review` |
| app | the reconciler Deployment | `reconciler` (never "control-plane" — that word means only k8s's own node role) |
| datastore | Postgres | `pg` in ns `core` |

`run`/`Run`/`run_` is already the **execution-event** noun (observability) — do not reuse it for the
workload; the workload is an `agent`.

## Infra scheme

**Hetzner (bare; labels `{ managed_by: tidepool, role }` on every resource):**

| name | type | role |
|---|---|---|
| `main` | server + primary-ip | `main` |
| `worker-<hash>` | autoscaler node pool `worker` | (nodes) |
| `cluster` | network + firewall | `cluster` |
| `tidepool-pg-backups` | S3 bucket | — (S3 names are **globally unique across all tenants** → stays qualified; and the S3 API takes no hcloud labels) |

**k8s (bare in-cluster; every object gets `app.kubernetes.io/part-of=tidepool` + `tidepool/role`):**

| name | kind | ns |
|---|---|---|
| `core`, `agents` | namespaces | — |
| `reconciler` | Deployment + SA | `core` |
| `pg` | CNPG cluster (DSN `pg-rw.core.svc`) | `core` |
| `agent` | SA; `agent-driver` Role/RoleBinding | `agents` |
| `work-<tckt>-<id>` / `review-<tckt>-<id>` | Jobs | `agents` |

## Kept qualified (shared boundaries — do NOT strip `tidepool`)

- `app.kubernetes.io/part-of=tidepool` — the anchor every object carries
- k8s cluster/context `tidepool` / `admin@tidepool` (lives in shared `~/.kube`)
- Pulumi project/config namespace `tidepool-cluster`; Pulumi state bucket `tidepool-pulumi-state`
- **S3 buckets** (`tidepool-pg-backups`, `tidepool-pulumi-state`) — the S3 name namespace is global
  across every tenant, so bare names collide (`pg-backups` is taken). Buckets always stay qualified.
- ghcr images `tidepool-control-plane`, `tidepool-agent-worker`; `TIDEPOOL_*` env vars; Git User-Agent

## Abbreviation registry (the one place each abbrev is ruled)

✅ `pg`, `id`, `url`, `ci`, `tp` (CLI), `fw` (hcloud firewall suffix) · ❌ `cp` (→ `control-plane`),
`mgmt`, `cfg`, `svc` in our names, `tckt` spelled out in prose (the *id* is `tckt_…`).

## Adding a resource

Pick the layer → take the bare role word → apply the medium's separator → attach the symmetric label
schema. If a name would repeat `tidepool` inside a tidepool-only scope, drop it. If you reach for an
abbreviation, check the registry first.
