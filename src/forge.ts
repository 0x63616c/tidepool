import { Octokit } from '@octokit/rest';
import { $ } from 'bun';
import { Effect, Layer } from 'effect';
import { type CIStatus, ForgeError, MergeConflict, type PrLifecycle } from './domain.ts';
import { newPrId } from './ids.ts';
import { Forge, type ForgeApi } from './services.ts';

/**
 * A single normalized check outcome. GitHub has two reporting systems for a
 * commit (check-runs and legacy commit statuses); both map onto this so the
 * roll-up stays decoupled from Octokit's wire types. `neutral` covers
 * skipped/neutral conclusions — present but not blocking.
 */
export type CheckState = 'pending' | 'success' | 'failure' | 'neutral';

/**
 * Collapse all of a head SHA's checks to one `CIStatus`. Wait while anything is
 * still pending (so the reconciler doesn't burn a retry on an unsettled run);
 * once everything has settled, red if any failed, else green. No checks ⇒
 * pending — nothing has reported yet.
 */
export const combineCI = (checks: ReadonlyArray<CheckState>): CIStatus => {
  if (checks.length === 0) return 'pending';
  if (checks.some((c) => c === 'pending')) return 'pending';
  if (checks.some((c) => c === 'failure')) return 'red';
  return 'green';
};

/** Map a check-run's (status, conclusion) onto a `CheckState`. */
export const checkRunState = (status: string, conclusion: string | null): CheckState => {
  if (status !== 'completed') return 'pending';
  if (conclusion === 'success') return 'success';
  if (conclusion === 'neutral' || conclusion === 'skipped') return 'neutral';
  return 'failure';
};

/** Map a legacy commit-status `state` onto a `CheckState`. */
export const commitStatusState = (state: string): CheckState => {
  if (state === 'pending') return 'pending';
  if (state === 'success') return 'success';
  return 'failure'; // failure | error
};

/**
 * Classify a failed merge by HTTP status. 405 (not mergeable) and 409 (head
 * moved / conflict) mean the branch is stale vs base → `MergeConflict`, which
 * sends the ticket back to re-work. Anything else is a transient `ForgeError`.
 */
export const classifyMergeError = (status: number): 'conflict' | 'forge' =>
  status === 405 || status === 409 ? 'conflict' : 'forge';

/**
 * Map GitHub's pull wire state to our tri-state `PrLifecycle`. `merged` takes
 * priority over `state` — GitHub always sets `state: 'closed'` alongside
 * `merged: true`, so checking `merged` first is what tells a merge apart from
 * a plain close (the distinction the reconciler's tri-state settle depends on).
 */
export const prLifecycleOf = (row: {
  readonly merged: boolean;
  readonly state: string;
}): PrLifecycle => (row.merged ? 'merged' : row.state === 'closed' ? 'closed' : 'open');

/** Split an `owner/name` slug into its parts. */
export const parseRepo = (repo: string): { readonly owner: string; readonly name: string } => {
  const [owner, name] = repo.split('/');
  if (owner === undefined || name === undefined || name === '') {
    throw new Error(`forge: malformed repo slug "${repo}" (expected "owner/name")`);
  }
  return { owner, name };
};

// ── GitHub adapter ───────────────────────────────────────────────────────────

/**
 * The narrow set of GitHub operations the forge needs. Octokit's wire types stop
 * here — everything above the port speaks plain records, so the adapter is a deep
 * module and its orchestration is testable with a fake port (no network).
 */
export interface CheckRunRow {
  readonly status: string;
  readonly conclusion: string | null;
}
export interface CommitStatusRow {
  readonly state: string;
}
export interface PullStateRow {
  readonly merged: boolean;
  readonly state: string;
  readonly mergeCommitSha: string | null;
}
export interface GithubRest {
  readonly createPull: (p: {
    readonly owner: string;
    readonly repo: string;
    readonly head: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
  }) => Promise<{ readonly number: number; readonly url: string }>;
  readonly headSha: (p: {
    readonly owner: string;
    readonly repo: string;
    readonly pull_number: number;
  }) => Promise<string>;
  /** Read a PR's own lifecycle — the ground truth `prState` reads through. */
  readonly pullState: (p: {
    readonly owner: string;
    readonly repo: string;
    readonly pull_number: number;
  }) => Promise<PullStateRow>;
  readonly checkRuns: (p: {
    readonly owner: string;
    readonly repo: string;
    readonly ref: string;
  }) => Promise<ReadonlyArray<CheckRunRow>>;
  readonly commitStatuses: (p: {
    readonly owner: string;
    readonly repo: string;
    readonly ref: string;
  }) => Promise<ReadonlyArray<CommitStatusRow>>;
  /** Squash-merge; rejects with an error carrying an HTTP `status` on failure. */
  readonly squashMerge: (p: {
    readonly owner: string;
    readonly repo: string;
    readonly pull_number: number;
  }) => Promise<{ readonly sha: string }>;
}

