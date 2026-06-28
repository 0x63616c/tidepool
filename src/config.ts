import { Context, Effect, Schema } from 'effect';

/**
 * Declarative config — typed, validated with `effect/Schema`, lives in git
 * (`tidepool.config.ts`), changed via PR. Holds NO secrets and NO runtime state
 * (tenet 1: one datum, one store).
 */

export const ModelTier = Schema.Struct({
  work: Schema.String,
  review: Schema.String,
});
export type ModelTier = typeof ModelTier.Type;

export const Target = Schema.Struct({
  repo: Schema.String,
  base: Schema.optionalWith(Schema.String, { default: () => 'main' }),
  /** Per-target model override (cheap for testbed, strong for real repos). */
  models: Schema.optional(ModelTier),
});
export type Target = typeof Target.Type;

export const Workers = Schema.Struct({
  /** The single concurrency knob (design-for-N, run N=1). */
  max: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  idleTimeoutSec: Schema.Int.pipe(Schema.greaterThan(0)),
  maxTtlSec: Schema.Int.pipe(Schema.greaterThan(0)),
});
export type Workers = typeof Workers.Type;

export const BoxConfig = Schema.Struct({
  type: Schema.String,
  /** Fallback order on `resource_unavailable` (capacity will bite if hardcoded). */
  locations: Schema.NonEmptyArray(Schema.String),
  /**
   * Optional prebaked worker image — a Hetzner image name or snapshot id. When
   * omitted, workers boot stock `ubuntu-24.04` and run the full bake.sh recipe
   * via cloud-init (today's behavior). A later PR sets this to the snapshot id.
   */
  imageId: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
});
export type BoxConfig = typeof BoxConfig.Type;

export const StateConfig = Schema.Struct({
  /**
   * Hetzner Volume id holding the control-plane sqlite (management state). It is
   * declarative infra identity (PR-reviewed, GitOps), NOT runtime state — like
   * the SSH-key/network ids. Bound by a later PR once the management box exists;
   * the volume is what makes the db survive a box rebuild.
   */
  volumeId: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
});
export type StateConfig = typeof StateConfig.Type;

export const Config = Schema.Struct({
  targets: Schema.NonEmptyArray(Target),
  models: ModelTier,
  workers: Workers,
  box: BoxConfig,
  /** Optional management-state binding; undefined until the management box exists. */
  state: Schema.optional(StateConfig),
  /** Max work attempts before a ticket goes `failed`. */
  retries: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
});
export type Config = typeof Config.Type;

const decode = Schema.decodeUnknownSync(Config);

/** Validate a config literal at load time. Throws (fail-fast) on a bad config. */
export const defineConfig = (input: unknown): Config => decode(input);

/** Resolve the effective models for a target (target override ?? global). */
export const modelsFor = (config: Config, repo: string): ModelTier => {
  const target = config.targets.find((t) => t.repo === repo);
  return target?.models ?? config.models;
};

/** Resolve the base branch for a target (default `main`). */
export const baseFor = (config: Config, repo: string): string => {
  const target = config.targets.find((t) => t.repo === repo);
  return target?.base ?? 'main';
};

/** The loaded config, provided as a service so the reconciler reads it via DI. */
export class AppConfig extends Context.Tag('AppConfig')<AppConfig, Config>() {}

export const loadConfig = (importer: () => Promise<{ default: Config }>): Effect.Effect<Config> =>
  Effect.promise(importer).pipe(Effect.map((m) => m.default));
