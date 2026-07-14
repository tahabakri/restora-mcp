/** Shared retention policy logic, used by every destination (Drive, S3, …) so the rules stay identical. */

export interface RetentionPolicy {
  keep?: number;
  weeks?: number;
}

/**
 * Given backups NEWEST-FIRST (each with a `time` in ms-epoch), return the ones to prune: beyond the
 * newest `keep` OR older than `weeks` weeks. The most recent backup (index 0) is NEVER pruned, so a
 * long-paused user is never left with zero copies. Returns [] when no policy is set.
 */
export function selectStale<T extends { time: number }>(itemsNewestFirst: T[], policy: RetentionPolicy): T[] {
  const keep = policy.keep && policy.keep > 0 ? policy.keep : undefined;
  const weeks = policy.weeks && policy.weeks > 0 ? policy.weeks : undefined;
  if (keep === undefined && weeks === undefined) return [];
  const cutoff = weeks !== undefined ? Date.now() - weeks * 7 * 24 * 60 * 60 * 1000 : null;
  return itemsNewestFirst.filter((it, i) => {
    if (i === 0) return false; // always keep the newest
    const tooMany = keep !== undefined && i >= keep;
    const tooOld = cutoff !== null && it.time < cutoff;
    return tooMany || tooOld;
  });
}
