/**
 * DUMP_CONTINUATION — SHORT after dump-day bounce without real bid support.
 * Trend-follow (not DUMP_FUEL_FAIL counter-trend reclaim).
 */

import { bearishTriggerCandle } from './candleConfirm'
import type { Candle } from './peakFuelFail'

export interface DumpContinuationInput {
  symbol: string
  price: number
  chg24hPct: number
  dayBias: 'PUMP' | 'DUMP' | null
  holdVol?: number | null
  prevHoldVol?: number | null
  candles1m: Candle[]
  bookForecast?: {
    score: number
    realBook: boolean
    toxic: boolean
    bias: string
    reasons: string[]
  } | null
  bidHeavy?: boolean
}

export type DumpContQuality = 'A' | 'B'

export interface DumpContinuationSignal {
  ready: boolean
  side: 'SHORT'
  setup: 'DUMP_CONTINUATION'
  confidence: number
  quality: DumpContQuality
  bouncePct: number
  limitPrice: number
  sl: number
  tp: number
  tp1: number
  notes: string[]
  reasons: string[]
}

const SL_PCT = 0.01
const TP_PCT = 0.02
const TP1_PCT = 0.008
const MIN_DUMP_24 = -8
const BOUNCE_MIN = 1.5
const BOUNCE_MAX = 4.0

function troughAndBounce(
  candles: Candle[],
  price: number
): { trough: number; bouncePct: number; upperWicksGrowing: boolean } {
  const w = candles.slice(-80)
  let trough = Number.POSITIVE_INFINITY
  let troughIdx = -1
  for (let i = 0; i < w.length; i++) {
    if (w[i]![3] < trough) {
      trough = w[i]![3]
      troughIdx = i
    }
  }
  if (!(trough > 0) || troughIdx < 0) {
    return { trough: 0, bouncePct: 0, upperWicksGrowing: false }
  }
  const bouncePct = ((price - trough) / trough) * 100
  const after = w.slice(troughIdx)
  let upperWicksGrowing = false
  if (after.length >= 3) {
    const last3 = after.slice(-3)
    const wick = (c: Candle) => {
      const range = c[2] - c[3]
      if (!(range > 0)) return 0
      return (c[2] - Math.max(c[1], c[4])) / range
    }
    const w0 = wick(last3[0]!)
    const w2 = wick(last3[2]!)
    upperWicksGrowing =
      last3.every((c) => c[4] >= c[1] * 0.999) && w2 >= w0 + 0.08 && w2 >= 0.28
  }
  return { trough, bouncePct, upperWicksGrowing }
}

function firstRedWithVolume(candles: Candle[]): boolean {
  const closed = candles.slice(0, -1)
  if (closed.length < 4) return false
  const last = closed[closed.length - 1]!
  if (!(last[4] < last[1])) return false
  const vols = closed.slice(-6, -1).map((c) => c[5]).filter((v) => v > 0)
  const avg = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0
  return avg <= 0 || last[5] >= avg * 1.15 || bearishTriggerCandle(candles)
}

export function detectDumpContinuation(
  input: DumpContinuationInput
): DumpContinuationSignal | null {
  if (!(input.price > 0) || input.candles1m.length < 25) return null
  const dumpDay = input.dayBias === 'DUMP' || input.chg24hPct <= MIN_DUMP_24
  if (!dumpDay || input.chg24hPct > MIN_DUMP_24) return null

  const { bouncePct, upperWicksGrowing } = troughAndBounce(
    input.candles1m,
    input.price
  )
  if (bouncePct < BOUNCE_MIN || bouncePct > BOUNCE_MAX) return null

  const forecast = input.bookForecast
  if (forecast?.toxic) return null
  // Bounce should NOT have realBook bid support
  const weakBids =
    !input.bidHeavy &&
    !(forecast?.realBook && forecast.bias === 'NEXT_UP') &&
    (forecast == null || forecast.score < 55 || forecast.bias !== 'NEXT_UP')
  if (!weakBids) return null

  let oiNotCovering = true
  const hv = input.holdVol
  const prev = input.prevHoldVol
  const reasons: string[] = []
  const notes: string[] = []
  if (hv != null && prev != null && prev > 0) {
    const oiChg = ((hv - prev) / prev) * 100
    // During bounce, shorts not covering → OI not falling hard
    if (oiChg < -0.5) {
      oiNotCovering = false
      reasons.push(`oi_covering:${oiChg.toFixed(2)}`)
    } else {
      reasons.push(`oi_hold:${oiChg.toFixed(2)}`)
    }
  } else {
    reasons.push('oi_unknown')
  }
  if (!oiNotCovering) return null

  const redVol = firstRedWithVolume(input.candles1m)
  if (!redVol) return null

  reasons.push(`bounce:${bouncePct.toFixed(2)}`)
  reasons.push(`chg24:${input.chg24hPct.toFixed(1)}`)
  reasons.push('weak_bid_bounce')
  if (upperWicksGrowing) {
    reasons.push('upper_wicks_grow')
    notes.push('Отскок с растущими верхними фитилями')
  }
  reasons.push('first_red_vol')
  notes.push(`Dump day bounce +${bouncePct.toFixed(1)}% без bid support`)

  let confidence = 68
  if (upperWicksGrowing) confidence += 4
  if (forecast && forecast.bias === 'NEXT_DOWN') confidence += 5
  if (bouncePct >= 2 && bouncePct <= 3.2) confidence += 3
  confidence = Math.min(92, confidence)

  const aTier =
    confidence >= 72 &&
    bouncePct >= BOUNCE_MIN &&
    bouncePct <= BOUNCE_MAX &&
    redVol &&
    weakBids &&
    oiNotCovering

  const limit = input.price
  return {
    ready: true,
    side: 'SHORT',
    setup: 'DUMP_CONTINUATION',
    confidence,
    quality: aTier ? 'A' : 'B',
    bouncePct,
    limitPrice: limit,
    sl: limit * (1 + SL_PCT),
    tp: limit * (1 - TP_PCT),
    tp1: limit * (1 - TP1_PCT),
    notes: [
      `DUMP CONTINUATION SHORT · класс ${aTier ? 'A' : 'B'}`,
      `24h ${input.chg24hPct.toFixed(1)}% · bounce +${bouncePct.toFixed(1)}%`,
      ...notes,
    ],
    reasons: [...reasons, `quality:${aTier ? 'A' : 'B'}`, `conf:${confidence}`],
  }
}
