export function isBlank(s: string): boolean {
  return s.trim().length === 0;
}

/**
 * Cut `s` to at most `max` chars, appending an ellipsis marker whenever
 * anything was cut. Used to bound log-line annotations (e.g. a reviewer's
 * free-text reason) to keep them signal, not noise — the full untruncated
 * value stays available elsewhere (the persisted transcript `RunEvent`), so
 * nothing is silently lost, only kept out of the log line.
 */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