/** Pull an HTTP status off an unknown thrown error (Octokit RequestError). */
export const httpStatusOf = (e: unknown): number =>
  typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number'
    ? e.status
    : 0;

/** Build the `ForgeApi` over a `GithubRest` port. */
export const makeGithubForge = (rest: GithubRest): ForgeApi => ({
  openPR: (input) =>
    Effect.gen(function* () {
      const { owner, name } = parseRepo(input.repo);
      const pr = yield* Effect.tryPromise({
        try: () =>
          rest.createPull({
            owner,
            repo: name,
            head: input.branch,
            base: input.base,
            title: input.title,
            body: input.body,
          }),
        catch: (e) => new ForgeError({ op: 'openPR', reason: String(e) }),
      });
      return { id: newPrId(), number: pr.number, url: pr.url };
    }),
  prState: (input) =>
    Effect.gen(function* () {
      const { owner, name } = parseRepo(input.repo);
      const row = yield* Effect.tryPromise({
        try: () => rest.pullState({ owner, repo: name, pull_number: input.prNumber }),
        catch: (e) => new ForgeError({ op: 'prState', reason: String(e) }),
      });
      return { state: prLifecycleOf(row), mergeSha: row.mergeCommitSha };
    }),
  checks: (input) =>
    Effect.gen(function* () {
      const { owner, name } = parseRepo(input.repo);
      const sha = yield* Effect.tryPromise({
        try: () => rest.headSha({ owner, repo: name, pull_number: input.prNumber }),
        catch: (e) => new ForgeError({ op: 'checks', reason: String(e) }),
      });
      const runs = yield* Effect.tryPromise({
        try: () => rest.checkRuns({ owner, repo: name, ref: sha }),
        catch: (e) => new ForgeError({ op: 'checks', reason: String(e) }),
      });
      const statuses = yield* Effect.tryPromise({
        try: () => rest.commitStatuses({ owner, repo: name, ref: sha }),
        catch: (e) => new ForgeError({ op: 'checks', reason: String(e) }),
      });
      const states = [
        ...runs.map((r) => checkRunState(r.status, r.conclusion)),
        ...statuses.map((s) => commitStatusState(s.state)),
      ];
      return combineCI(states);
    }),
  merge: (input) =>
    Effect.gen(function* () {
      const { owner, name } = parseRepo(input.repo);
      return yield* Effect.tryPromise({
        try: () => rest.squashMerge({ owner, repo: name, pull_number: input.prNumber }),
        catch: (e) =>
          classifyMergeError(httpStatusOf(e)) === 'conflict'
            ? new MergeConflict({ prNumber: input.prNumber })
            : new ForgeError({ op: 'merge', reason: String(e) }),
      });
    }),
});

/** Bind the `GithubRest` port to a real Octokit client. */
export const octokitRest = (token: string): GithubRest => {
  const octokit = new Octokit({ auth: token });
  return {
    createPull: (p) =>
      octokit.pulls
        .create({
          owner: p.owner,
          repo: p.repo,
          head: p.head,
          base: p.base,
          title: p.title,
          body: p.body,
        })
        .then((r) => ({ number: r.data.number, url: r.data.html_url })),
    headSha: (p) =>
      octokit.pulls
        .get({ owner: p.owner, repo: p.repo, pull_number: p.pull_number })
        .then((r) => r.data.head.sha),
    pullState: (p) =>
      octokit.pulls.get({ owner: p.owner, repo: p.repo, pull_number: p.pull_number }).then((r) => ({
        merged: r.data.merged,
        state: r.data.state,
        mergeCommitSha: r.data.merge_commit_sha,
      })),
    checkRuns: (p) =>
      octokit.checks
        .listForRef({ owner: p.owner, repo: p.repo, ref: p.ref })
        .then((r) =>
          r.data.check_runs.map((c) => ({ status: c.status, conclusion: c.conclusion })),
        ),
    commitStatuses: (p) =>
      octokit.repos
        .listCommitStatusesForRef({ owner: p.owner, repo: p.repo, ref: p.ref })
        .then((r) => r.data.map((s) => ({ state: s.state }))),
    squashMerge: (p) =>
      octokit.pulls
        .merge({ owner: p.owner, repo: p.repo, pull_number: p.pull_number, merge_method: 'squash' })
        .then((r) => ({ sha: r.data.sha })),
  };
};

/** Resolve a GitHub token: `GITHUB_TOKEN` if set, else the `gh` CLI's token. */
export const githubToken: Effect.Effect<string, ForgeError> = Effect.gen(function* () {
  const fromEnv = process.env.GITHUB_TOKEN;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return yield* Effect.tryPromise({
    try: async () => (await $`gh auth token`.text()).trim(),
    catch: (e) => new ForgeError({ op: 'auth', reason: String(e) }),
  });
});

/** Live `Forge` layer — token-authed Octokit behind the locked interface. */
export const GithubForgeLive: Layer.Layer<Forge, ForgeError> = Layer.effect(
  Forge,
  Effect.map(githubToken, (token) => makeGithubForge(octokitRest(token))),
);
