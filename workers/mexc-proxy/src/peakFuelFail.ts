/**
 * PEAK_FUEL_FAIL — meme SHORT at FOMO/DISTRIBUTION with high exhaustion.
 * (Alt MM-phase logic lives elsewhere — not used here.)
 */

import { bearishTriggerCandle } from './candleConfirm'
import type { MemeRegime } from './memeRegimeDetector'

export type Candle = [number, number, number, number, number, number]

export interface PeakFuelFailInput {
  symbol: string
  price: number
  chg24hPct: number
  dayBias: 'PUMP' | 'DUMP' | null
  holdVol?: number | null
  prevHoldVol?: number | null
  candles1m: Candle[]
  buyFlowPct?: number | null
  priceMoveBps?: number | null
  /** True only when buyFlow/move come from a live book read */
  tapeFromBook?: boolean
  absorptionShort?: boolean
  cvdBearish?: boolean
  /** Live OBI from book read */
  bookObi?: number | null
  askHeavy?: boolean
  bookForecast?: {
    score: number
    realBook: boolean
    strongTape: boolean
    toxic: boolean
    obiAligned?: boolean
    bias: string
    reasons: string[]
  } | null
  /** Meme lifecycle */
  memeRegime?: MemeRegime | null
  memeAgeMinutes?: number | null
  exhaustion?: number | null
  ageGateOk?: boolean
  tapeBuyExhausting?: boolean
  decayRate?: 'FAST' | 'NORMAL' | 'SLOW' | null
}

export type PeakQuality = 'A' | 'B'

export interface PeakFuelFailSignal {
  ready: boolean
  side: 'SHORT'
  setup: 'PEAK_FUEL_FAIL'
  confidence: number
  quality: PeakQuality
  fuelScore: number
  distToHighPct: number
  limitPrice: number
  sl: number
  tp: number
  tp1: number
  notes: string[]
  reasons: string[]
}

const SL_PCT = 0.01
/** Structural: TP1 0.8% partial → TP2 2.0% */
const TP_PCT = 0.02
const TP1_PCT = 0.008
const PEAK_DIST_PCT = 1.8
const MIN_CHG_24H = 5
const A_MIN_CHG = 7
const A_MAX_DIST = 1.45
const A_MIN_CONF = 72
const A_MIN_FUEL = 1
const A_MIN_EXHAUSTION = 62
const A_MIN_AGE_MIN = 12
const A_WICK_RATIO = 0.3
const MEGA_PUMP_CHG = 30

function wickRatio(candles: Candle[]): number {
  let best = 0
  for (const c of [candles[candles.length - 1], candles[candles.length - 2]]) {
    if (!c) continue
    const [, o, h, l, cl] = c
    const range = h - l
    if (!(range > 0)) continue
    best = Math.max(best, (h - Math.max(o, cl)) / range)
  }
  return best
}

function recentHigh(candles: Candle[], bars = 40): number {
  const w = candles.slice(-bars)
  let hi = 0
  for (const c of w) hi = Math.max(hi, c[2])
  return hi
}

function failedBreakHigher(candles: Candle[]): boolean {
  if (candles.length < 6) return false
  const closed = candles.slice(0, -1)
  for (let k = 0; k < 3; k++) {
    const last = closed[closed.length - 1 - k]
    if (!last) continue
    const prior = closed.slice(-(8 + k), -(1 + k))
    if (prior.length < 3) continue
    const priorHigh = Math.max(...prior.map((c) => c[2]))
    if (last[2] > priorHigh * 1.0003 && last[4] < priorHigh * 1.0002) {
      return true
    }
  }
  return false
}

function rejectionWick(candles: Candle[]): boolean {
  for (const c of [candles[candles.length - 1], candles[candles.length - 2]]) {
    if (!c) continue
    const [, o, h, l, cl] = c
    const range = h - l
    if (!(range > 0)) continue
    const upper = h - Math.max(o, cl)
    const body = Math.abs(cl - o)
    if (upper >= range * 0.28 && upper >= Math.max(body * 0.7, range * 0.15)) {
      return true
    }
  }
  return false
}

