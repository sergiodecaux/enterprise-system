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

export type BtcBurstState = 'RISK_ON' | 'RISK_OFF' | 'NEUTRAL'
type MovementPhase =
  | 'ACCUMULATION'
  | 'RANGE'
  | 'IMPULSE_UP'
  | 'IMPULSE_DOWN'
  | 'EXTENSION_UP'
  | 'EXTENSION_DOWN'
  | 'DISTRIBUTION'
  | 'UNKNOWN'

const MIN_SIGNAL_PROBABILITY = 68
const MIN_DIRECTION_GAP = 4
const RANGE_BOUNDARY_PATTERNS = [
  'range_low_reclaim',
  'range_high_reject',
  'range_breakout_up',
  'range_breakdown',
] as const

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

export function movementPhase(candles: Candle[]): MovementPhase {
  const closed = candles.slice(0, -1)
  if (closed.length < 30) return 'UNKNOWN'
  const recent = closed.slice(-5)
  const older = closed.slice(-20, -5)
  const recentVol =
    recent.reduce((sum, candle) => sum + candle[5], 0) / Math.max(1, recent.length)
  const olderVol =
    older.reduce((sum, candle) => sum + candle[5], 0) / Math.max(1, older.length)
  const move =
    recent[0]![1] > 0
      ? ((recent[recent.length - 1]![4] - recent[0]![1]) / recent[0]![1]) * 100
      : 0
  const volRatio = olderVol > 0 ? recentVol / olderVol : 1
  const rangeWindow = closed.slice(-40)
  const high = Math.max(...rangeWindow.map((candle) => candle[2]))
  const low = Math.min(...rangeWindow.map((candle) => candle[3]))
  const range = high - low
  const last = recent[recent.length - 1]![4]
  const rangeWidthPct = last > 0 ? (range / last) * 100 : 0
  const position = range > 0 ? (last - low) / range : 0.5
  if (Math.abs(move) < 0.35 && volRatio >= 1.15 && position < 0.75) {
    return 'ACCUMULATION'
  }
  if (move >= 0.35 && volRatio >= 1.05 && position < 0.9) return 'IMPULSE_UP'
  if (move <= -0.35 && volRatio >= 1.05 && position > 0.1) return 'IMPULSE_DOWN'
  if (position >= 0.82 && volRatio < 1) return 'EXTENSION_UP'
  if (position <= 0.18 && volRatio < 1) return 'EXTENSION_DOWN'
  if (position >= 0.78 && volRatio >= 1.1 && Math.abs(move) < 0.45) {
    return 'DISTRIBUTION'
  }
  if (
    Math.abs(move) < 0.7 &&
    rangeWidthPct >= 0.6 &&
    rangeWidthPct <= 8 &&
    volRatio >= 0.5 &&
    volRatio <= 1.6
  ) {
    return 'RANGE'
  }
  return 'UNKNOWN'
}

export function tailBlocked(candles: Candle[], side: MemeDirection): boolean {
  const closed = candles.slice(0, -1)
  if (closed.length < 20) return true
  const window = closed.slice(-120)
  const first = window[0]![1]
  const last = window[window.length - 1]![4]
  const move = first > 0 ? ((last - first) / first) * 100 : 0
  const lastThree = closed.slice(-3)
  const fallingVolume =
    lastThree.length === 3 &&
    lastThree[0]![5] > lastThree[1]![5] &&
    lastThree[1]![5] > lastThree[2]![5]
  if (side === 'LONG') return move > 15 || (move > 5 && fallingVolume)
  return move < -12
}

export function patternTier(patterns: string[]): 'S' | 'A' | 'B' {
  if (
    patterns.some((pattern) =>
      [
        'failed_breakdown',
        'morning_star',
        'bullish_engulfing',
        'bearish_engulfing',
        'shooting_star',
        'range_breakout_up',
        'range_breakdown',
      ].includes(pattern)
    )
  ) {
    return 'S'
  }
  if (
    patterns.some((pattern) =>
      [
        'hammer',
        'higher_low',
        'range_low_reclaim',
        'range_high_reject',
      ].includes(pattern)
    )
  ) {
    return 'A'
  }
  return 'B'
}

