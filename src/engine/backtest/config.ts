/**
 * Locks for the calibration harness. These are acceptance rules agreed
 * before the first run, not multipliers fitted to a result.
 * Phase 2 must warn in the UI when calibratedAt is older than STALE_AFTER_DAYS.
 */
export const MIN_SAMPLES = 30
export const MIN_UNIQUE_WEEKS = 8
export const WILSON_Z = 1.96
/**
 * Family-wise alpha for an axis split. Bonferroni over every group with
 * n >= MIN_SAMPLES. The interval uses z = Φ^{-1}(1 - alpha / (2m)).
 * Locked before the body-strength split, not chosen after a bucket looked good.
 * A holdout check of a group that already cleared this bar stays at WILSON_Z.
 */
export const FAMILY_ALPHA = 0.05
/** Interval wider than this is status "wide", even when n >= MIN_SAMPLES. */
export const WIDE_INTERVAL = 0.4
export const HOLDOUT_WEEKS = 8
export const HORIZONS = [5, 20, 50] as const
export const STALE_AFTER_DAYS = 90
/** Same tails the live chart asks MEXC for. */
export const LIVE_WINDOWS = {
  m15: 96,
  h1: 120,
  h4: 100,
  d1: 90,
} as const
export const BTC_ETH_MONTHS = 18
export const OTHER_MONTHS = 6

/**
 * Funding hypothesis, locked 2026-10-11 before any settle was scored.
 * The only combination on this sample is a 90-print window, tails at 10 and 90,
 * and forward closes at 8h and 24h. A null result stays null.
 * A neighbouring percentile or horizon needs a new holdout partition.
 */
export const FUNDING_WINDOW = 90
export const FUNDING_P_LO = 10
export const FUNDING_P_HI = 90
export const FUNDING_HORIZONS_H = [8, 24] as const
export const FUNDING_CELLS = [
  'high_pos|8h',
  'low_neg|8h',
  'high_pos|24h',
  'low_neg|24h',
] as const
/**
 * Hours before the next event of the same symbol and the same tail.
 * Keep this at least as long as the longest horizon. With both at 24h on a
 * continuous hourly series, the next window starts at the previous window's
 * last close: the two paths share that print and not the hours inside.
 * A horizon longer than this gap would score the same price path twice.
 */
export const FUNDING_DEDUP_H = 24
