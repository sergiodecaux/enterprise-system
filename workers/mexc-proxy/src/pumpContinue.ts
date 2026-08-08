/**
 * PUMP_CONTINUE — LONG the squeeze that used to stop PEAK shorts.
 *
 * Journal dead entries: SHORT near high while fuel still alive → SL above high.
 * Flip: same tape/structure, LONG; former short SL becomes TP.
 */

import type { Candle } from './peakFuelFail'
import {
  atrStopDistance,
  memeRiskStop,
  microStructureLevel,
  type MarketRegime,
} from './marketRegime'
import {
  bullishTriggerCandle,
  chartConfirmLong2m,
  longCandleEntryOk,
} from './candleConfirm'

export interface PumpContinueInput {
  symbol: string
  price: number
  chg24hPct: number
  dayBias: 'PUMP' | 'DUMP' | null
  holdVol?: number | null
  prevHoldVol?: number | null
  candles1m: Candle[]
  buyFlowPct?: number | null
  priceMoveBps?: number | null
  absorptionLong?: boolean
  cvdBullish?: boolean
  bidHeavy?: boolean
  bookConfidence?: number | null
  obi?: number | null
  obiChange?: number | null
  /** Tiny $1–10 asks = crowd bait for shorts */
  shortBaitAsks?: boolean
  crowdAskLevels?: number | null
  bidSupportUsd?: number | null
  /** Large ask wall likely spoof (<3s life) — ignore as resistance */
  spoofAskWall?: boolean
  /** Persistent large ask above — real supply */
  largeAskWall?: boolean
  regime?: MarketRegime | null
  phase?: 'structure' | 'final'
}

export type PumpContinueQuality = 'A' | 'B'

export interface PumpContinueSignal {
  ready: boolean
  side: 'LONG'
  setup: 'PUMP_CONTINUE'
  confidence: number
  quality: PumpContinueQuality
  fuelScore: number
  /** Explicit optimizable score card */
  score: number
  distToHighPct: number
  /** Former PEAK short SL — now the take target */
  formerSlAsTp: number
  limitPrice: number
  sl: number
  tp: number
  tp1: number
  notes: string[]
  reasons: string[]
}

/** Entry threshold — tune this, not gut feel */
const MIN_SCORE = 5
const STRUCTURE_MIN_SCORE = 3
const A_MIN_SCORE = 7
const A_MIN_CHG = 6
const A_MAX_DIST = 1.8
const MIN_CHG = 4
const NEAR_HIGH_PCT = 3.2
const STRUCTURE_NEAR_HIGH_PCT = 4.2
const FORMER_SL_BUF = 0.0025
const FORMER_SL_MIN = 0.01
/** Max risk vs entry — beyond this liq hits first on typical meme leverage */
const MAX_RISK_PCT = 0.011

function recentHigh(candles: Candle[], bars = 40): number {
  let hi = 0
  for (const c of candles.slice(-bars)) hi = Math.max(hi, c[2])
  return hi
}

function recentLow(candles: Candle[], bars = 20): number {
  let lo = Number.POSITIVE_INFINITY
  for (const c of candles.slice(-bars)) lo = Math.min(lo, c[3])
  return Number.isFinite(lo) ? lo : 0
}

/** Same impulse that made PEAK shorts toxic. */
function stillFueledImpulse(candles: Candle[], hi: number): boolean {
  if (candles.length < 6 || !(hi > 0)) return false
  const closed = candles.slice(0, -1).slice(-5)
  if (closed.length < 4) return false
  let green = 0
  let netPct = 0
  for (const c of closed) {
    const [, o, , , cl] = c
    if (cl > o) green++
    netPct += ((cl - o) / o) * 100
  }
  const last = closed[closed.length - 1]!
  const nearHigh = last[4] >= hi * 0.992
  const range = last[2] - last[3]
  const body = Math.abs(last[4] - last[1])
  const strongGreen =
    last[4] > last[1] &&
    range > 0 &&
    body / range >= 0.5 &&
    last[4] >= last[2] * 0.98
  return nearHigh && ((green >= 3 && netPct >= 0.7) || (strongGreen && netPct >= 0.35))
}

