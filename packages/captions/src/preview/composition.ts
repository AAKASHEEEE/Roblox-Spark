export const COMPOSITION_EPSILON = 1e-9;

/** A solved camera composition. Intervals are half-open: start <= t < end. */
export interface TimedComposition<TShot = unknown> {
  beat: string;
  index: number;
  start: number;
  end: number;
  shot: TShot;
}

/**
 * Validate the timeline once at its trust boundary. Gaps are allowed (the caller falls back to the beat camera),
 * while overlaps, reversed windows, and unstable ordering are rejected.
 */
export function compositionTimelineIssues(compositions: readonly TimedComposition[]): string[] {
  const issues: string[] = [];
  let previous: TimedComposition | undefined;
  for (let i = 0; i < compositions.length; i++) {
    const current = compositions[i];
    if (!current || !Number.isFinite(current.start) || !Number.isFinite(current.end)) {
      issues.push(`composition[${i}] has a non-finite interval`);
      continue;
    }
    if (current.start < 0 || current.end <= current.start) issues.push(`composition[${i}] must have 0 <= start < end`);
    if (!current.beat) issues.push(`composition[${i}] has no beat id`);
    if (!Number.isInteger(current.index) || current.index < 0) issues.push(`composition[${i}] has an invalid index`);
    if (previous) {
      if (current.start < previous.start) issues.push(`composition[${i}] is not sorted by start time`);
      if (current.start < previous.end - COMPOSITION_EPSILON) issues.push(`composition[${i - 1}] overlaps composition[${i}]`);
    }
    previous = current;
  }
  return issues;
}

export function assertCompositionTimeline(compositions: readonly TimedComposition[]): void {
  const issues = compositionTimelineIssues(compositions);
  if (issues.length) throw new Error(`invalid composition timeline: ${issues.join('; ')}`);
}

/**
 * Return the composition whose half-open interval contains t. No nearest-neighbour behavior is used: gaps, times
 * before the first interval, and times at/after the final end return undefined so callers can use the beat camera.
 */
export function compositionAt<T extends TimedComposition>(compositions: readonly T[], t: number, beat?: string): T | undefined {
  if (!Number.isFinite(t) || compositions.length === 0) return undefined;
  let lo = 0, hi = compositions.length - 1, candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (compositions[mid].start <= t) { candidate = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (candidate < 0) return undefined;
  const current = compositions[candidate];
  return t < current.end && (beat === undefined || current.beat === beat) ? current : undefined;
}
