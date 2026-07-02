/** Length of the log-stamped sha — long enough to disambiguate, short enough to read. */
const SHORT_SHA_LEN = 7;

/**
 * The short git sha stamped onto every log line (reconciler, daemon,
 * agent-worker), so a misbehaving pod in prod is traceable back to the exact
 * commit it's running. Reads the same `TIDEPOOL_GIT_SHA` env var the control-plane
 * Deployment sets and re-stamps onto worker Jobs (`infra/pulumi/cluster/
 * control-plane-deployment.ts`) — a single upstream value, two downstream shapes:
 * `gitShaLabelValue` in `infra/pulumi/cluster/guards.ts` coerces the FULL sha into
 * a k8s-label-safe string for `tidepool/git-sha`; this slices it to 7 chars for
 * human-readable logs. Fail-open to `dev` when unset OR shorter than
 * `SHORT_SHA_LEN` (a local run, or any other placeholder) so a log line never
 * shows a misleadingly truncated partial sha.
 */
export const shortGitSha = (raw: string | undefined = process.env.TIDEPOOL_GIT_SHA): string => {
  const trimmed = raw?.trim() ?? '';
  return trimmed.length >= SHORT_SHA_LEN ? trimmed.slice(0, SHORT_SHA_LEN) : 'dev';
};
