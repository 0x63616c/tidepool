import type { CIStatus } from './domain.ts';

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

/** Split an `owner/name` slug into its parts. */
export const parseRepo = (repo: string): { readonly owner: string; readonly name: string } => {
  const [owner, name] = repo.split('/');
  if (owner === undefined || name === undefined || name === '') {
    throw new Error(`forge: malformed repo slug "${repo}" (expected "owner/name")`);
  }
  return { owner, name };
};