function lowerHighStructure(candles: Candle[]): boolean {
  if (candles.length < 12) return false
  const w = candles.slice(-18)
  const swings: number[] = []
  for (let i = 2; i < w.length - 2; i++) {
    if (
      w[i]![2] >= w[i - 1]![2] &&
      w[i]![2] >= w[i - 2]![2] &&
      w[i]![2] >= w[i + 1]![2] &&
      w[i]![2] >= w[i + 2]![2]
    ) {
      swings.push(w[i]![2])
    }
  }
  if (swings.length < 2) return false
  return swings[swings.length - 1]! <= swings[swings.length - 2]! * 1.0005
}

function stallAtHigh(candles: Candle[], price: number, hi: number): boolean {
  if (!(hi > 0) || candles.length < 6) return false
  const distPct = ((hi - price) / hi) * 100
  if (distPct > 1.2) return false
  const last3 = candles.slice(-4, -1)
  if (last3.length < 3) return false
  const maxClose = Math.max(...last3.map((c) => c[4]))
  const minClose = Math.min(...last3.map((c) => c[4]))
  const chopPct = ((maxClose - minClose) / price) * 100
  return chopPct <= 0.9 && maxClose <= hi * 1.0015
}

function stillPumpingHard(candles: Candle[]): boolean {
  const closed = candles.slice(0, -1).slice(-5)
  if (closed.length < 4) return false
  let green = 0
  for (const c of closed) {
    if (c[4] > c[1] * 1.0002) green++
  }
  const first = closed[0]![4]
  const last = closed[closed.length - 1]![4]
  if (!(first > 0)) return false
  const liftPct = ((last - first) / first) * 100
  return green >= 3 && liftPct >= 0.45
}

function rolloverWeakness(
  candles: Candle[],
  price: number,
  hi: number
): boolean {
  if (!(hi > 0)) return false
  const distPct = ((hi - price) / hi) * 100
  if (distPct < 0.28) return false
  const closed = candles.slice(0, -1)
  const last = closed[closed.length - 1]
  if (!last) return false
  const red = last[4] < last[1]
  const prev = closed[closed.length - 2]
  const lowerClose = Boolean(prev && last[4] < prev[4] * 0.9997)
  const twoReds =
    Boolean(prev) && prev![4] < prev![1] && last[4] < last[1]
  return red || lowerClose || twoReds
}

/** 2 closed reds / lower closes after peak — blocks premature short */
function bearishFollowThrough(candles: Candle[]): boolean {
  const closed = candles.slice(0, -1).slice(-2)
  if (closed.length < 2) return false
  const [a, b] = closed
  if (!a || !b) return false
  const reds = (a[4] < a[1] ? 1 : 0) + (b[4] < b[1] ? 1 : 0)
  const lowerClose = b[4] <= a[4] * 1.0002
  return (reds >= 1 && lowerClose) || reds >= 2 || bearishTriggerCandle(candles)
}

