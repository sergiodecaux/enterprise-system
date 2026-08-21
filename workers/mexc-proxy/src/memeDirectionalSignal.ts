/**
 * Directional meme setup. Candles nominate a side; a live multi-snapshot
 * order book must confirm it. The returned probability is a conservative
 * evidence estimate, not a promise of realized win rate.
 */

import type { MemeBookForecast } from './memeBookForecast'
import type { CrowdBookMetrics, OrderBookEvent, OrderBookSnapshot } from './orderBookReader'
import { aggregateTf, stillMakingHH } from './peakContext'
import type { Candle } from './peakFuelFail'

export type MemeDirection = 'LONG' | 'SHORT'

export interface MemeCandleCandidate {
  side: MemeDirection
  score: number
  htfAligned: boolean
  patterns: string[]
}

export interface MemeDirectionalSignal {
  side: MemeDirection
  setup: 'MEME_BOOK_LONG' | 'PEAK_FUEL_FAIL'
  probability: number
  limitPrice: number
  sl: number
  tp1: number
  tp: number
  target3: number
  notes: string[]
  journalReasons: string[]
}

const MIN_SIGNAL_PROBABILITY = 68

function body(c: Candle): number {
  return Math.abs(c[4] - c[1])
}

function range(c: Candle): number {
  return Math.max(0, c[2] - c[3])
}

function bullishEngulfing(a?: Candle, b?: Candle): boolean {
  return Boolean(
    a &&
      b &&
      a[4] < a[1] &&
      b[4] > b[1] &&
      b[1] <= a[4] * 1.0005 &&
      b[4] >= a[1] * 0.9995
  )
}

function hammer(c?: Candle): boolean {
  if (!c) return false
  const r = range(c)
  if (!(r > 0)) return false
  const lower = Math.min(c[1], c[4]) - c[3]
  const upper = c[2] - Math.max(c[1], c[4])
  return lower >= r * 0.5 && lower >= body(c) * 2 && upper <= r * 0.2
}

function failedBreakdown(candles: Candle[]): boolean {
  const closed = candles.slice(0, -1)
  for (let k = 0; k < 3; k++) {
    const last = closed[closed.length - 1 - k]
    if (!last) continue
    const prior = closed.slice(-(8 + k), -(1 + k))
    if (prior.length < 3) continue
    const priorLow = Math.min(...prior.map((c) => c[3]))
    if (last[3] < priorLow * 0.9997 && last[4] > priorLow * 0.9998) return true
  }
  return false
}

function morningStar(a?: Candle, b?: Candle, c?: Candle): boolean {
  if (!a || !b || !c || !(a[4] < a[1])) return false
  return (
    body(b) <= body(a) * 0.45 &&
    c[4] > c[1] &&
    c[4] > (a[1] + a[4]) / 2
  )
}

function higherLow(candles: Candle[]): boolean {
  if (candles.length < 8) return false
  const w = candles.slice(-8)
  const early = Math.min(...w.slice(0, 4).map((c) => c[3]))
  const late = Math.min(...w.slice(4).map((c) => c[3]))
  return late >= early * 0.999
}

function volumeExpansion(candles: Candle[]): boolean {
  if (candles.length < 12) return false
  const last = candles[candles.length - 1]![5]
  const base = candles.slice(-12, -2).reduce((s, c) => s + c[5], 0) / 10
  return base > 0 && last >= base * 1.35
}

function tfTrend(candles: Candle[]): 'UP' | 'DOWN' | 'FLAT' {
  if (candles.length < 4) return 'FLAT'
  const w = candles.slice(-4)
  const up =
    w[3]![4] > w[0]![4] &&
    w[3]![3] >= w[1]![3] * 0.997 &&
    w[3]![2] >= w[1]![2] * 0.998
  const down =
    w[3]![4] < w[0]![4] &&
    w[3]![2] <= w[1]![2] * 1.003 &&
    w[3]![3] <= w[1]![3] * 1.002
  return up ? 'UP' : down ? 'DOWN' : 'FLAT'
}

/**
 * Cheap candle nomination before spending the live-book request budget.
 * Returns both sides only when each has genuine structure.
 */
