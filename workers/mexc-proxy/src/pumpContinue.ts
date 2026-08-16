/**
 * PUMP_CONTINUE — Elite LONG: catch fueled meme pumps near the high.
 *
 * Autopsy (journal CONT_/PUMP LONGs):
 * - CONT_* ~58% WR; CONT_ABSORPTION best; TRAP_FLIP ~10% toxic
 * - Losses are mostly DEAD (MFE&lt;0.35%) — entered without follow-through
 * - Inverse of PEAK SHORT: need rising OI / bid pressure, not flat fuel
 *
 * A-tier (TG): impulse|HH + (OI↑ or real book) + 2m candle confirm · near high.
 */

import type { Candle } from './peakFuelFail'
import {
  atrStopDistance,
  memeRiskStop,
  microStructureLevel,
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
  /** True only when flow/move come from live book */
  tapeFromBook?: boolean
  absorptionLong?: boolean
  cvdBullish?: boolean
  bidHeavy?: boolean
  bookConfidence?: number | null
  /** Precomputed book forecast (manipulation-aware) */
  bookForecast?: {
    score: number
    realBook: boolean
    strongTape: boolean
    toxic: boolean
    obiAligned?: boolean
    bias: string
    reasons: string[]
  } | null
  phase?: 'structure' | 'final'
  /** Meme lifecycle gates */
  memeRegime?: import('./memeRegimeDetector').MemeRegime | null
  memeAgeMinutes?: number | null
  exhaustion?: number | null
  ageGateOk?: boolean
  volRatio?: number | null
  decayRate?: 'FAST' | 'NORMAL' | 'SLOW' | null
}

export type PumpContinueQuality = 'A' | 'B'

export interface PumpContinueSignal {
  ready: boolean
  side: 'LONG'
  setup: 'PUMP_CONTINUE'
  confidence: number
  quality: PumpContinueQuality
  fuelScore: number
  score: number
  distToHighPct: number
  formerSlAsTp: number
  limitPrice: number
  sl: number
  tp: number
  tp1: number
  notes: string[]
  reasons: string[]
}

const MIN_SCORE = 4
const A_MIN_SCORE = 6
const A_MIN_CHG = 7
const A_MAX_CHG = 80
const A_MAX_DIST = 1.85
const MIN_CHG = 4
const NEAR_HIGH_PCT = 3.5
const FORMER_SL_BUF = 0.0025
const FORMER_SL_MIN = 0.01
const MAX_RISK_PCT = 0.011
/** Avoid STAR-style noise stops — micro 0.45% dies before dead-cut */
const MIN_RISK_PCT = 0.0075
const A_MIN_CONF = 62
const A_BOOK_MIN_SCORE = 48
/** Debug only — not a hard A gate (classic restore) */
const A_MAX_EXHAUSTION = 70

function recentHigh(candles: Candle[], bars = 40): number {
  let hi = 0
  for (const c of candles.slice(-bars)) hi = Math.max(hi, c[2])
  return hi
}

/** Same impulse that made PEAK shorts toxic — green hold under high. */
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

/** Micro dip then reclaim near high — CONT_BOOK_RELEASE style, not tip chase. */
function microDipReclaim(candles: Candle[], hi: number): boolean {
  if (!(hi > 0) || candles.length < 8) return false
  const closed = candles.slice(0, -1).slice(-6)
  if (closed.length < 5) return false
  const last = closed[closed.length - 1]!
  let dipIdx = -1
  let dipLow = Number.POSITIVE_INFINITY
  for (let i = 0; i < closed.length - 1; i++) {
    const c = closed[i]!
    if (c[3] < dipLow) {
      dipLow = c[3]
      dipIdx = i
    }
  }
  if (dipIdx < 0 || !(dipLow > 0)) return false
  const dipDepth = ((hi - dipLow) / hi) * 100
  if (dipDepth < 0.35 || dipDepth > 2.8) return false
  const reclaim =
    last[4] > last[1] &&
    last[4] >= hi * 0.988 &&
    last[4] > dipLow * 1.004
  return reclaim
}

