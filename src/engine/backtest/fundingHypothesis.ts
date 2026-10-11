/**
 * Pure rules for the funding-extreme hypothesis.
 * Thresholds live in config.ts and were locked before the run.
 */
import {
  FUNDING_CELLS,
  FUNDING_HORIZONS_H,
  FUNDING_P_HI,
  FUNDING_P_LO,
  FUNDING_WINDOW,
} from './config'

export type FundingTail = 'high_pos' | 'low_neg'
export type FundingCell = (typeof FUNDING_CELLS)[number]

/** Excel PERCENTILE / Hyndman-Fan type 7. Locked with the tails, not fitted. */
export function percentileType7(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length
  if (n < 1) throw new Error('percentile of an empty window')
  if (n === 1) return sortedAsc[0]!
  const rank = (p / 100) * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sortedAsc[lo]!
  const w = rank - lo
  return sortedAsc[lo]! * (1 - w) + sortedAsc[hi]! * w
}

/**
 * Upper tail and a positive rate: fade expects price down.
 * Lower tail and a negative rate: fade expects price up.
 * A tail whose sign does not match is not an event.
 */
export function fundingTail(rate: number, prior: readonly number[]): FundingTail | null {
  if (prior.length !== FUNDING_WINDOW) return null
  const sorted = [...prior].sort((a, b) => a - b)
  const pLo = percentileType7(sorted, FUNDING_P_LO)
  const pHi = percentileType7(sorted, FUNDING_P_HI)
  if (rate >= pHi && rate > 0) return 'high_pos'
  if (rate <= pLo && rate < 0) return 'low_neg'
  return null
}

export function cellKey(tail: FundingTail, horizonH: number): FundingCell {
  const key = `${tail}|${horizonH}h` as FundingCell
  if (!(FUNDING_CELLS as readonly string[]).includes(key)) {
    throw new Error(`horizon ${horizonH} is outside the locked funding cells`)
  }
  return key
}

export function lockedHorizons(): readonly number[] {
  return FUNDING_HORIZONS_H
}

/** Down after a positive extreme, up after a negative extreme. Zero is undecided. */
export function fadeHit(
  tail: FundingTail,
  ret: number
): 'hit' | 'invalidated' | 'undecided' {
  if (ret === 0) return 'undecided'
  const fadeDown = tail === 'high_pos'
  if (fadeDown) return ret < 0 ? 'hit' : 'invalidated'
  return ret > 0 ? 'hit' : 'invalidated'
}
