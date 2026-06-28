import { Schema } from 'effect';
import { Usage } from '../domain.ts';

/**
 * The runner wire protocol — the only contract crossing the orchestrator↔box
 * seam. The orchestrator encodes a `RunnerConfig` into config.json and uploads
 * it; the bun-built runner decodes it, does the work, and emits exactly one
 * stdout line which the orchestrator decodes as a `RunnerResult`. Both ends go
 * through these `@effect/schema` types (reusing the domain `Usage`), so a drift
 * in either direction is a typed decode failure at the boundary, never a silent
 * `JSON.parse ... as` mismatch.
 */

/** Everything the runner needs to clone, drive an agent session, and push. */
export const RunnerConfig = Schema.Struct({
  /** Authenticated clone URL (`https://x-access-token:<tok>@github.com/o/r.git`). */
  cloneUrl: Schema.String,
  /** Base branch to clone + branch off (e.g. `main`). */
  base: Schema.String,
  /** New work branch to create and push. */
  branch: Schema.String,
  /** Working directory the runner clones into on the box. */
  dir: Schema.String,
  /** `provider/model` string for the agent session. */
  model: Schema.String,
  /** Full work-agent prompt. */
  prompt: Schema.String,
  /** Commit subject the runner uses after the agent edits files. */
  commitMsg: Schema.String,
});
export type RunnerConfig = typeof RunnerConfig.Type;

/** The single machine-readable line the runner writes to stdout on success. */
export const RunnerResult = Schema.Struct({
  commitSha: Schema.String,
  usage: Usage,
});
export type RunnerResult = typeof RunnerResult.Type;
