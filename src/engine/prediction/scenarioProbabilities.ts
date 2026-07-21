/**
 * Shared A/B/C probability weighting from MTF + news + Fear&Greed.
 * Chart scenarios and macro outlook both use this so % are not pure constants.
 */

import type { MultiTFAlignment } from './types'

export type NewsBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL'

export interface ScenarioProbContext {
  alignment: MultiTFAlignment
  isLong: boolean
  newsBias?: NewsBias
  /** 0–100 Fear & Greed index */
  fearGreed?: number | null
  /**
   * Optional book imbalance −1..+1 (bids−asks)/(bids+asks).
   * Positive = bid-heavy (supports long).
   */
  bookImbalance?: number | null
  /** Horizon soft prior */
  horizon?: 'SCALP' | 'INTRA' | 'SWING' | 'MACRO'
}

function normalize(a: number, b: number, c: number): { a: number; b: number; c: number } {
  const aa = Math.max(5, a)
  const bb = Math.max(5, b)
  const cc = Math.max(5, c)
  const sum = aa + bb + cc
  const ra = Math.round((aa / sum) * 100)
  const rb = Math.round((bb / sum) * 100)
  return { a: ra, b: rb, c: Math.max(5, 100 - ra - rb) }
}

/**
 * Base priors by horizon, then MTF / news / FG / book nudges.
 */
export function calcScenarioProbabilities(
  ctx: ScenarioProbContext
): { a: number; b: number; c: number } {
  const { alignment, isLong } = ctx
  const h = ctx.horizon ?? 'INTRA'

  // Priors: scalp more sweep-prone; swing more trend-weighted
  let a = h === 'SCALP' ? 58 : h === 'SWING' || h === 'MACRO' ? 62 : 70
  let b = h === 'SCALP' ? 28 : h === 'SWING' || h === 'MACRO' ? 23 : 20
  let c = h === 'SCALP' ? 14 : h === 'SWING' || h === 'MACRO' ? 15 : 10

  const abs = Math.abs(alignment.score)
  if (abs >= 4 && alignment.agreement) {
    a += 8
    b -= 4
    c -= 4
  } else if (abs <= 1) {
    a -= 12
    b += 6
    c += 6
  }

  if (
    alignment.strength === 'STRONG_LONG' ||
    alignment.strength === 'STRONG_SHORT'
  ) {
    a += 4
    c -= 2
  }

  const news = ctx.newsBias ?? 'NEUTRAL'
  const newsWith =
    (isLong && news === 'BULLISH') || (!isLong && news === 'BEARISH')
  const newsAgainst =
    (isLong && news === 'BEARISH') || (!isLong && news === 'BULLISH')
  if (newsWith) {
    a += 5
    c -= 3
  } else if (newsAgainst) {
    a -= 8
    c += 5
    b += 3
  }

  const fg = ctx.fearGreed
  if (fg != null && Number.isFinite(fg)) {
    // Extreme fear → bounce longs favored / shorts caution; greed inverse
    if (isLong) {
      if (fg <= 25) {
        a += 4
        c -= 2
      } else if (fg >= 75) {
        a -= 5
        c += 3
        b += 2
      }
    } else {
      if (fg >= 75) {
        a += 4
        c -= 2
      } else if (fg <= 25) {
        a -= 5
        c += 3
        b += 2
      }
    }
  }

  const book = ctx.bookImbalance
  if (book != null && Number.isFinite(book) && Math.abs(book) >= 0.15) {
    const bookWith = (isLong && book > 0) || (!isLong && book < 0)
    if (bookWith) {
      a += 3
      c -= 2
    } else {
      a -= 4
      c += 3
    }
  }

  return normalize(a, b, c)
}