function higherHighBreak(candles: Candle[]): boolean {
  if (candles.length < 8) return false
  const closed = candles.slice(0, -1)
  const last = closed[closed.length - 1]
  if (!last) return false
  const prior = closed.slice(-8, -1)
  if (prior.length < 3) return false
  const priorHigh = Math.max(...prior.map((c) => c[2]))
  return last[2] > priorHigh * 1.0005 && last[4] >= priorHigh * 0.999
}

/** Soft "fake fade" — wick/stall that used to look like short, but buyers reclaim. */
function fakeFadeReclaim(candles: Candle[], hi: number): boolean {
  if (!(hi > 0) || candles.length < 6) return false
  const a = candles[candles.length - 3]
  const b = candles[candles.length - 2]
  if (!a || !b) return false
  const rangeA = a[2] - a[3]
  if (!(rangeA > 0)) return false
  const upper = a[2] - Math.max(a[1], a[4])
  const wickReject = upper >= rangeA * 0.28
  const reclaim =
    b[4] > b[1] &&
    b[4] >= a[4] &&
    b[4] >= hi * 0.988
  return wickReject && reclaim
}

export function detectPumpContinue(
  input: PumpContinueInput
): PumpContinueSignal | null {
  const price = input.price
  if (!(price > 0) || input.candles1m.length < 20) return null
  const structurePhase = input.phase === 'structure'
  const minScore = structurePhase ? STRUCTURE_MIN_SCORE : MIN_SCORE
  const maxDist = structurePhase ? STRUCTURE_NEAR_HIGH_PCT : NEAR_HIGH_PCT

  const pumpDay = input.dayBias === 'PUMP' || input.chg24hPct >= MIN_CHG
  if (!pumpDay) return null
  if (input.chg24hPct < MIN_CHG) return null

  const hi = recentHigh(input.candles1m, 40)
  const lo = recentLow(input.candles1m, 18)
  if (!(hi > 0)) return null

  const distPct = ((hi - price) / hi) * 100
  // Same window where PEAK shorts entered and got squeezed
  if (distPct > maxDist || distPct < -0.35) return null

  const impulse = stillFueledImpulse(input.candles1m, hi)
  const hh = higherHighBreak(input.candles1m)
  const reclaim = fakeFadeReclaim(input.candles1m, hi)
  const bullish = bullishTriggerCandle(input.candles1m)
  if (!(impulse || hh || reclaim || bullish)) return null

  // ── Score card (optimizable) ──────────────────────────────────────
  let score = 0
  const notes: string[] = []
  const reasons: string[] = []
  const formerSl = Math.max(hi * (1 + FORMER_SL_BUF), price * (1 + FORMER_SL_MIN))
  reasons.push(`former_sl_tp:${formerSl.toPrecision(6)}`)

  if (hh) {
    score += 2
    notes.push('HH break +2')
    reasons.push('higher_high_break', 'score:+2:hh')
  }
  if (reclaim) {
    score += 2
    notes.push('Reclaim +2')
    reasons.push('fake_fade_reclaim', 'score:+2:reclaim')
  }
  if (impulse) {
    score += 2
    notes.push('Impulse +2')
    reasons.push('fueled_impulse', 'score:+2:impulse')
  }
  if (bullish) {
    score += 1
    reasons.push('bullish_trigger', 'score:+1:bullish')
  }

  let oiRising = false
  const hv = input.holdVol
  const prev = input.prevHoldVol
  if (hv != null && prev != null && prev > 0) {
    const oiChg = ((hv - prev) / prev) * 100
    if (Math.abs(oiChg) > 12) {
      reasons.push(`oi_glitch:${oiChg.toFixed(1)}`)
    } else if (oiChg >= 0.5) {
      score += 1
      oiRising = true
      notes.push(`OI +${oiChg.toFixed(2)}% +1`)
      reasons.push(`oi_rising:${oiChg.toFixed(2)}`, 'score:+1:oi')
    } else if (oiChg < -0.4) {
      score -= 1
      reasons.push(`oi_falling:${oiChg.toFixed(2)}`, 'score:-1:oi')
    } else {
      reasons.push(`oi_flat:${oiChg.toFixed(2)}`)
    }
  } else {
    reasons.push('oi_unknown')
  }

  const buyFlow = input.buyFlowPct
  const moveBps = input.priceMoveBps
  let tapeUp = false
  if (buyFlow != null && moveBps != null && buyFlow >= 55 && moveBps >= 4) {
    score += 1
    tapeUp = true
    notes.push(`Delta/tape up +1`)
    reasons.push(
      `tape_up:buy${buyFlow.toFixed(0)}_bps${moveBps.toFixed(0)}`,
      'score:+1:delta'
    )
  } else if (moveBps != null && moveBps >= 10) {
    score += 1
    tapeUp = true
    reasons.push(`tape_up:${moveBps.toFixed(0)}bps`, 'score:+1:delta')
  } else if (
    buyFlow != null &&
    buyFlow <= 40 &&
    moveBps != null &&
    moveBps <= -6
  ) {
    score -= 2
    reasons.push('score:-2:sell_tape')
  }

  const bookConfidence = input.bookConfidence ?? 0
  const obi = input.obi ?? 0
  const obiChange = input.obiChange ?? 0
  const shortBait = Boolean(input.shortBaitAsks)
  const crowdN = input.crowdAskLevels ?? 0
  const bidSupport = input.bidSupportUsd ?? 0
  const bidHeavyStrong =
    Boolean(input.bidHeavy) &&
    (obi >= 12 || obiChange >= 3) &&
    bookConfidence >= 62

  // 2m candle confirm — required for A / live entry
  const chartOk = chartConfirmLong2m(input.candles1m)
  const candleEntry = longCandleEntryOk(input.candles1m)
  if (chartOk) {
    score += 2
    notes.push('2m свечи LONG +2')
    reasons.push('chart_confirm_2m', 'chart_ok', 'score:+2:chart2m')
  } else {
    reasons.push('chart_wait_2m', 'candle_confirm_missing')
  }
  if (candleEntry) {
    reasons.push('candle_entry_ok')
  }

  if (input.cvdBullish) {
    score += 1
    notes.push('CVD bull +1')
    reasons.push('cvd_bullish', 'score:+1:cvd')
  }
  if (input.absorptionLong) {
    score += 1
    notes.push('Bid absorption +1')
    reasons.push('bid_absorption', 'score:+1:abs')
  }
  if (bidHeavyStrong || (Boolean(input.bidHeavy) && obi >= 14)) {
    score += 1
    notes.push('Bid imbalance +1')
    reasons.push(
      bidHeavyStrong ? 'bid_heavy_strong' : 'bid_heavy',
      'score:+1:obi'
    )
  }
  if (shortBait) {
    score += 1
    notes.push(`Crowd asks bait n${crowdN} +1`)
    reasons.push(`crowd_asks_bait:n${crowdN}`, 'score:+1:bait')
  }
  if (bidSupport >= 200) {
    score += 1
    reasons.push(`bid_support:${bidSupport.toFixed(0)}`, 'score:+1:bid_sup')
  }

  // Penalties
  if (input.largeAskWall && !input.spoofAskWall) {
    score -= 2
    notes.push('Large ask wall −2')
    reasons.push('large_ask_wall', 'score:-2:ask_wall')
  }
  if (input.spoofAskWall) {
    reasons.push('spoof_ask_ignored')
  }
  if (obi <= -18) {
    score -= 1
    reasons.push('score:-1:ask_obi')
  }

  reasons.push(`dist_high:${distPct.toFixed(2)}`)
  reasons.push(`chg24:${input.chg24hPct.toFixed(1)}`)
  reasons.push(`score:${score}`)
  reasons.push(structurePhase ? 'phase:structure' : 'phase:final')

  if (score < minScore) {
    reasons.push(`score_fail:${score}<${minScore}`)
    return null
  }

  const realBook = Boolean(
    input.absorptionLong || input.cvdBullish || bidHeavyStrong
  )
  const pressureOk = Boolean(
    realBook ||
      (tapeUp && buyFlow != null && buyFlow >= 55) ||
      (Boolean(input.bidHeavy) && obi >= 12 && (tapeUp || oiRising)) ||
      (structurePhase && (impulse || hh || reclaim) && bullish)
  )
  const bookConfirm = Boolean(
    realBook ||
      (shortBait && Boolean(input.bidHeavy) && (tapeUp || oiRising)) ||
      (tapeUp && oiRising)
  )
  const strongBook = Boolean(
    input.absorptionLong ||
      input.cvdBullish ||
      (bidHeavyStrong && (obi >= 16 || bookConfidence >= 72))
  )

  let confidence = 60 + score * 4
  if (pressureOk) confidence += 4
  if (bookConfirm) confidence += 3
  if (strongBook) confidence += 3
  if (distPct <= 0.6) confidence += 2
  if (input.chg24hPct >= 15) confidence += 2
  if (!pressureOk && !structurePhase) confidence -= 6
  confidence = Math.min(94, Math.max(0, Math.round(confidence)))

  // A = score + book + candle confirm (no naked book entries)
  const aTier =
    score >= A_MIN_SCORE &&
    bookConfirm &&
    pressureOk &&
    candleEntry &&
    chartOk &&
    (impulse || hh || reclaim) &&
    (bullish || hh) &&
    distPct <= A_MAX_DIST &&
    input.chg24hPct >= A_MIN_CHG &&
    confidence >= 70

  const quality: PumpContinueQuality = aTier ? 'A' : 'B'
  reasons.push(`quality:${quality}`)
  reasons.push(`fuel:${score}`)
  reasons.push(`conf:${confidence}`)
  reasons.push(pressureOk ? 'pressure_ok' : 'pressure_missing')
  reasons.push(bookConfirm ? 'book_ok' : 'book_missing')
  reasons.push(strongBook ? 'squeeze_confirmed' : 'squeeze_unconfirmed')
  reasons.push(chartOk ? 'chart_ok' : 'chart_early')
  reasons.push(candleEntry ? 'candle_entry_ok' : 'candle_entry_wait')
  reasons.push('continue_ok')

  // Final phase without candle confirm stays B-only candidate (pending next bars)
  if (!structurePhase && !candleEntry) {
    reasons.push('final_needs_candle')
  }

  const entry = price
  // Tight ATR/micro stop only — deep 18-bar low was putting SL at −5%+ (liq first)
  const atrDist = atrStopDistance(input.candles1m, entry, 1.15, 0.0045, MAX_RISK_PCT)
  const microLo = microStructureLevel(input.candles1m, 'LONG')
  const stop = memeRiskStop(entry, 'LONG', atrDist, microLo, {
    minPct: 0.0045,
    maxPct: MAX_RISK_PCT,
  })
  if (!stop) {
    reasons.push('sl_structure_too_wide')
    return null
  }
  reasons.push(...stop.reasons)
  const sl = stop.sl
  const risk = Math.max(entry - sl, entry * 0.0045)
  // Pure R-based targets from CURRENT entry — never former short-SL absolute
  const tp1 = entry + risk * 1.15
  const tp = entry + risk * 2.2
  if (tp1 <= entry) return null

  return {
    ready: true,
    side: 'LONG',
    setup: 'PUMP_CONTINUE',
    confidence,
    quality,
    fuelScore: score,
    score,
    distToHighPct: distPct,
    formerSlAsTp: formerSl,
    limitPrice: entry,
    sl,
    tp,
    tp1,
    notes: [
      `PUMP_CONTINUE LONG · score ${score}/${MIN_SCORE}`,
      `24h +${input.chg24hPct.toFixed(1)}% · к хаю −${distPct.toFixed(2)}% · conf ${confidence}`,
      `Risk ${(stop.riskPct * 100).toFixed(2)}% · TP1 +${((tp1 / entry - 1) * 100).toFixed(2)}% · TP +${((tp / entry - 1) * 100).toFixed(2)}%`,
      ...notes.slice(0, 3),
    ],
    reasons,
  }
}
