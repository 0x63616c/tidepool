import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BunRuntime } from '@effect/platform-bun';
import { Cause, Effect, Logger, Schema } from 'effect';
import type { OpencodePort } from './opencode-session.ts';
import { AgentWorkerConfig, ReviewRunnerResult, RunnerResult } from './protocol.ts';
import { bunFormatPort, bunGitPort, makeSdkOpencodePort } from './runner.ts';
import { type FormatPort, type GitPort, makeReviewRunner, makeRunner } from './runner-core.ts';

/**
 * The agent-worker container entrypoint — the ONE image + ONE binary a k8s Job
 * runs. It reads + decodes `config.json`, dispatches on `config.kind`, and writes
 * EXACTLY ONE stdout line: the encoded `RunnerResult` (work) or `ReviewRunnerResult`
 * (review) — the same schema the two runners print today, so `poll` harvests it
 * unchanged (no new result channel). Everything else goes to stderr via the Effect
 * logger, keeping stdout for the one result line.
 *
 * This replaces the two separate box entrypoints (`runner.ts` / `review-runner.ts`,
 * one bundle per kind, uploaded over SSH). Here the kind travels in the config a
 * k8s Job mounts, so the Job selects work-vs-review by data, not by which binary
 * it runs. The clone/session/commit/push logic is unchanged — this only branches
 * over the two existing runner cores.
 */

/** Everything the dispatch needs — injected so the single-line contract is testable. */
export interface AgentWorkerDeps {
  readonly git: GitPort;
  readonly opencode: OpencodePort;
  readonly format: FormatPort;
  readonly ensureDir: (dir: string) => Promise<void>;
  readonly readConfig: () => Promise<string>;
  readonly emit: (line: string) => void;
}

/**
 * Read + decode the config, run the matching core, and emit exactly one encoded
 * result line. Both boundaries go through the `@effect/schema` protocol — never
 * `JSON.parse ... as` — so a config or result drift is a typed decode failure
 * (reported on stderr, non-zero exit) rather than a corrupt run. `work` reuses
 * `makeRunner`, `review` reuses `makeReviewRunner`; neither core is duplicated.
 */
export const makeAgentWorkerProgram = (deps: AgentWorkerDeps): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise(() => deps.readConfig());
      const config = yield* Schema.decode(Schema.parseJson(AgentWorkerConfig))(raw);
      if (config.kind === 'work') {
        const result = yield* makeRunner({
          git: deps.git,
          opencode: deps.opencode,
          format: deps.format,
        })(config);
        const line = yield* Schema.encode(Schema.parseJson(RunnerResult))(result);
        yield* Effect.sync(() => deps.emit(line));
        yield* Effect.logInfo('agent-worker[work] result emitted');
      } else {
        yield* Effect.tryPromise(() => deps.ensureDir(config.dir));
        const result = yield* makeReviewRunner({ opencode: deps.opencode })(config);
        const line = yield* Schema.encode(Schema.parseJson(ReviewRunnerResult))(result);
        yield* Effect.sync(() => deps.emit(line));
        yield* Effect.logInfo('agent-worker[review] result emitted');
      }
    }),
  ).pipe(Effect.orDie);

/** Logger that writes every diagnostic to stderr, keeping stdout for the one result line. */
const stderrLogger = Logger.make(({ logLevel, message }) => {
  process.stderr.write(`[agent-worker] ${logLevel.label} ${String(message)}\n`);
});

/**
 * Copy the credential the Job mounts at `/secrets/auth.json` into opencode's
 * standard path (`~/.local/share/opencode/auth.json`) so the embedded server
 * authenticates — the Proof-B cred handoff. The worker NEVER reads sops: the
 * control plane's `CredentialBroker` resolves creds at dispatch and mounts them
 * as a k8s Secret, so rotation stays a one-module swap. Best-effort + silent on
 * contents: a missing mount logs a warning (the session then fails with a clear
 * opencode error) and we never print the file's bytes.
 */
const provisionOpencodeAuth = async (): Promise<void> => {
  const src = '/secrets/auth.json';
  const destDir = join(homedir(), '.local/share/opencode');
  const dest = join(destDir, 'auth.json');
  try {
    await mkdir(destDir, { recursive: true });
    await copyFile(src, dest);
    process.stderr.write('[agent-worker] INFO provisioned opencode auth from /secrets\n');
  } catch {
    process.stderr.write(
      `[agent-worker] WARN no credential at ${src}; opencode may fail to auth\n`,
    );
  }
};

if (import.meta.main) {
  // The container's bun + opencode global binaries live on the bun global bin
  // (spawned by createOpencodeServer); prepend the standard dirs so the SDK can
  // find them regardless of the non-interactive shell's inherited PATH.
  process.env.PATH = ['/usr/local/bin', `${homedir()}/.bun/bin`, process.env.PATH ?? '']
    .filter((p) => p.length > 0)
    .join(':');
  const program = Effect.gen(function* () {
    yield* Effect.promise(() => provisionOpencodeAuth());
    yield* makeAgentWorkerProgram({
      git: bunGitPort,
      opencode: makeSdkOpencodePort(),
      format: bunFormatPort,
      ensureDir: async (dir) => {
        await mkdir(dir, { recursive: true });
      },
      readConfig: () => readFile('./config.json', 'utf8'),
      emit: (line) => {
        process.stdout.write(`${line}\n`);
      },
    });
  }).pipe(
    // Report any failure to stderr ourselves (stdout is reserved for the result
    // line), then let runMain set the non-zero exit code without re-printing.
    Effect.tapErrorCause((cause) => Effect.logError(Cause.pretty(cause))),
    Effect.provide(Logger.replace(Logger.defaultLogger, stderrLogger)),
  );
  BunRuntime.runMain(program, { disableErrorReporting: true, disablePrettyLogger: true });
}
