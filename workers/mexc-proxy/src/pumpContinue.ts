/**
 * PUMP_CONTINUE — LONG the squeeze that used to stop PEAK shorts.
 *
 * Journal dead entries: SHORT near high while fuel still alive → SL above high.
 * Flip: same tape/structure, LONG; former short SL becomes TP.
 */

import type { Candle } from './peakFuelFail'

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
}

export type PumpContinueQuality = 'A' | 'B'

export interface PumpContinueSignal {
  ready: boolean
  side: 'LONG'
  setup: 'PUMP_CONTINUE'
  confidence: number
  quality: PumpContinueQuality
  fuelScore: number
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

const A_MIN_CONF = 72
const A_MIN_FUEL = 2
const A_MIN_CHG = 6
const A_MAX_DIST = 1.8
const MIN_CHG = 4
const NEAR_HIGH_PCT = 2.5
/** Same formula PEAK short used for SL */
const FORMER_SL_BUF = 0.0025
const FORMER_SL_MIN = 0.01

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

function bullishTrigger(candles: Candle[]): boolean {
  const c = candles[candles.length - 2]
  if (!c) return false
  const [, o, h, l, cl] = c
  const range = h - l
  if (!(range > 0)) return false
  return cl > o * 1.0005 && (cl - l) / range >= 0.55
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

function chartConfirmLong2m(candles: Candle[]): boolean {
  // Need 2 closed 1m bars agreeing — don't chase the first tick of a spike
  const closed = candles.slice(0, -1).slice(-2)
  if (closed.length < 2) return false
  const [a, b] = closed
  if (!a || !b) return false
  const green = (c: Candle) => c[4] > c[1]
  const higherClose = b[4] >= a[4] * 0.9995
  const higherLow = b[3] >= a[3] * 0.998
  const notDumpBar =
    b[4] >= b[1] * 0.997 || (b[4] - b[3]) / Math.max(b[2] - b[3], 1e-12) >= 0.45
  return (green(a) || green(b)) && higherClose && higherLow && notDumpBar
}

export function detectPumpContinue(
  input: PumpContinueInput
): PumpContinueSignal | null {
  const price = input.price
  if (!(price > 0) || input.candles1m.length < 20) return null

  const pumpDay = input.dayBias === 'PUMP' || input.chg24hPct >= MIN_CHG
  if (!pumpDay) return null
  if (input.chg24hPct < MIN_CHG) return null

  const hi = recentHigh(input.candles1m, 40)
  const lo = recentLow(input.candles1m, 18)
  if (!(hi > 0)) return null

  const distPct = ((hi - price) / hi) * 100
  // Same window where PEAK shorts entered and got squeezed
  if (distPct > NEAR_HIGH_PCT || distPct < -0.35) return null

  const impulse = stillFueledImpulse(input.candles1m, hi)
  const hh = higherHighBreak(input.candles1m)
  const reclaim = fakeFadeReclaim(input.candles1m, hi)
  const bullish = bullishTrigger(input.candles1m)
  if (!(impulse || hh || reclaim || bullish)) return null

  let fuelScore = 0
  const notes: string[] = []
  const reasons: string[] = []

  // Former PEAK short SL — now TP
  const formerSl = Math.max(hi * (1 + FORMER_SL_BUF), price * (1 + FORMER_SL_MIN))
  reasons.push(`former_sl_tp:${formerSl.toPrecision(6)}`)

  if (impulse) {
    fuelScore += 2
    notes.push('Импульс вверх у хая — бывший SL-шорт')
    reasons.push('fueled_impulse')
  }
  if (hh) {
    fuelScore += 2
    notes.push('Пробой локального хая (сквиз)')
    reasons.push('higher_high_break')
  }
  if (reclaim) {
    fuelScore += 2
    notes.push('Ложный fade → reclaim (dead short → long)')
    reasons.push('fake_fade_reclaim')
  }
  if (bullish) {
    fuelScore += 1
    notes.push('Бычья закрытая свеча')
    reasons.push('bullish_trigger')
  }

  let oiRising = false
  const hv = input.holdVol
  const prev = input.prevHoldVol
  if (hv != null && prev != null && prev > 0) {
    const oiChg = ((hv - prev) / prev) * 100
    if (Math.abs(oiChg) > 25) {
      reasons.push(`oi_glitch:${oiChg.toFixed(1)}`)
    } else if (oiChg >= 0.5) {
      fuelScore += 2
      oiRising = true
      notes.push(`OI растёт +${oiChg.toFixed(2)}% — топливо живое`)
      reasons.push(`oi_rising:${oiChg.toFixed(2)}`)
    } else if (oiChg >= 0) {
      fuelScore += 1
      reasons.push(`oi_flat:${oiChg.toFixed(2)}`)
    } else {
      reasons.push(`oi_falling:${oiChg.toFixed(2)}`)
    }
  } else {
    reasons.push('oi_unknown')
  }

  const buyFlow = input.buyFlowPct
  const moveBps = input.priceMoveBps
  let tapeUp = false
  if (buyFlow != null && moveBps != null && buyFlow >= 55 && moveBps >= 4) {
    fuelScore += 2
    tapeUp = true
    notes.push(
      `Покупки ${buyFlow.toFixed(0)}% двигают цену (+${moveBps.toFixed(0)}bps)`
    )
    reasons.push(`tape_up:buy${buyFlow.toFixed(0)}_bps${moveBps.toFixed(0)}`)
  } else if (moveBps != null && moveBps >= 8) {
    fuelScore += 1
    tapeUp = true
    reasons.push(`tape_up:${moveBps.toFixed(0)}bps`)
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
  const chartOk = chartConfirmLong2m(input.candles1m)
  if (chartOk) {
    fuelScore += 1
    notes.push('2м график подтвердил LONG (закрытые свечи)')
    reasons.push('chart_confirm_2m')
  } else {
    reasons.push('chart_wait_2m')
  }

  // Real book pressure — crowd bait alone is only a hint, not A-tier
  const realBook = Boolean(
    input.absorptionLong || input.cvdBullish || bidHeavyStrong
  )
  const pressureOk = Boolean(
    realBook ||
      (tapeUp && buyFlow != null && buyFlow >= 58 && (moveBps ?? 0) >= 5) ||
      (Boolean(input.bidHeavy) && obi >= 12 && (tapeUp || oiRising) && shortBait)
  )
  const bookConfirm = Boolean(
    realBook ||
      (shortBait && Boolean(input.bidHeavy) && (tapeUp || oiRising) && obi >= 10)
  )
  const strongBook = Boolean(
    input.absorptionLong ||
      input.cvdBullish ||
      (bidHeavyStrong && (obi >= 16 || bookConfidence >= 72))
  )
  if (input.absorptionLong) {
    fuelScore += 2
    notes.push('Bid поглощает продажи')
    reasons.push('bid_absorption')
  }
  if (input.cvdBullish) {
    fuelScore += 1
    notes.push('CVD бычий')
    reasons.push('cvd_bullish')
  }
  if (input.bidHeavy) {
    fuelScore += 1
    notes.push('Стакан в bids')
    reasons.push(bidHeavyStrong ? 'bid_heavy_strong' : 'bid_heavy')
  }
  if (shortBait) {
    fuelScore += 2
    notes.push(
      `Толпа в asks: ${crowdN} мелких заявок $1–10 — приманка для шортов`
    )
    reasons.push(`crowd_asks_bait:n${crowdN}`)
  } else if (crowdN >= 2) {
    reasons.push(`crowd_asks_weak:n${crowdN}`)
  }
  if (bidSupport >= 200) {
    fuelScore += 1
    reasons.push(`bid_support:${bidSupport.toFixed(0)}`)
  }

  reasons.push(`dist_high:${distPct.toFixed(2)}`)
  reasons.push(`chg24:${input.chg24hPct.toFixed(1)}`)

  // Flip thesis: fueled impulse / HH / reclaim near high = former short SL zone
  const shortTrap =
    shortBait || reclaim || hh || impulse || (bullish && (oiRising || tapeUp))

  const continueOk =
    shortTrap &&
    (impulse ||
      hh ||
      reclaim ||
      shortBait ||
      (bullish && (oiRising || tapeUp || bookConfirm)))

  if (!continueOk) return null

  let confidence = 64 + fuelScore * 3
  if (impulse) confidence += 4
  if (hh) confidence += 5
  if (reclaim) confidence += 4
  if (shortBait) confidence += 6
  if (pressureOk) confidence += 5
  if (bookConfirm) confidence += 4
  if (strongBook) confidence += 3
  if (tapeUp) confidence += 3
  if (oiRising) confidence += 3
  if (distPct <= 0.6) confidence += 2
  if (input.chg24hPct >= 15) confidence += 2
  if (!pressureOk) confidence -= 8
  if (!shortTrap) confidence -= 8
  confidence = Math.min(94, Math.max(0, Math.round(confidence)))
  if (confidence < 68) return null

  // A only after chart 2m + real book/tape — never first-tick chase
  const aTier =
    continueOk &&
    chartOk &&
    pressureOk &&
    shortTrap &&
    bookConfirm &&
    (strongBook || realBook) &&
    (impulse || hh || reclaim) &&
    (bullish || tapeUp || oiRising || input.absorptionLong) &&
    confidence >= A_MIN_CONF &&
    fuelScore >= A_MIN_FUEL &&
    distPct <= A_MAX_DIST &&
    input.chg24hPct >= A_MIN_CHG

  const quality: PumpContinueQuality = aTier ? 'A' : 'B'
  reasons.push(`quality:${quality}`)
  reasons.push(`fuel:${fuelScore}`)
  reasons.push(`conf:${confidence}`)
  reasons.push(continueOk ? 'continue_ok' : 'continue_weak')
  reasons.push(pressureOk ? 'pressure_ok' : 'pressure_missing')
  reasons.push(shortTrap ? 'short_trap' : 'no_short_trap')
  reasons.push(bookConfirm ? 'book_ok' : 'book_missing')
  reasons.push(strongBook ? 'squeeze_confirmed' : 'squeeze_unconfirmed')
  reasons.push(chartOk ? 'chart_ok' : 'chart_early')

  const entry = price
  const tp = formerSl
  const tp1 = entry + (tp - entry) * 0.65
  const sl = Math.min(
    lo > 0 ? lo * 0.997 : entry * 0.99,
    entry * (1 - FORMER_SL_MIN)
  )

  return {
    ready: true,
    side: 'LONG',
    setup: 'PUMP_CONTINUE',
    confidence,
    quality,
    fuelScore,
    distToHighPct: distPct,
    formerSlAsTp: formerSl,
    limitPrice: entry,
    sl,
    tp,
    tp1,
    notes: [
      `Сквиз пампа · LONG (бывший SL шорта = TP)`,
      `24h +${input.chg24hPct.toFixed(1)}% · к хаю −${distPct.toFixed(2)}% · conf ${confidence}`,
      ...notes.slice(0, 4),
    ],
    reasons,
  }
}