export function inspectMemeCandleDirections(
  candles: Candle[],
  chg24hPct: number
): MemeCandleCandidate[] {
  if (candles.length < 30) return []
  const last = candles[candles.length - 1]
  const prev = candles[candles.length - 2]
  const prev2 = candles[candles.length - 3]
  const c5 = aggregateTf(candles, 5)
  const c15 = aggregateTf(candles, 15)
  const trend5 = tfTrend(c5)
  const trend15 = tfTrend(c15)
  const vol = volumeExpansion(candles)
  const out: MemeCandleCandidate[] = []

  const bullPatterns: string[] = []
  if (bullishEngulfing(prev, last)) bullPatterns.push('bullish_engulfing')
  if (hammer(last) || hammer(prev)) bullPatterns.push('hammer')
  if (failedBreakdown(candles)) bullPatterns.push('failed_breakdown')
  if (morningStar(prev2, prev, last)) bullPatterns.push('morning_star')
  if (higherLow(candles)) bullPatterns.push('higher_low')
  if (stillMakingHH(candles, 6)) bullPatterns.push('1m_HH_HL')
  if (vol) bullPatterns.push('volume_expansion')
  if (trend5 === 'UP') bullPatterns.push('5m_up')
  if (trend15 === 'UP') bullPatterns.push('15m_up')

  const strongBullPattern = bullPatterns.some((p) =>
    ['bullish_engulfing', 'hammer', 'failed_breakdown', 'morning_star'].includes(p)
  )
  const continuation =
    stillMakingHH(candles, 6) && higherLow(candles) && vol && trend5 === 'UP'
  if (
    (strongBullPattern && trend15 !== 'DOWN') ||
    (continuation && chg24hPct >= 2 && chg24hPct <= 35)
  ) {
    let score = 52
    if (strongBullPattern) score += 7
    if (trend5 === 'UP') score += 4
    if (trend15 === 'UP') score += 4
    if (vol) score += 3
    if (higherLow(candles)) score += 2
    out.push({
      side: 'LONG',
      score: Math.min(72, score),
      htfAligned: trend15 !== 'DOWN',
      patterns: bullPatterns,
    })
  }

  // SHORT nomination stays stricter: no short while 1m is still expanding.
  const shortPatterns: string[] = []
  const r = last ? range(last) : 0
  const upper = last ? last[2] - Math.max(last[1], last[4]) : 0
  const shooting = Boolean(last && r > 0 && upper >= r * 0.45 && last[4] <= last[1])
  const engulf = Boolean(
    prev &&
      last &&
      prev[4] > prev[1] &&
      last[4] < last[1] &&
      last[4] <= prev[1] * 1.0005
  )
  if (shooting) shortPatterns.push('shooting_star')
  if (engulf) shortPatterns.push('bearish_engulfing')
  if (trend5 === 'DOWN') shortPatterns.push('5m_down')
  if (trend15 === 'DOWN') shortPatterns.push('15m_down')
  if (vol) shortPatterns.push('volume_expansion')
  if (
    !stillMakingHH(candles, 6) &&
    (shooting || engulf) &&
    chg24hPct >= 4 &&
    trend15 !== 'UP'
  ) {
    out.push({
      side: 'SHORT',
      score: Math.min(72, 57 + (shooting ? 5 : 0) + (engulf ? 6 : 0) + (vol ? 3 : 0)),
      htfAligned: trend15 !== 'UP',
      patterns: shortPatterns,
    })
  }

  return out
}

function eventSupports(side: MemeDirection, event: OrderBookEvent): boolean {
  if (!event.ready || event.side !== side) return false
  return side === 'LONG'
    ? [
        'BID_WALL_SUPPORT',
        'BUY_FLOW_IMBALANCE',
        'ABSORPTION_LONG',
        'SPOOF_SWEEP_LONG',
        'LIQ_CASCADE_LONG',
        'ASK_WALL_REMOVED',
        'CVD_DIVERGENCE',
      ].includes(event.kind)
    : [
        'ASK_WALL_RESISTANCE',
        'SELL_FLOW_IMBALANCE',
        'ABSORPTION_SHORT',
        'SPOOF_SWEEP_SHORT',
        'LIQ_CASCADE_SHORT',
        'BID_WALL_REMOVED',
        'CVD_DIVERGENCE',
      ].includes(event.kind)
}