/**
 * Cheap candle nomination before spending the live-book request budget.
 * Inside a bounded RANGE both sides are nominated; the book picks direction.
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
  const rangeBase = candles.slice(0, -2).slice(-40)
  const rangeHigh =
    rangeBase.length >= 20 ? Math.max(...rangeBase.map((c) => c[2])) : 0
  const rangeLow =
    rangeBase.length >= 20 ? Math.min(...rangeBase.map((c) => c[3])) : 0
  const rangeWidthPct =
    rangeLow > 0 ? ((rangeHigh - rangeLow) / rangeLow) * 100 : 0
  const rangePosition =
    last && rangeHigh > rangeLow
      ? (last[4] - rangeLow) / (rangeHigh - rangeLow)
      : 0.5
  const validRange =
    rangeBase.length >= 20 && rangeWidthPct >= 0.6 && rangeWidthPct <= 8
  const boxed = validRange || movementPhase(candles) === 'RANGE'
  const rangeLowReclaim = Boolean(
    validRange && last && rangePosition <= 0.35 && last[4] > last[1]
  )
  const rangeBreakoutUp = Boolean(
    validRange &&
      last &&
      last[4] > rangeHigh * 1.001 &&
      last[4] > last[1] &&
      vol
  )
  const rangeBookForecastLong = boxed && rangePosition <= 0.72

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
  if (rangeLowReclaim) bullPatterns.push('range_low_reclaim')
  if (rangeBreakoutUp) bullPatterns.push('range_breakout_up')
  if (rangeBookForecastLong && !rangeLowReclaim && !rangeBreakoutUp) {
    bullPatterns.push('range_book_forecast_long')
  }

  const strongBullPattern = bullPatterns.some((p) =>
    ['bullish_engulfing', 'hammer', 'failed_breakdown', 'morning_star'].includes(p)
  )
  const continuation =
    stillMakingHH(candles, 6) && higherLow(candles) && vol && trend5 === 'UP'
  if (
    (strongBullPattern && trend15 !== 'DOWN') ||
    (continuation && chg24hPct >= 2 && chg24hPct <= 35) ||
    rangeLowReclaim ||
    rangeBreakoutUp ||
    rangeBookForecastLong
  ) {
    let score = 52
    if (strongBullPattern) score += 7
    if (trend5 === 'UP') score += 4
    if (trend15 === 'UP') score += 4
    if (vol) score += 3
    if (higherLow(candles)) score += 2
    if (rangeLowReclaim) score += hammer(last) || failedBreakdown(candles) ? 8 : 5
    if (rangeBreakoutUp) score += 7
    if (rangeBookForecastLong) score += 2
    out.push({
      side: 'LONG',
      score: Math.min(72, score),
      htfAligned: trend15 !== 'DOWN',
      patterns: bullPatterns,
    })
  }

  // SHORT: peaks stay strict; RANGE nominates the high/mid so the book can fade.
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
  const rangeHighReject = Boolean(
    validRange && last && rangePosition >= 0.65 && last[4] < last[1]
  )
  const rangeBreakdown = Boolean(
    validRange &&
      last &&
      last[4] < rangeLow * 0.999 &&
      last[4] < last[1] &&
      vol
  )
  const rangeBookForecastShort = boxed && rangePosition >= 0.28
  if (shooting) shortPatterns.push('shooting_star')
  if (engulf) shortPatterns.push('bearish_engulfing')
  if (trend5 === 'DOWN') shortPatterns.push('5m_down')
  if (trend15 === 'DOWN') shortPatterns.push('15m_down')
  if (vol) shortPatterns.push('volume_expansion')
  if (rangeHighReject) shortPatterns.push('range_high_reject')
  if (rangeBreakdown) shortPatterns.push('range_breakdown')
  if (rangeBookForecastShort && !rangeHighReject && !rangeBreakdown) {
    shortPatterns.push('range_book_forecast_short')
  }
  if (
    (!stillMakingHH(candles, 6) &&
      (shooting || engulf) &&
      chg24hPct >= 4 &&
      trend15 !== 'UP') ||
    rangeHighReject ||
    rangeBreakdown ||
    rangeBookForecastShort
  ) {
    out.push({
      side: 'SHORT',
      score: Math.min(
        76,
        57 +
          (shooting ? 5 : 0) +
          (engulf ? 6 : 0) +
          (vol ? 3 : 0) +
          (rangeHighReject ? shooting || engulf ? 8 : 5 : 0) +
          (rangeBreakdown ? 7 : 0) +
          (rangeBookForecastShort ? 2 : 0)
      ),
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
  candles: Candle[]
  btcState: BtcBurstState
  tapeBuyPct: number | null
  tapeMoveBps: number | null
}): MemeDirectionalSignal | null {
  const {
    candidate,
    price,
    snapshot,
    crowd,
    forecast,
    event,
    candles,
    btcState,
    tapeBuyPct,
    tapeMoveBps,
  } = opts
  if (!(price > 0) || forecast.toxic) return null
  const side = candidate.side
  const obi = snapshot.obi
  const ratio = crowd.bidAskUsdRatio
  const phase = movementPhase(candles)
  const tier = patternTier(candidate.patterns)
  if (tailBlocked(candles, side)) return null
  if (side === 'LONG' && btcState === 'RISK_OFF') return null
  if (side === 'SHORT' && btcState === 'RISK_ON') return null
  if (
    side === 'LONG' &&
    phase !== 'ACCUMULATION' &&
    phase !== 'IMPULSE_UP' &&
    !(
      phase === 'RANGE' &&
      (candidate.patterns.includes('range_low_reclaim') ||
        candidate.patterns.includes('range_breakout_up') ||
        candidate.patterns.includes('range_book_forecast_long'))
    )
  ) {
    return null
  }
  if (
    side === 'SHORT' &&
    phase !== 'EXTENSION_UP' &&
    phase !== 'DISTRIBUTION' &&
    !(
      phase === 'RANGE' &&
      (candidate.patterns.includes('range_high_reject') ||
        candidate.patterns.includes('range_breakdown') ||
        candidate.patterns.includes('range_book_forecast_short'))
    ) &&
    !(
      phase === 'IMPULSE_DOWN' &&
      candidate.patterns.includes('range_breakdown')
    )
  ) {
    return null
  }

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
  const flowAligned =
    tapeBuyPct != null &&
    (side === 'LONG' ? tapeBuyPct >= 55 : tapeBuyPct <= 45)
  const moveAligned =
    tapeMoveBps != null &&
    (side === 'LONG' ? tapeMoveBps >= 2 : tapeMoveBps <= -2)
  const syncScore = alignedEvent && (flowAligned || moveAligned) ? 15 : alignedEvent || (flowAligned && moveAligned) ? 8 : 0
  if (syncScore < 8) return null
  const rangeBoundary = candidate.patterns.some((pattern) =>
    (RANGE_BOUNDARY_PATTERNS as readonly string[]).includes(pattern)
  )
  const rangeForecastOnly =
    !rangeBoundary &&
    candidate.patterns.some((pattern) => pattern.startsWith('range_book_forecast_'))
  if (phase === 'RANGE' && !alignedBias) return null
  if (phase === 'RANGE' && rangeForecastOnly && syncScore < 15) return null

  // At least two independent book confirmations. Static wall alone is not enough.
  const bookEvidence = [
    forecast.realBook,
    alignedBias,
    forecast.obiAligned,
    alignedEvent,
    wallAligned,
  ].filter(Boolean).length
  if (bookEvidence < 2 || (!forecast.realBook && !alignedEvent)) return null

  // Jeweler Burst score: no base anchor and no duplicate reward for raw OBI.
  let probability = 0
  probability += tier === 'S' ? 15 : tier === 'A' ? 10 : 4
  probability += syncScore
  probability += Math.max(0, Math.min(15, forecast.score * 0.15))
  if (forecast.realBook) probability += 10
  if (alignedBias) probability += 8
  if (alignedEvent) probability += 8
  if (wallAligned) probability += 6
  if (candidate.htfAligned) probability += 7
  probability += phase === 'IMPULSE_UP' || phase === 'DISTRIBUTION' ? 7 : 5
  if (flowAligned && moveAligned) probability += 5
  if (btcState === 'NEUTRAL') probability += 4
  if (phase === 'RANGE' && rangeBoundary) probability += 4
  const directionScore =
    (alignedBias ? 25 : 0) +
    (alignedEvent ? 25 : 0) +
    (flowAligned ? 20 : 0) +
    (moveAligned ? 15 : 0) +
    (wallAligned ? 15 : 0)
  if (phase === 'RANGE' && rangeForecastOnly && directionScore < 75) {
    return null
  }
  probability = Math.min(100, Math.round(probability))
  if (tier === 'B' && probability < 72) return null
  if (probability < MIN_SIGNAL_PROBABILITY) return null
  const quality =
    probability >= 85 ? 'PLATINUM' : probability >= 75 ? 'GOLD' : 'SILVER'

  const closed = candles.slice(0, -1).slice(-20)
  const atr =
    closed.reduce(
      (sum, candle) =>
        sum + (candle[4] > 0 ? (candle[2] - candle[3]) / candle[4] : 0),
      0
    ) / Math.max(1, closed.length)
  const volatility = atr > 0.02 ? 'HIGH' : atr < 0.005 ? 'LOW' : 'NORMAL'
  const risk = volatility === 'HIGH' ? 0.007 : volatility === 'LOW' ? 0.0035 : 0.005
  const tp1Pct = 0.01
  const tpPct = volatility === 'HIGH' ? 0.02 : volatility === 'LOW' ? 0.01 : 0.015
  const tp3Pct = tpPct
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
      `Jeweler ${quality} · quality score ${probability}/100 · sync ${syncScore}`,
      `фаза ${phase} · BTC ${btcState} · momentum ${flowAligned && moveAligned ? 'BUILDING' : 'MIXED'}`,
      `направление ${side}: ${directionScore}/100 по forecast+event+tape+walls`,
      `стакан ${forecast.bias} · score ${forecast.score}/100 · OBI ${obi >= 0 ? '+' : ''}${obi.toFixed(0)}%`,
      `bids/asks USD ${ratio.toFixed(2)} · book evidence ${bookEvidence}/5`,
      `свечи tier ${tier}: ${candidate.patterns.slice(0, 5).join(', ')}`,
      alignedEvent ? `событие стакана: ${event.kind}` : 'событие: подтверждение глубиной/OBI',
    ],
    journalReasons: [
      `conf:${probability}`,
      'source:jeweler_burst',
      `quality_score:${probability}`,
      `quality:${quality}`,
      `sync:${syncScore}`,
      `phase:${phase}`,
      `btc:${btcState}`,
      `momentum:${flowAligned && moveAligned ? 'BUILDING' : 'MIXED'}`,
      `direction_score:${directionScore}`,
      `volatility:${volatility}`,
      `pattern_tier:${tier}`,
      `book_score:${forecast.score}`,
      `obi:${Number(obi.toFixed(2))}`,
      `book_ratio:${ratio}`,
      `book_evidence:${bookEvidence}`,
      `book_bias:${forecast.bias}`,
      `book_event:${event.kind}`,
      `patterns:${candidate.patterns.slice(0, 8).join('+')}`,
      'book_ok',
      candidate.htfAligned ? 'structure_ok' : 'structure_weak',
      'quality:A',
    ],
  }
}

/** When both sides confirm, keep only a clear winner so mid-range does not flip-flop. */
export function chooseConfirmedDirection(
  long: MemeDirectionalSignal | null,
  short: MemeDirectionalSignal | null
): { pick: MemeDirectionalSignal | null; reason?: string } {
  if (long && short) {
    if (Math.abs(long.probability - short.probability) < MIN_DIRECTION_GAP) {
      return { pick: null, reason: 'range_direction_ambiguous' }
    }
    return { pick: long.probability >= short.probability ? long : short }
  }
  return { pick: long ?? short ?? null }
}
