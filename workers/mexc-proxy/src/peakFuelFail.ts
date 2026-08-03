/**
 * PEAK_FUEL_FAIL — small SHORT when a pump-day meme stalls at a local high
 * without open-interest / tape fuel to continue.
 *
 * Journal autopsy: TRAP_FLIP / late PUMP LONGs often reverse from the peak
 * (crowd long, MM absorbs, price can't print higher). Counter that with a
 * tight scalp short instead of chasing continuation.
 */

export type Candle = [number, number, number, number, number, number]

export interface PeakFuelFailInput {
  symbol: string
  price: number
  chg24hPct: number
  dayBias: 'PUMP' | 'DUMP' | null
  /** Current open interest (holdVol) */
  holdVol?: number | null
  /** Prior holdVol sample (same session) */
  prevHoldVol?: number | null
  candles1m: Candle[]
  /** Optional live book/tape hints */
  buyFlowPct?: number | null
  priceMoveBps?: number | null
  /** True if book shows ask absorption / CVD divergence short */
  absorptionShort?: boolean
  cvdBearish?: boolean
}

export interface PeakFuelFailSignal {
  ready: boolean
  side: 'SHORT'
  setup: 'PEAK_FUEL_FAIL'
  confidence: number
  limitPrice: number
  sl: number
  tp: number
  tp1: number
  notes: string[]
}

const SL_PCT = 0.01
const TP_PCT = 0.018
const TP1_PCT = 0.011
const PEAK_DIST_PCT = 0.85
const MIN_CHG_24H = 6

function recentHigh(candles: Candle[], bars = 30): number {
  const w = candles.slice(-bars)
  let hi = 0
  for (const c of w) hi = Math.max(hi, c[2])
  return hi
}

function failedBreakHigher(candles: Candle[]): boolean {
  if (candles.length < 8) return false
  const closed = candles.slice(0, -1)
  const last = closed[closed.length - 1]
  if (!last) return false
  const prior = closed.slice(-8, -1)
  const priorHigh = Math.max(...prior.map((c) => c[2]))
  // Wick above prior high, close back below
  return last[2] > priorHigh * 1.0005 && last[4] < priorHigh * 0.999
}

function rejectionWick(candles: Candle[]): boolean {
  const c = candles[candles.length - 1] ?? candles[candles.length - 2]
  if (!c) return false
  const [, o, h, l, cl] = c
  const range = h - l
  if (!(range > 0)) return false
  const upper = h - Math.max(o, cl)
  const body = Math.abs(cl - o)
  return upper >= range * 0.42 && upper >= body * 1.1
}

function lowerHighStructure(candles: Candle[]): boolean {
  if (candles.length < 16) return false
  const w = candles.slice(-16)
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
  return swings[swings.length - 1]! < swings[swings.length - 2]! * 0.9995
}

/**
 * Soften slightly for peak-only mode: allow structure+failed break without
 * full absorption when 24h pump is strong (>=12%).
 */