export function detectPeakFuelFail(
  input: PeakFuelFailInput
): PeakFuelFailSignal | null {
  const price = input.price
  if (!(price > 0) || input.candles1m.length < 10) return null

  const pumpDay = input.dayBias === 'PUMP' || input.chg24hPct >= MIN_CHG_24H
  if (!pumpDay) return null
  if (input.dayBias === 'DUMP' && input.chg24hPct < 2) return null

  const hi = recentHigh(input.candles1m, 40)
  if (!(hi > 0)) return null
  const distPct = ((hi - price) / hi) * 100
  if (distPct > PEAK_DIST_PCT) return null

  const failed = failedBreakHigher(input.candles1m)
  const wickR = wickRatio(input.candles1m)
  const wick = rejectionWick(input.candles1m) || wickR >= A_WICK_RATIO
  const lh = lowerHighStructure(input.candles1m)
  const stall = stallAtHigh(input.candles1m, price, hi)
  const rollover = rolloverWeakness(input.candles1m, price, hi)
  const pumping = stillPumpingHard(input.candles1m)
  const follow = bearishFollowThrough(input.candles1m)

  const structureWeak = failed || wick || lh
  const bookWeak = Boolean(input.absorptionShort || input.cvdBearish)
  const askHeavy = Boolean(input.askHeavy)
  const forecast = input.bookForecast
  const forecastReal = Boolean(forecast?.realBook)
  const bookToxic = Boolean(forecast?.toxic)
  const bookScore = forecast?.score ?? (bookWeak ? 72 : askHeavy ? 55 : 15)
  const bookAligned =
    bookWeak || askHeavy || forecastReal || (forecast?.obiAligned ?? false)
  const weaknessConfirm = structureWeak || bookWeak || rollover || askHeavy

  if (!weaknessConfirm) return null
  if (pumping && !(failed || wick || bookWeak || forecastReal)) return null
  if (bookToxic) {
    // Manipulation wall — do not SHORT into spoof/wash
    return null
  }

  let fuelScore = 0
  const notes: string[] = []
  const reasons: string[] = []
  let oiRising = false

  const hv = input.holdVol
  const prev = input.prevHoldVol
  if (hv != null && prev != null && prev > 0) {
    const oiChg = ((hv - prev) / prev) * 100
    if (oiChg <= 0.25) {
      fuelScore += 2
      notes.push(`OI без топлива (${oiChg >= 0 ? '+' : ''}${oiChg.toFixed(2)}%)`)
      reasons.push(`oi_flat:${oiChg.toFixed(2)}`)
    } else if (oiChg < 0.9) {
      fuelScore += 1
      notes.push(`OI слабый +${oiChg.toFixed(2)}%`)
      reasons.push(`oi_weak:${oiChg.toFixed(2)}`)
    } else {
      oiRising = true
      reasons.push(`oi_rising:${oiChg.toFixed(2)}`)
    }
  } else {
    reasons.push('oi_unknown')
  }

  const buyFlow = input.buyFlowPct
  const moveBps = input.priceMoveBps
  let tapeStall = false
  // Only credit tape stall from a real book read — never fake buy58 defaults
  if (
    input.tapeFromBook &&
    buyFlow != null &&
    moveBps != null &&
    buyFlow >= 52 &&
    Math.abs(moveBps) <= 18
  ) {
    fuelScore += 2
    tapeStall = true
    notes.push(
      `Покупки ${buyFlow.toFixed(0)}% не двигают цену (${moveBps.toFixed(0)}bps)`
    )
    reasons.push(`tape_stall:buy${buyFlow.toFixed(0)}_bps${moveBps.toFixed(0)}`)
  } else if (moveBps != null && input.tapeFromBook && moveBps <= -6 && distPct >= 0.25) {
    fuelScore += 1
    notes.push(`Откат от хая (${moveBps.toFixed(0)}bps)`)
    reasons.push(`price_fade:${moveBps.toFixed(0)}bps`)
  }

  if (input.absorptionShort) {
    fuelScore += 2
    notes.push('Ask-стена поглощает покупки')
    reasons.push('ask_absorption')
  }
  if (input.cvdBearish) {
    fuelScore += 1
    notes.push('CVD медвежья дивергенция')
    reasons.push('cvd_bearish')
  }
  if (askHeavy) {
    fuelScore += 1
    notes.push('Стакан ask-heavy (OBI против лонгов)')
    reasons.push('ask_heavy')
  }
  if (forecastReal) {
    fuelScore += 1
    notes.push(`Book forecast SHORT score ${bookScore}`)
  }

  if (failed) {
    notes.push('Failed break выше локального хая')
    reasons.push('failed_break')
  }
  if (wick) {
    notes.push('Rejection wick у пика')
    reasons.push('rejection_wick')
  }
  if (lh) {
    notes.push('Lower high структура')
    reasons.push('lower_high')
  }
  if (rollover) {
    notes.push('Слабость: откат/красная от хая')
    reasons.push('rollover_weak')
  }
  if (follow) {
    notes.push('Confirm: медвежий follow-through 1m')
    reasons.push('bearish_follow')
  }
  if (stall) {
    notes.push('Застой под хаем')
    reasons.push('stall_at_high')
  }
  reasons.push('weakness_ok')
  reasons.push(`dist_high:${distPct.toFixed(2)}`)
  reasons.push(`chg24:${input.chg24hPct.toFixed(1)}`)
  reasons.push(`wick_r:${wickR.toFixed(2)}`)

  const regime = input.memeRegime ?? null
  const ageMin = input.memeAgeMinutes ?? 0
  const exhaustion = input.exhaustion ?? 0
  const ageGateOk = input.ageGateOk !== false
  const regimeOk =
    regime === 'DISTRIBUTION' || regime === 'FOMO_PEAK'
  if (regime) reasons.push(`regime:${regime}`)
  reasons.push(`age_m:${ageMin}`)
  reasons.push(`exh:${exhaustion}`)
  if (input.tapeBuyExhausting) reasons.push('tape_buy_exhausting')
  if (input.decayRate) reasons.push(`decay:${input.decayRate}`)
  if (!ageGateOk) reasons.push('age_gate_block')
  if (!regimeOk) reasons.push('regime_block')

  if (fuelScore < 1 && (failed || wick)) fuelScore += 1

  let confidence = 70 + fuelScore * 4
  if (failed || wick) confidence += 5
  if (bookWeak) confidence += 5
  if (follow) confidence += 4
  if (input.chg24hPct >= 15) confidence += 3
  if (distPct <= 0.55) confidence += 2
  if (exhaustion >= A_MIN_EXHAUSTION) confidence += 4
  if (regimeOk) confidence += 3
  if (input.tapeBuyExhausting) confidence += 3
  if (input.decayRate === 'FAST') confidence += 2
  if (oiRising) confidence -= 10
  if (pumping) confidence -= 8
  if (stall && !failed && !wick) confidence -= 6
  if (!follow) confidence -= 3
  if (ageMin < A_MIN_AGE_MIN) confidence -= 8
  confidence = Math.min(94, Math.max(0, Math.round(confidence)))

  if (confidence < 66) return null

  const megaPump = input.chg24hPct >= MEGA_PUMP_CHG
  const hardStructure =
    failed || wickR >= A_WICK_RATIO || (wick && wickR >= 0.28)
  const oiOk = !oiRising || (hardStructure && (bookWeak || (failed && wick)))
  if (forecast?.reasons?.length) {
    for (const r of forecast.reasons.slice(0, 5)) reasons.push(`bk:${r}`)
  }
  reasons.push(`book_score:${bookScore}`)
  if (bookAligned) reasons.push('book_aligned')
  else reasons.push('book_thin')
  const obi = input.bookObi
  const obiOk = obi == null || obi <= -8 || askHeavy || bookWeak
  const bookAllowsA =
    !bookToxic &&
    bookAligned &&
    bookScore >= 55 &&
    (forecast?.bias === 'NEXT_DOWN' ||
      bookWeak ||
      (askHeavy && hardStructure) ||
      bookScore >= 70)
  const aTier =
    hardStructure &&
    follow &&
    bookAllowsA &&
    (bookWeak || failed || wickR >= A_WICK_RATIO) &&
    ageGateOk &&
    regimeOk &&
    ageMin >= A_MIN_AGE_MIN &&
    exhaustion >= A_MIN_EXHAUSTION &&
    obiOk &&
    confidence >= A_MIN_CONF &&
    fuelScore >= A_MIN_FUEL &&
    distPct >= 0.22 &&
    distPct <= A_MAX_DIST &&
    input.chg24hPct >= A_MIN_CHG &&
    oiOk &&
    (!pumping || (failed && wick) || bookWeak) &&
    (!megaPump || bookWeak || forecastReal || (failed && wick && askHeavy)) &&
    !(stall && !failed && !wick)

  const quality: PeakQuality = aTier ? 'A' : 'B'
  reasons.push(`quality:${quality}`)
  reasons.push(`fuel:${fuelScore}`)
  reasons.push(`conf:${confidence}`)
  if (tapeStall) reasons.push('tape_ok')

  const limit = Math.max(price, hi * 0.997)
  return {
    ready: true,
    side: 'SHORT',
    setup: 'PEAK_FUEL_FAIL',
    confidence,
    quality,
    fuelScore,
    distToHighPct: distPct,
    limitPrice: limit,
    sl: limit * (1 + SL_PCT),
    tp: limit * (1 - TP_PCT),
    tp1: limit * (1 - TP1_PCT),
    notes: [
      `Пик + слабость · SHORT · класс ${quality}`,
      `24h ${input.chg24hPct >= 0 ? '+' : ''}${input.chg24hPct.toFixed(1)}% · к хаю −${distPct.toFixed(2)}% · conf ${confidence}`,
      `Структурный выход: TP1 −0.8% → BE · TP2 −2.0% ≈ +40% @ ×20`,
      ...notes.slice(0, 4),
    ],
    reasons,
  }
}

export function isPeakFuelFailBookHint(opts: {
  dayBias: 'PUMP' | 'DUMP' | null
  side: 'LONG' | 'SHORT' | null
  kind: string
  priceMoveBps: number
  flowSharePct: number
}): boolean {
  if (opts.side !== 'SHORT') return false
  const abs =
    opts.kind.startsWith('ABSORPTION') || opts.kind === 'CVD_DIVERGENCE'
  if (!abs) return false
  return Math.abs(opts.priceMoveBps) <= 20 || opts.flowSharePct >= 50
}
