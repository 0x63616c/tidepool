import { readFile } from 'node:fs/promises';
import { BunRuntime } from '@effect/platform-bun';
import { createOpencodeClient, createOpencodeServer } from '@opencode-ai/sdk';
import { $ } from 'bun';
import { Cause, Effect, Logger, Schema } from 'effect';
import type { OpencodePort } from './opencode-session.ts';
import { RunnerConfig, RunnerResult } from './protocol.ts';
import { type FormatPort, type GitPort, makeRunner } from './runner-core.ts';

/**
 * The worker entrypoint — `bun run runner.js` on the Hetzner box. This is the
 * real-adapter end of every port the runner core speaks to: git over Bun's `$`,
 * opencode over `@opencode-ai/sdk`. It reads + decodes `config.json`, runs the
 * core under a scope, and writes EXACTLY ONE stdout line: the encoded
 * `RunnerResult`. Everything else (progress, errors) goes to stderr via the
 * Effect logger. There is deliberately no `process.exit` — `BunRuntime.runMain`
 * tears the runtime down, and the opencode server's scoped finalizer aborts the
 * embedded server + its event stream, so the process exits cleanly on its own
 * (the old stringified runner needed `process.exit(0)` to escape a hang because
 * nothing aborted the open SSE subscription; the finalizer now does).
 */

/** Git over Bun's `$`. The shell is the implementation detail behind `GitPort`. */
export const bunGitPort: GitPort = {
  clone: async ({ cloneUrl, base, dir }) => {
    await $`git clone --depth 1 --branch ${base} ${cloneUrl} ${dir}`.quiet();
  },
  checkoutBranch: async (dir, branch) => {
    await $`git -C ${dir} checkout -b ${branch}`.quiet();
  },
  configUser: async (dir) => {
    await $`git -C ${dir} config user.email agent@tidepool.local`.quiet();
    await $`git -C ${dir} config user.name tidepool-agent`.quiet();
  },
  statusPorcelain: (dir) => $`git -C ${dir} status --porcelain`.text(),
  addAll: async (dir) => {
    await $`git -C ${dir} add -A`.quiet();
  },
  commit: async (dir, message) => {
    await $`git -C ${dir} commit -m ${message}`.quiet();
  },
  headSha: (dir) => $`git -C ${dir} rev-parse HEAD`.text(),
  push: async (dir, branch) => {
    await $`git -C ${dir} push -u origin ${branch}`.quiet();
  },
};

/**
 * The pre-commit formatter over Bun's `$`. Reads the clone's package.json to see
 * whether it ships a `format` script, and runs each pre-commit command in the
 * clone. A non-zero exit becomes a typed `FormatFailed`, which `makeRunner`
 * treats as best-effort: it logs and commits anyway (formatting helps CI pass,
 * it is not a gate). Commands are run raw so a multi-token command line (`bunx
 * biome format --write .`) executes as written, not as one quoted argument.
 */
export const bunFormatPort: FormatPort = {
  hasFormatScript: async (dir) => {
    try {
      const pkg = JSON.parse(await readFile(`${dir}/package.json`, 'utf8')) as {
        scripts?: Record<string, unknown>;
      };
      return typeof pkg.scripts?.format === 'string';
    } catch {
      return false;
    }
  },
  run: async (dir, command) => {
    await $`${{ raw: command }}`.cwd(dir).quiet();
  },
};

