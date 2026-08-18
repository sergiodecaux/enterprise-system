/**
 * PEAK_FUEL_FAIL — small SHORT when a pump-day meme stalls at a local high
 * without open-interest / tape fuel to continue.
 *
 * v27.1: looser gates — was missing too many live peaks.
 */

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
  absorptionShort?: boolean
  cvdBearish?: boolean
  /** Book was actually read this tick — never invent tape */
  bookSeen?: boolean
  /** Soft crowd/magnet score −2…+2 (not a skip) */
  crowdSoft?: number
  crowdNote?: string | null
  /** Wash/spoof/trap — skip this tick only */
  toxicBook?: boolean
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
/** How far under local high still counts as "at peak" */
const PEAK_DIST_PCT = 1.8
const MIN_CHG_24H = 4

function recentHigh(candles: Candle[], bars = 40): number {
  const w = candles.slice(-bars)
  let hi = 0
  for (const c of w) hi = Math.max(hi, c[2])
  return hi
}

function failedBreakHigher(candles: Candle[]): boolean {
  if (candles.length < 6) return false
  // Check last 3 closed bars for failed break
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
  // Last or previous candle
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

/** Price hugging local high, last bars not extending — classic stall */
function stallAtHigh(candles: Candle[], price: number, hi: number): boolean {
  if (!(hi > 0) || candles.length < 6) return false
  const distPct = ((hi - price) / hi) * 100
  if (distPct > 1.2) return false
  const last3 = candles.slice(-4, -1)
  if (last3.length < 3) return false
  const maxClose = Math.max(...last3.map((c) => c[4]))
  const minClose = Math.min(...last3.map((c) => c[4]))
  const chopPct = ((maxClose - minClose) / price) * 100
  // Chop under the high without clean breakout
  return chopPct <= 0.9 && maxClose <= hi * 1.0015
}

/**
 * Detect exhausted pump peak → SHORT scalp (permissive for live coverage).
 */
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
  const wick = rejectionWick(input.candles1m)
  const lh = lowerHighStructure(input.candles1m)
  const stall = stallAtHigh(input.candles1m, price, hi)
  const technicalPeak = failed || wick || lh || stall
  if (!technicalPeak) return null

  let fuelScore = 0
  const notes: string[] = []

  const hv = input.holdVol
  const prev = input.prevHoldVol
  if (hv != null && prev != null && prev > 0) {
    const oiChg = ((hv - prev) / prev) * 100
    if (oiChg <= 0.25) {
      fuelScore += 2
      notes.push(`OI без топлива (${oiChg >= 0 ? '+' : ''}${oiChg.toFixed(2)}%)`)
    } else if (oiChg < 0.9) {
      fuelScore += 1
      notes.push(`OI слабый +${oiChg.toFixed(2)}%`)
    }
  } else {
    // No OI series yet — give structure a chance
    fuelScore += 1
  }

  if (input.toxicBook) return null

  const buyFlow = input.bookSeen === false ? null : input.buyFlowPct
  const moveBps = input.bookSeen === false ? null : input.priceMoveBps
  if (
    buyFlow != null &&
    moveBps != null &&
    buyFlow >= 52 &&
    Math.abs(moveBps) <= 18
  ) {
    fuelScore += 2
    notes.push(
      `Покупки ${buyFlow.toFixed(0)}% не двигают цену (${moveBps.toFixed(0)}bps)`
    )
  } else if (moveBps != null && Math.abs(moveBps) <= 8 && distPct <= 0.8) {
    fuelScore += 1
    notes.push(`Цена стоит у хая (${moveBps.toFixed(0)}bps)`)
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
  if (stall) notes.push('Застой под хаем')

  // Permissive: structure at peak + any fuel hint OR strong pump alone
  const strongPump = input.chg24hPct >= 8
  if (fuelScore < 1 && !input.absorptionShort) {
    if (!(strongPump && (failed || wick || stall))) return null
  }

  const crowdSoft = Math.max(-2, Math.min(2, input.crowdSoft ?? 0))
  if (input.crowdNote) notes.push(input.crowdNote)

  let confidence = 68 + fuelScore * 4
  if (failed || wick) confidence += 4
  if (input.absorptionShort || fuelScore >= 3) confidence += 5
  if (input.chg24hPct >= 12) confidence += 3
  if (distPct <= 0.5) confidence += 3
  if (stall && fuelScore >= 2) confidence += 2
  confidence += crowdSoft * 3
  confidence = Math.min(94, Math.round(confidence))

  if (confidence < 70) return null

  const limit = Math.max(price, hi * 0.997)
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

export function isPeakFuelFailBookHint(opts: {
  dayBias: 'PUMP' | 'DUMP' | null
  side: 'LONG' | 'SHORT' | null
  kind: string
  priceMoveBps: number
  flowSharePct: number
}): boolean {
  if (opts.dayBias !== 'PUMP' && opts.dayBias != null) {
    // still allow if short absorption
  }
  if (opts.side !== 'SHORT') return false
  const abs =
    opts.kind.startsWith('ABSORPTION') || opts.kind === 'CVD_DIVERGENCE'
  if (!abs) return false
  return Math.abs(opts.priceMoveBps) <= 20 || opts.flowSharePct >= 50
}