export function detectMemeDirectionalSignal(opts: {
  candidate: MemeCandleCandidate
  price: number
  snapshot: OrderBookSnapshot
  crowd: CrowdBookMetrics
  forecast: MemeBookForecast
  event: OrderBookEvent
}): MemeDirectionalSignal | null {
  const { candidate, price, snapshot, crowd, forecast, event } = opts
  if (!(price > 0) || forecast.toxic) return null
  const side = candidate.side
  const obi = snapshot.obi
  const ratio = crowd.bidAskUsdRatio

  if (side === 'LONG') {
    if (
      crowd.largeAskWall ||
      crowd.maxAskUsd >= 1200 ||
      crowd.stackedAskWalls >= 2 ||
      ratio <= 0.65 ||
      obi <= -10 ||
      forecast.bias === 'NEXT_DOWN' ||
      (event.ready && event.side === 'SHORT')
    ) {
      return null
    }
  } else if (
    crowd.largeBidWall ||
    crowd.maxBidUsd >= 1200 ||
    crowd.stackedBidWalls >= 2 ||
    ratio >= 1.55 ||
    obi >= 10 ||
    forecast.bias === 'NEXT_UP' ||
    (event.ready && event.side === 'LONG')
  ) {
    return null
  }

  const alignedBias =
    side === 'LONG' ? forecast.bias === 'NEXT_UP' : forecast.bias === 'NEXT_DOWN'
  const wallAligned =
    side === 'LONG'
      ? crowd.largeBidWall || crowd.stackedBidWalls >= 1 || ratio >= 1.2
      : crowd.largeAskWall || crowd.stackedAskWalls >= 1 || (ratio > 0 && ratio <= 0.83)
  const alignedEvent = eventSupports(side, event)

  // At least two independent book confirmations. Static wall alone is not enough.
  const bookEvidence = [
    forecast.realBook,
    alignedBias,
    forecast.obiAligned,
    alignedEvent,
    wallAligned,
  ].filter(Boolean).length
  if (bookEvidence < 2 || (!forecast.realBook && !alignedEvent)) return null

  let probability = 46
  probability += Math.max(0, Math.min(14, (forecast.score - 50) * 0.35))
  probability += Math.max(0, Math.min(8, (candidate.score - 52) * 0.4))
  if (forecast.realBook) probability += 4
  if (alignedBias) probability += 3
  if (alignedEvent) probability += 4
  if (wallAligned) probability += 2
  if (candidate.htfAligned) probability += 2
  probability = Math.min(78, Math.round(probability))
  if (probability < MIN_SIGNAL_PROBABILITY) return null

  const risk = side === 'LONG' ? 0.011 : 0.01
  const tp1Pct = 0.01
  const tpPct = 0.02
  const tp3Pct = 0.028
  const dir = side === 'LONG' ? 1 : -1
  return {
    side,
    setup: side === 'LONG' ? 'MEME_BOOK_LONG' : 'PEAK_FUEL_FAIL',
    probability,
    limitPrice: price,
    sl: price * (1 - dir * risk),
    tp1: price * (1 + dir * tp1Pct),
    tp: price * (1 + dir * tpPct),
    target3: price * (1 + dir * tp3Pct),
    notes: [
      `оценка вероятности ${probability}%`,
      `стакан ${forecast.bias} · score ${forecast.score}/100 · OBI ${obi >= 0 ? '+' : ''}${obi.toFixed(0)}%`,
      `bids/asks USD ${ratio.toFixed(2)} · book evidence ${bookEvidence}/5`,
      `свечи: ${candidate.patterns.slice(0, 5).join(', ')}`,
      alignedEvent ? `событие стакана: ${event.kind}` : 'событие: подтверждение глубиной/OBI',
    ],
    journalReasons: [
      `prob:${probability}`,
      `conf:${probability}`,
      `book_score:${forecast.score}`,
      `obi:${Number(obi.toFixed(2))}`,
      `book_ratio:${ratio}`,
      `book_evidence:${bookEvidence}`,
      `book_bias:${forecast.bias}`,
      `book_event:${event.kind}`,
      `patterns:${candidate.patterns.slice(0, 8).join('+')}`,
      'book_ok',
      candidate.htfAligned ? 'structure_ok' : 'structure_weak',
      `quality:A`,
    ],
  }
}