/** Split a `provider/model` config string into the SDK's `{providerID, modelID}`. */
const splitModel = (model: string): { providerID: string; modelID: string } => {
  const i = model.indexOf('/');
  return i < 0
    ? { providerID: 'openai', modelID: model }
    : { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
};

/**
 * opencode over the SDK. One server + client per run, owned by a single
 * `AbortController` so `stopServer` (the scoped finalizer) aborts BOTH the
 * embedded server and the open event subscription — the latter is what lets the
 * process exit without `process.exit`.
 */
export const makeSdkOpencodePort = (): OpencodePort => {
  const controller = new AbortController();
  let live:
    | {
        readonly server: { close: () => void };
        readonly client: ReturnType<typeof createOpencodeClient>;
      }
    | undefined;
  const required = () => {
    if (live === undefined) throw new Error('opencode server not started');
    return live;
  };
  return {
    startServer: async () => {
      const server = await createOpencodeServer({
        hostname: '127.0.0.1',
        port: 0,
        timeout: 30_000,
        signal: controller.signal,
      });
      const client = createOpencodeClient({ baseUrl: server.url });
      live = { server, client };
      return { url: server.url };
    },
    stopServer: () => {
      // Abort first (unblocks the SSE subscription's pending read), then close
      // the server + its child process. Together these drain the event loop.
      controller.abort();
      live?.server.close();
    },
    createSession: async (_server, dir) => {
      const created = await required().client.session.create({ query: { directory: dir } });
      const id = created.data?.id;
      if (id === undefined)
        throw new Error(`session.create failed: ${JSON.stringify(created.error)}`);
      return id;
    },
    subscribeEvents: async function* (_server, _dir) {
      const sub = await required().client.event.subscribe({ signal: controller.signal });
      yield* sub.stream;
    },
    prompt: async (_server, { sessionId, dir, model, prompt }) => {
      const { providerID, modelID } = splitModel(model);
      const res = await required().client.session.prompt({
        path: { id: sessionId },
        query: { directory: dir },
        body: { model: { providerID, modelID }, parts: [{ type: 'text', text: prompt }] },
      });
      const info = res.data?.info;
      if (info === undefined)
        throw new Error(`session.prompt failed: ${JSON.stringify(res.error)}`);
      const parts = res.data?.parts ?? [];
      const text = parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
      return { info, text };
    },
  };
};

/** Everything `makeProgram` needs — injected so the single-line contract is testable. */
export interface RunnerDeps {
  readonly git: GitPort;
  readonly opencode: OpencodePort;
  readonly format: FormatPort;
  readonly readConfig: () => Promise<string>;
  readonly emit: (line: string) => void;
}

/**
 * Read + decode the config, run the core, and emit exactly one encoded
 * `RunnerResult` line. Both boundaries go through the `@effect/schema` protocol
 * — never `JSON.parse ... as` — so a config or result drift is a typed decode
 * failure (reported on stderr, non-zero exit) rather than a corrupt run.
 */
export const makeProgram = (deps: RunnerDeps): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise(() => deps.readConfig());
      const config = yield* Schema.decode(Schema.parseJson(RunnerConfig))(raw);
      yield* Effect.logInfo('runner starting').pipe(
        Effect.annotateLogs({ model: config.model, branch: config.branch }),
      );
      const result = yield* makeRunner({
        git: deps.git,
        opencode: deps.opencode,
        format: deps.format,
      })(config);
      const line = yield* Schema.encode(Schema.parseJson(RunnerResult))(result);
      yield* Effect.sync(() => deps.emit(line));
      yield* Effect.logInfo('runner result emitted');
    }),
  ).pipe(Effect.orDie);

/** Logger that writes every diagnostic to stderr, keeping stdout for the one result line. */
const stderrLogger = Logger.make(({ logLevel, message }) => {
  process.stderr.write(`[runner] ${logLevel.label} ${String(message)}\n`);
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
  const program = makeProgram({
    git: bunGitPort,
    opencode: makeSdkOpencodePort(),
    format: bunFormatPort,
    readConfig: () => readFile('./config.json', 'utf8'),
    emit: (line) => {
      process.stdout.write(`${line}\n`);
    },
  }).pipe(
    // Report any failure to stderr ourselves (stdout is reserved for the result
    // line), then let runMain set the non-zero exit code without re-printing.
    Effect.tapErrorCause((cause) => Effect.logError(Cause.pretty(cause))),
    Effect.provide(Logger.replace(Logger.defaultLogger, stderrLogger)),
  );
  // disablePrettyLogger: don't let runMain add a stdout pretty logger (stdout is
  // the result line only); disableErrorReporting: we already log via tapErrorCause.
  BunRuntime.runMain(program, { disableErrorReporting: true, disablePrettyLogger: true });
}