export function detectPeakFuelFail(
  input: PeakFuelFailInput
): PeakFuelFailSignal | null {
  const price = input.price
  if (!(price > 0) || input.candles1m.length < 12) return null

  // Only fade pumps (or strong green day) — not random chops
  const pumpDay = input.dayBias === 'PUMP' || input.chg24hPct >= MIN_CHG_24H
  if (!pumpDay) return null
  if (input.dayBias === 'DUMP' && input.chg24hPct < 3) return null

  const hi = recentHigh(input.candles1m, 30)
  if (!(hi > 0)) return null
  const distPct = ((hi - price) / hi) * 100
  if (distPct > PEAK_DIST_PCT) return null // not near peak

  const failed = failedBreakHigher(input.candles1m)
  const wick = rejectionWick(input.candles1m)
  const lh = lowerHighStructure(input.candles1m)
  const technicalPeak = failed || wick || lh
  if (!technicalPeak) return null

  // Fuel checks
  let fuelScore = 0
  const notes: string[] = []

  const hv = input.holdVol
  const prev = input.prevHoldVol
  if (hv != null && prev != null && prev > 0) {
    const oiChg = ((hv - prev) / prev) * 100
    if (oiChg <= 0.15) {
      fuelScore += 2
      notes.push(`OI без топлива (${oiChg >= 0 ? '+' : ''}${oiChg.toFixed(2)}%)`)
    } else if (oiChg < 0.6) {
      fuelScore += 1
      notes.push(`OI слабый +${oiChg.toFixed(2)}%`)
    }
  } else {
    // No OI history — rely on tape/structure more
    fuelScore += 0
  }

  const buyFlow = input.buyFlowPct
  const moveBps = input.priceMoveBps
  if (
    buyFlow != null &&
    moveBps != null &&
    buyFlow >= 58 &&
    Math.abs(moveBps) <= 10
  ) {
    fuelScore += 2
    notes.push(
      `Покупки ${buyFlow.toFixed(0)}% не двигают цену (${moveBps.toFixed(0)}bps)`
    )
  }

  if (input.absorptionShort) {
    fuelScore += 2
    notes.push('Ask-стена поглощает покупки')
  }
  if (input.cvdBearish) {
    fuelScore += 1
    notes.push('CVD медвежья дивергенция')
  }

  if (failed) notes.push('Failed break выше локального хая')
  if (wick) notes.push('Rejection wick у пика')
  if (lh) notes.push('Lower high структура')

  // Need enough fuel-fail evidence
  const strongPump = input.chg24hPct >= 12
  if (fuelScore < 2 && !(input.absorptionShort && technicalPeak)) {
    if (!(strongPump && failed && wick)) return null
  }
  if (fuelScore < 2 && !input.absorptionShort && !input.cvdBearish) {
    // Structure alone: only on strong pumps with failed break + wick
    if (!(failed && wick && (strongPump || input.chg24hPct >= 8))) return null
  }

  let confidence = 72 + fuelScore * 4
  if (failed && (input.absorptionShort || fuelScore >= 3)) confidence += 6
  if (input.chg24hPct >= 15) confidence += 3
  if (distPct <= 0.35) confidence += 3
  confidence = Math.min(94, Math.round(confidence))

  if (confidence < 78) return null

  const limit = Math.max(price, hi * 0.9985)
  return {
    ready: true,
    side: 'SHORT',
    setup: 'PEAK_FUEL_FAIL',
    confidence,
    limitPrice: limit,
    sl: limit * (1 + SL_PCT),
    tp: limit * (1 - TP_PCT),
    tp1: limit * (1 - TP1_PCT),
    notes: [
      `Пик без топлива · SHORT скальп`,
      `24h ${input.chg24hPct >= 0 ? '+' : ''}${input.chg24hPct.toFixed(1)}% · к хаю −${distPct.toFixed(2)}%`,
      ...notes.slice(0, 4),
      `SL~${(SL_PCT * 100).toFixed(1)}% · TP1~${(TP1_PCT * 100).toFixed(1)}% · TP~${(TP_PCT * 100).toFixed(1)}%`,
    ],
  }
}

/** True when a WITH-day SHORT exception should be allowed (pump fade). */
export function isPeakFuelFailBookHint(opts: {
  dayBias: 'PUMP' | 'DUMP' | null
  side: 'LONG' | 'SHORT' | null
  kind: string
  priceMoveBps: number
  flowSharePct: number
}): boolean {
  if (opts.dayBias !== 'PUMP') return false
  if (opts.side !== 'SHORT') return false
  const abs =
    opts.kind.startsWith('ABSORPTION') || opts.kind === 'CVD_DIVERGENCE'
  if (!abs) return false
  // Absorption short: buys slamming ask, price barely up
  return Math.abs(opts.priceMoveBps) <= 14 || opts.flowSharePct >= 55
}