export function detectPumpContinue(
  input: PumpContinueInput
): PumpContinueSignal | null {
  const price = input.price
  if (!(price > 0) || input.candles1m.length < 20) return null

  const pumpDay = input.dayBias === 'PUMP' || input.chg24hPct >= MIN_CHG
  if (!pumpDay || input.chg24hPct < MIN_CHG) return null

  const hi = recentHigh(input.candles1m, 40)
  if (!(hi > 0)) return null

  const distPct = ((hi - price) / hi) * 100
  if (distPct > NEAR_HIGH_PCT || distPct < -0.35) return null

  const impulse = stillFueledImpulse(input.candles1m, hi)
  const hh = higherHighBreak(input.candles1m)
  const dipReclaim = microDipReclaim(input.candles1m, hi)
  const bullish = bullishTriggerCandle(input.candles1m)
  const chartOk = chartConfirmLong2m(input.candles1m)
  const candleEntry = longCandleEntryOk(input.candles1m)

  // v2.6: allow dip-reclaim or bullish alone (was reclaim∧bullish only)
  if (!(impulse || hh || dipReclaim || bullish)) return null

  let score = 0
  const notes: string[] = []
  const reasons: string[] = []
  const formerSl = Math.max(hi * (1 + FORMER_SL_BUF), price * (1 + FORMER_SL_MIN))
  reasons.push(`former_sl_tp:${formerSl.toPrecision(6)}`)

  if (hh) {
    score += 2
    notes.push('HH break')
    reasons.push('higher_high_break', 'score:+2:hh')
  }
  if (impulse) {
    score += 2
    notes.push('Fueled impulse')
    reasons.push('fueled_impulse', 'score:+2:impulse')
  }
  if (dipReclaim) {
    score += 2
    notes.push('Dip reclaim у хая')
    reasons.push('micro_dip_reclaim', 'score:+2:reclaim')
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
    } else if (oiChg >= 0.45) {
      score += 2
      oiRising = true
      notes.push(`OI +${oiChg.toFixed(2)}%`)
      reasons.push(`oi_rising:${oiChg.toFixed(2)}`, 'score:+2:oi')
    } else if (oiChg < -0.35) {
      score -= 2
      reasons.push(`oi_falling:${oiChg.toFixed(2)}`, 'score:-2:oi')
    } else {
      score -= 1
      reasons.push(`oi_flat:${oiChg.toFixed(2)}`, 'score:-1:oi_flat')
    }
  } else {
    reasons.push('oi_unknown')
  }

  const buyFlow = input.buyFlowPct
  const moveBps = input.priceMoveBps
  let tapeUp = false
  if (
    input.tapeFromBook &&
    buyFlow != null &&
    moveBps != null &&
    buyFlow >= 55 &&
    moveBps >= 4
  ) {
    score += 2
    tapeUp = true
    notes.push(`Tape up buy${buyFlow.toFixed(0)}`)
    reasons.push(
      `tape_up:buy${buyFlow.toFixed(0)}_bps${moveBps.toFixed(0)}`,
      'score:+2:delta'
    )
  } else if (input.tapeFromBook && moveBps != null && moveBps >= 10) {
    score += 1
    tapeUp = true
    reasons.push(`tape_up:${moveBps.toFixed(0)}bps`, 'score:+1:delta')
  } else if (
    input.tapeFromBook &&
    buyFlow != null &&
    buyFlow <= 40 &&
    moveBps != null &&
    moveBps <= -6
  ) {
    score -= 2
    reasons.push('score:-2:sell_tape')
  }

  const bookConfidence = input.bookConfidence ?? 0
  const bidHeavyStrong =
    Boolean(input.bidHeavy) && bookConfidence >= 0.55
  const realBook = Boolean(
    input.absorptionLong || input.cvdBullish || bidHeavyStrong
  )

  if (chartOk) {
    score += 2
    notes.push('2m LONG confirm')
    reasons.push('chart_confirm_2m', 'chart_ok', 'score:+2:chart2m')
  } else {
    reasons.push('chart_wait_2m', 'candle_confirm_missing')
  }
  if (candleEntry) reasons.push('candle_entry_ok')
  else reasons.push('candle_entry_wait')

  if (input.cvdBullish) {
    score += 1
    notes.push('CVD bull')
    reasons.push('cvd_bullish', 'score:+1:cvd')
  }
  if (input.absorptionLong) {
    score += 2
    notes.push('Bid absorption')
    reasons.push('bid_absorption', 'score:+2:abs')
  }
  if (bidHeavyStrong) {
    score += 1
    reasons.push('bid_heavy_strong', 'score:+1:obi')
  }

  reasons.push(`dist_high:${distPct.toFixed(2)}`)
  reasons.push(`chg24:${input.chg24hPct.toFixed(1)}`)
  reasons.push(`score:${score}`)

  if (score < MIN_SCORE) {
    reasons.push(`score_fail:${score}<${MIN_SCORE}`)
    return null
  }

  const fuelAlive = oiRising || realBook || tapeUp
  const structureOk = impulse || hh || (dipReclaim && (oiRising || realBook))
  const pressureOk = Boolean(
    realBook ||
      (tapeUp && buyFlow != null && buyFlow >= 55) ||
      (oiRising && (impulse || hh))
  )

  let confidence = 62 + score * 3
  if (pressureOk) confidence += 4
  if (realBook) confidence += 4
  if (oiRising) confidence += 4
  if (distPct <= 0.55) confidence += 2
  if (input.chg24hPct >= 12 && input.chg24hPct <= 35) confidence += 3
  if (input.chg24hPct > A_MAX_CHG) confidence -= 6
  if (!fuelAlive) confidence -= 8
  if (!chartOk) confidence -= 6
  confidence = Math.min(94, Math.max(0, Math.round(confidence)))

  // v2.8: A requires real book forecast (absorb/CVD/OBI build) — not tape-only.
  // STAR autopsy: strong_tape + OI↑ + MFE0 → SL; memes manipulate tape without depth.
  const forecast = input.bookForecast
  const strongTape = Boolean(
    forecast?.strongTape ||
      (input.tapeFromBook &&
        buyFlow != null &&
        buyFlow >= 55 &&
        moveBps != null &&
        moveBps >= 3)
  )
  const forecastReal = Boolean(forecast?.realBook)
  const realBookGate = realBook || forecastReal
  const bookToxic = Boolean(forecast?.toxic)
  const bookScore = forecast?.score ?? (realBook ? 70 : strongTape ? 45 : 20)
  const bookBias = forecast?.bias ?? 'CHOP'
  if (forecast?.reasons?.length) {
    for (const r of forecast.reasons.slice(0, 6)) reasons.push(`bk:${r}`)
  }
  if (bookToxic) {
    confidence -= 18
    reasons.push('book_toxic')
  } else if (realBookGate) {
    confidence += 6
  } else if (strongTape) {
    confidence -= 4
    reasons.push('tape_only_no_depth')
  }
  confidence = Math.min(94, Math.max(0, Math.round(confidence)))

  const regime = input.memeRegime ?? null
  const ageMin = input.memeAgeMinutes ?? 0
  const exhaustion = input.exhaustion ?? 50
  const volRatio = input.volRatio ?? 1
  // Debug tags only — classic path does not hard-block on regime/age/exh
  if (regime) reasons.push(`regime:${regime}`)
  reasons.push(`age_m:${ageMin}`)
  reasons.push(`exh:${exhaustion}`)
  if (input.decayRate) reasons.push(`decay:${input.decayRate}`)

  if (exhaustion <= A_MAX_EXHAUSTION) confidence = Math.min(94, confidence + 3)
  if (input.decayRate === 'SLOW') confidence = Math.min(94, confidence + 3)
  if (volRatio >= 0.45) confidence = Math.min(94, confidence + 2)
  if (input.absorptionLong) confidence = Math.min(94, confidence + 4)

  const confirmA =
    (candleEntry || chartOk || bullish) && (bullish || impulse || hh || dipReclaim)
  const bookAllowsA =
    !bookToxic &&
    (realBookGate || Boolean(input.absorptionLong) || Boolean(input.bidHeavy)) &&
    bookScore >= A_BOOK_MIN_SCORE &&
    (bookBias === 'NEXT_UP' ||
      Boolean(input.absorptionLong) ||
      (realBookGate && bookScore >= 55) ||
      Boolean(input.bidHeavy && bookScore >= 48))
  const chgOk = input.chg24hPct >= Math.min(A_MIN_CHG, 5) || input.chg24hPct >= 4
  const aTier =
    structureOk &&
    fuelAlive &&
    pressureOk &&
    bookAllowsA &&
    confirmA &&
    (impulse || hh || dipReclaim || (bullish && realBookGate) || input.absorptionLong) &&
    score >= A_MIN_SCORE &&
    confidence >= A_MIN_CONF &&
    distPct >= 0.08 &&
    distPct <= A_MAX_DIST &&
    chgOk &&
    input.chg24hPct <= A_MAX_CHG

  const quality: PumpContinueQuality = aTier ? 'A' : 'B'
  reasons.push(`quality:${quality}`)
  reasons.push(`fuel:${score}`)
  reasons.push(`conf:${confidence}`)
  reasons.push(pressureOk ? 'pressure_ok' : 'pressure_missing')
  reasons.push(fuelAlive ? 'fuel_alive' : 'fuel_dead')
  reasons.push(
    realBookGate
      ? 'book_ok'
      : strongTape
        ? 'book_weak:strong_tape'
        : input.tapeFromBook
          ? 'book_weak'
          : 'book_missing'
  )
  reasons.push(`book_score:${bookScore}`)
  reasons.push(`book_bias:${bookBias}`)
  reasons.push(structureOk ? 'structure_ok' : 'structure_weak')
  reasons.push(chartOk ? 'chart_ok' : 'chart_early')
  reasons.push(candleEntry ? 'candle_entry_ok' : 'candle_entry_wait')
  reasons.push('continue_ok')

  const entry = price
  const atrDist = atrStopDistance(
    input.candles1m,
    entry,
    1.15,
    MIN_RISK_PCT,
    MAX_RISK_PCT
  )
  const microLo = microStructureLevel(input.candles1m, 'LONG')
  const stop = memeRiskStop(entry, 'LONG', atrDist, microLo, {
    minPct: MIN_RISK_PCT,
    maxPct: MAX_RISK_PCT,
  })
  if (!stop) {
    reasons.push('sl_structure_too_wide')
    return null
  }
  reasons.push(...stop.reasons)
  const sl = stop.sl
  // Binary: SL or +2% price (40% ROE @ ×20) — no partial TP1
  const TP_PRICE_PCT = 0.02
  const tp = entry * (1 + TP_PRICE_PCT)
  const tp1 = tp
  if (!(tp > entry)) return null

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
      `PUMP LONG · squeeze/continue · класс ${quality}`,
      `24h +${input.chg24hPct.toFixed(1)}% · к хаю −${distPct.toFixed(2)}% · score ${score} · conf ${confidence}`,
      `Стакан score ${bookScore} · ${bookBias} · ${realBookGate ? 'realBook' : 'no realBook'} · Risk ${(stop.riskPct * 100).toFixed(2)}% · TP +2.0% ≈ +40% @ ×20`,
      ...notes.slice(0, 3),
    ],
    reasons,
  }
}
