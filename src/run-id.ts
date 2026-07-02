/**
 * The correlation id threaded end-to-end for one dispatched agent-worker run
 * (folds `tckt_4utv62nij6`): the reconciler's dispatch log, the k8s Job's
 * `TIDEPOOL_RUN_ID` env var, and this worker's own log annotations all carry
 * the SAME value — the `WorkHandle` (already the Job's name, minted once per
 * dispatch, see reconciler.ts). Reusing it avoids inventing a second id for
 * the same concept; grepping one value across `kubectl logs` and the
 * reconciler's own log finds a whole ticket's flow end-to-end. Fail-open
 * (mirrors git-sha.ts's `shortGitSha`): a pod started without the env var
 * (local dev, a manual `kubectl run`) still logs, just without a real run id.
 */
export const workerRunId = (raw: string | undefined = process.env.TIDEPOOL_RUN_ID): string => {
  const trimmed = raw?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : 'dev';
};
