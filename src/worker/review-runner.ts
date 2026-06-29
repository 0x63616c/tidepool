import { mkdir, readFile } from 'node:fs/promises';
import { BunRuntime } from '@effect/platform-bun';
import { Cause, Effect, Logger, Schema } from 'effect';
import type { OpencodePort } from './opencode-session.ts';
import { ReviewRunnerConfig, ReviewRunnerResult } from './protocol.ts';
import { makeSdkOpencodePort } from './runner.ts';
import { makeReviewRunner } from './runner-core.ts';

/**
 * The review worker entrypoint — `bun run runner.js` on a leased Hetzner box,
 * mirroring the work runner (`runner.ts`) so review runs remotely too (FIX 1):
 * the control box never needs opencode or its auth. It reads + decodes
 * `config.json`, creates the scratch dir, drives one opencode review session,
 * and writes EXACTLY ONE stdout line: the encoded `ReviewRunnerResult`. Progress
 * and errors go to stderr via the Effect logger; the opencode server's scoped
 * finalizer aborts the embedded server + event stream so the process exits on
 * its own (no `process.exit`).
 */

/** Everything `makeReviewProgram` needs — injected so the single-line contract is testable. */
export interface ReviewRunnerDeps {
  readonly opencode: OpencodePort;
  /** Ensure the scratch session dir exists (mkdir -p) before the session runs. */
  readonly ensureDir: (dir: string) => Promise<void>;
  readonly readConfig: () => Promise<string>;
  readonly emit: (line: string) => void;
}

/**
 * Read + decode the config, ensure the scratch dir, run the review core, and emit
 * exactly one encoded `ReviewRunnerResult` line. Both boundaries go through the
 * `@effect/schema` protocol — never `JSON.parse ... as` — so a config or result
 * drift is a typed decode failure (stderr, non-zero exit) rather than a corrupt run.
 */
export const makeReviewProgram = (deps: ReviewRunnerDeps): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise(() => deps.readConfig());
      const config = yield* Schema.decode(Schema.parseJson(ReviewRunnerConfig))(raw);
      yield* Effect.tryPromise(() => deps.ensureDir(config.dir));
      const result = yield* makeReviewRunner({ opencode: deps.opencode })(config);
      const line = yield* Schema.encode(Schema.parseJson(ReviewRunnerResult))(result);
      yield* Effect.sync(() => deps.emit(line));
      yield* Effect.logInfo('review runner result emitted');
    }),
  ).pipe(Effect.orDie);

/** Logger that writes every diagnostic to stderr, keeping stdout for the one result line. */
const stderrLogger = Logger.make(({ logLevel, message }) => {
  process.stderr.write(`[review-runner] ${logLevel.label} ${String(message)}\n`);
});

if (import.meta.main) {
  // The box's opencode + bun binaries are not on the login shell PATH a
  // non-interactive `bun run` inherits; prepend them so the SDK can spawn them.
  process.env.PATH = [
    '/usr/local/bin',
    '/root/.opencode/bin',
    '/root/.bun/bin',
    process.env.PATH ?? '',
  ]
    .filter((p) => p.length > 0)
    .join(':');
  const program = makeReviewProgram({
    opencode: makeSdkOpencodePort(),
    ensureDir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    readConfig: () => readFile('./config.json', 'utf8'),
    emit: (line) => {
      process.stdout.write(`${line}\n`);
    },
  }).pipe(
    Effect.tapErrorCause((cause) => Effect.logError(Cause.pretty(cause))),
    Effect.provide(Logger.replace(Logger.defaultLogger, stderrLogger)),
  );
  BunRuntime.runMain(program, { disableErrorReporting: true, disablePrettyLogger: true });
}
