import { Data, Effect } from 'effect';
import { type OpencodeFailed, type OpencodePort, runSession } from './opencode-session.ts';
import type { RunnerConfig, RunnerResult } from './protocol.ts';

/**
 * The runner's orchestration core — the one place that sequences a worker run:
 * clone → branch → drive the agent session → dirty-check → commit → push. Git
 * lives behind `GitPort` and opencode behind `OpencodePort`, both plain-record
 * ports, so this control flow is a deep module testable against fakes (no clone,
 * no server). The opencode server's scoped finalizer (inside `runSession`) runs
 * whether the run succeeds or fails after the session.
 */

/**
 * The narrow set of git operations the runner needs. Bun's `$` stops at this
 * port; above it everything is plain strings + Effect, so the run flow is
 * testable with a fake, exactly like `forge`'s `GithubRest`.
 */
export interface GitPort {
  /** Shallow-clone `base` of `cloneUrl` into `dir`. */
  readonly clone: (p: {
    readonly cloneUrl: string;
    readonly base: string;
    readonly dir: string;
  }) => Promise<void>;
  /** Create + check out the work branch. */
  readonly checkoutBranch: (dir: string, branch: string) => Promise<void>;
  /** Set the committer identity for the throwaway clone. */
  readonly configUser: (dir: string) => Promise<void>;
  /** `git status --porcelain` output (empty ⇒ the agent changed nothing). */
  readonly statusPorcelain: (dir: string) => Promise<string>;
  /** Stage everything. */
  readonly addAll: (dir: string) => Promise<void>;
  /** Commit with the given subject. */
  readonly commit: (dir: string, message: string) => Promise<void>;
  /** Resolve HEAD's full sha. */
  readonly headSha: (dir: string) => Promise<string>;
  /** Push the work branch to origin. */
  readonly push: (dir: string, branch: string) => Promise<void>;
}

/**
 * Normalising generated code before it is committed. opencode emits unformatted
 * files, so a raw commit can fail the target repo's `biome check` in CI. This port
 * runs the repo's own formatter (FORMAT only, never a lint-gate) in the clone,
 * behind the same plain-record seam as `GitPort`, so the pre-commit flow is
 * testable with a fake.
 */
export interface FormatPort {
  /** Does the clone's `package.json` declare a `format` script? */
  readonly hasFormatScript: (dir: string) => Promise<boolean>;
  /** Run one pre-commit shell command (e.g. biome autofix) in the clone. */
  readonly run: (dir: string, command: string) => Promise<void>;
}

/** A git operation failed (clone, branch, commit, push…). */
export class GitFailed extends Data.TaggedError('GitFailed')<{
  readonly op: string;
  readonly reason: string;
}> {}

/**
 * A pre-commit format step failed. This is best-effort and NON-FATAL: formatting
 * only helps the PR pass CI, it is not a gate, so the runner logs it and commits
 * anyway. The typed error is kept so the failure can be surfaced in logs.
 */
export class FormatFailed extends Data.TaggedError('FormatFailed')<{
  readonly command: string;
  readonly reason: string;
}> {}

/** The agent edited nothing — there is no commit to push. */
export class NoChanges extends Data.TaggedError('NoChanges')<Record<string, never>> {}

/**
 * The pre-commit command sequence that reformats generated code so it is more
 * likely to pass the target repo's CI. This FORMATS only — it never lint-gates.
 * `biome check --write` would exit non-zero on unfixable/unsafe-only/info
 * diagnostics and abort the commit, so we never use it here. Prefer the repo's
 * own `format` script (`bun run format`) when it declares one; otherwise fall
 * back to `biome format --write`, which only reformats and exits 0 on lint
 * diagnostics. Pure, so the format-only invariant is unit tested without a clone.
 */
export const preCommitCommands = (opts: {
  readonly hasFormatScript: boolean;
}): ReadonlyArray<string> =>
  opts.hasFormatScript ? ['bun run format'] : ['bunx biome format --write .'];

const gitOp = <A>(op: string, fn: () => Promise<A>): Effect.Effect<A, GitFailed> =>
  Effect.tryPromise({ try: fn, catch: (e) => new GitFailed({ op, reason: String(e) }) });

const fmtOp = <A>(command: string, fn: () => Promise<A>): Effect.Effect<A, FormatFailed> =>
  Effect.tryPromise({ try: fn, catch: (e) => new FormatFailed({ command, reason: String(e) }) });

/**
 * Build the runner over a git + opencode port pair. Returns a function from a
 * decoded `RunnerConfig` to the `RunnerResult` the orchestrator reads back. The
 * dirty-check before committing is what turns a no-op agent into a typed
 * `NoChanges` (the reconciler requeues) rather than an empty commit.
 */
export const makeRunner =
  (deps: { readonly git: GitPort; readonly opencode: OpencodePort; readonly format: FormatPort }) =>
  (config: RunnerConfig): Effect.Effect<RunnerResult, GitFailed | NoChanges | OpencodeFailed> =>
    Effect.gen(function* () {
      const { git, opencode, format } = deps;
      yield* Effect.logInfo(`cloning ${config.base} into ${config.dir}`);
      yield* gitOp('clone', () =>
        git.clone({ cloneUrl: config.cloneUrl, base: config.base, dir: config.dir }),
      );
      yield* gitOp('branch', () => git.checkoutBranch(config.dir, config.branch));
      yield* gitOp('config', () => git.configUser(config.dir));

      const usage = yield* runSession(opencode, {
        dir: config.dir,
        model: config.model,
        prompt: config.prompt,
      });

      const dirty = yield* gitOp('status', () => git.statusPorcelain(config.dir));
      if (dirty.trim() === '') return yield* Effect.fail(new NoChanges({}));

      // Reformat the generated code (FORMAT only, never a lint-gate) before
      // staging, so the commit is more likely to pass the target repo's CI. This
      // is best-effort: a format step that exits non-zero is logged and skipped,
      // never aborting the commit — formatting helps CI pass, it is not a gate.
      const hasFormatScript = yield* Effect.catchAll(
        fmtOp('hasFormatScript', () => format.hasFormatScript(config.dir)),
        () => Effect.succeed(false),
      );
      for (const command of preCommitCommands({ hasFormatScript })) {
        yield* Effect.logInfo(`pre-commit: ${command}`);
        yield* Effect.catchAll(
          fmtOp(command, () => format.run(config.dir, command)),
          (e) =>
            Effect.logWarning(
              `pre-commit format step failed (continuing): ${e.command}: ${e.reason}`,
            ),
        );
      }

      yield* gitOp('add', () => git.addAll(config.dir));
      yield* gitOp('commit', () => git.commit(config.dir, config.commitMsg));
      const commitSha = (yield* gitOp('headSha', () => git.headSha(config.dir))).trim();
      yield* gitOp('push', () => git.push(config.dir, config.branch));
      yield* Effect.logInfo(`pushed ${commitSha}`);

      return { commitSha, usage };
    });
