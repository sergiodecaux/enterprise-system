/**
 * Shared A/B/C probability weighting from MTF + news + Fear&Greed + book + BTC.
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
  /**
   * Relative strength vs BTC in % (coin − btc over lookback).
   * Positive = alt outperforming BTC.
   */
  btcRelativeStrengthPct?: number | null
  /** Short-term price momentum % (e.g. last 15–60m) */
  momentumPct?: number | null
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
 * Base priors by horizon, then MTF / news / FG / book / BTC / momentum nudges.
 */
export function calcScenarioProbabilities(
  ctx: ScenarioProbContext
): { a: number; b: number; c: number } {
  const { alignment, isLong } = ctx
  const h = ctx.horizon ?? 'INTRA'

  // Wider priors so live data can visibly shift A/B/C
  let a = h === 'SCALP' ? 52 : h === 'SWING' || h === 'MACRO' ? 60 : 62
  let b = h === 'SCALP' ? 30 : h === 'SWING' || h === 'MACRO' ? 24 : 24
  let c = h === 'SCALP' ? 18 : h === 'SWING' || h === 'MACRO' ? 16 : 14

  const abs = Math.abs(alignment.score)
  if (abs >= 4 && alignment.agreement) {
    a += 10
    b -= 5
    c -= 5
  } else if (abs <= 1) {
    a -= 14
    b += 7
    c += 7
  }

  if (
    alignment.strength === 'STRONG_LONG' ||
    alignment.strength === 'STRONG_SHORT'
  ) {
    a += 5
    c -= 2
  }

  const news = ctx.newsBias ?? 'NEUTRAL'
  const newsWith =
    (isLong && news === 'BULLISH') || (!isLong && news === 'BEARISH')
  const newsAgainst =
    (isLong && news === 'BEARISH') || (!isLong && news === 'BULLISH')
  if (newsWith) {
    a += 6
    c -= 3
  } else if (newsAgainst) {
    a -= 10
    c += 6
    b += 4
  }

  const fg = ctx.fearGreed
  if (fg != null && Number.isFinite(fg)) {
    if (isLong) {
      if (fg <= 25) {
        a += 5
        c -= 2
      } else if (fg >= 75) {
        a -= 6
        c += 4
        b += 2
      }
    } else {
      if (fg >= 75) {
        a += 5
        c -= 2
      } else if (fg <= 25) {
        a -= 6
        c += 4
        b += 2
      }
    }
  }

  const book = ctx.bookImbalance
  if (book != null && Number.isFinite(book) && Math.abs(book) >= 0.12) {
    const bookWith = (isLong && book > 0) || (!isLong && book < 0)
    if (bookWith) {
      a += 5 + Math.min(4, Math.abs(book) * 8)
      c -= 3
    } else {
      a -= 6
      c += 4
      b += 2
    }
  }

  const rs = ctx.btcRelativeStrengthPct
  if (rs != null && Number.isFinite(rs) && Math.abs(rs) >= 1.5) {
    const rsWith = (isLong && rs > 0) || (!isLong && rs < 0)
    if (rsWith) {
      a += Math.min(8, Math.abs(rs))
      c -= 3
    } else {
      a -= Math.min(10, Math.abs(rs) * 0.8)
      c += 5
      b += 3
    }
  }

  const mom = ctx.momentumPct
  if (mom != null && Number.isFinite(mom) && Math.abs(mom) >= 0.35) {
    const momWith = (isLong && mom > 0) || (!isLong && mom < 0)
    if (momWith) {
      a += 4
      b -= 1
    } else {
      a -= 7
      b += 4
      c += 3
    }
  }

  return normalize(a, b, c)
}
