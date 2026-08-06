/**
 * PEAK_FUEL_FAIL — SHORT weak bounce AFTER a pump already failed.
 *
 * Ideal (UB chart): vertical pump → dump → consolidation → rejection at
 * lower high (not the tip of the vertical candle). Tip-of-pump shorts = SL.
 *
 * v29.7: require post-dump + local lower-high bounce; block fresh pump tip.
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
  /** Ask wall / sell pressure from book OBI when available */
  askHeavy?: boolean
  bookConfidence?: number | null
  obi?: number | null
  obiChange?: number | null
}

export type PeakQuality = 'A' | 'B'

export interface PeakFuelFailSignal {
  ready: boolean
  side: 'SHORT'
  setup: 'PEAK_FUEL_FAIL'
  confidence: number
  /** A = TG+paper+journal; B = decision log only */
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
const TP_PCT = 0.018
const TP1_PCT = 0.011
/** Distance to LOCAL bounce high (not absolute pump ATH) */
const PEAK_DIST_PCT = 2.8
const A_MAX_DIST = 1.8
const MIN_CHG_24H = 4
const A_MIN_CHG = 5
const A_MIN_CONF = 76
const A_MIN_FUEL = 2
const MEGA_PUMP_CHG = 25

/** Extended window to see the real pump peak + dump (~2.5h on 1m) */
const EXT_BARS = 150
/** Local resistance for bounce short */
const LOC_BARS = 35
/** Min dump from extended peak before A-tier (ideal chart) */
const A_MIN_DUMP_PCT = 5.5
/** Peak must age — don't short the print of the ATH candle */
const A_MIN_PEAK_AGE = 18
/** Local high at least this % below extended peak */
const A_MIN_LOWER_HIGH_PCT = 1.5
/** Fresh tip = still climbing / just printed high with tiny dump */
const FRESH_TIP_AGE = 12
const FRESH_TIP_DUMP = 3.5

function recentHigh(candles: Candle[], bars = 40): number {
  const w = candles.slice(-bars)
  let hi = 0
  for (const c of w) hi = Math.max(hi, c[2])
  return hi
}

/** Structure of the pump: absolute peak → dump → optional bounce. */
function measurePumpContext(
  candles: Candle[],
  price: number
): {
  peak: number
  peakAgeBars: number
  dumpPct: number
  localHi: number
  distLocalPct: number
  lowerHighPct: number
  postDump: boolean
  freshTip: boolean
} {
  const ext = candles.slice(-EXT_BARS)
  let peak = 0
  let peakIdx = -1
  for (let i = 0; i < ext.length; i++) {
    if (ext[i]![2] >= peak) {
      peak = ext[i]![2]
      peakIdx = i
    }
  }
  const peakAgeBars = peakIdx >= 0 ? ext.length - 1 - peakIdx : 0
  let trough = peak
  for (let i = Math.max(0, peakIdx); i < ext.length; i++) {
    trough = Math.min(trough, ext[i]![3])
  }
  const dumpPct = peak > 0 ? ((peak - trough) / peak) * 100 : 0
  const localHi = recentHigh(candles, LOC_BARS)
  const distLocalPct =
    localHi > 0 ? ((localHi - price) / localHi) * 100 : 99
  const lowerHighPct =
    peak > 0 && localHi > 0 ? ((peak - localHi) / peak) * 100 : 0
  const postDump =
    dumpPct >= A_MIN_DUMP_PCT &&
    peakAgeBars >= A_MIN_PEAK_AGE &&
    lowerHighPct >= A_MIN_LOWER_HIGH_PCT
  const freshTip =
    peakAgeBars < FRESH_TIP_AGE &&
    dumpPct < FRESH_TIP_DUMP &&
    price >= peak * 0.985
  return {
    peak,
    peakAgeBars,
    dumpPct,
    localHi,
    distLocalPct,
    lowerHighPct,
    postDump,
    freshTip,
  }
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
  // Prefer last CLOSED bar — forming bar wick is noisy
  for (const c of [candles[candles.length - 2], candles[candles.length - 3]]) {
    if (!c) continue
    const [, o, h, l, cl] = c
    const range = h - l
    if (!(range > 0)) continue
    const upper = h - Math.max(o, cl)
    const body = Math.abs(cl - o)
    if (upper >= range * 0.32 && upper >= Math.max(body * 0.85, range * 0.18)) {
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
  if (distPct > 1.6) return false
  const last3 = candles.slice(-4, -1)
  if (last3.length < 3) return false
  const maxClose = Math.max(...last3.map((c) => c[4]))
  const minClose = Math.min(...last3.map((c) => c[4]))
  const chopPct = ((maxClose - minClose) / price) * 100
  return chopPct <= 0.85 && maxClose <= hi * 1.0012
}

/** Last closed bar shows sellers won the candle (short trigger). */
function bearishTrigger(candles: Candle[]): boolean {
  const c = candles[candles.length - 2]
  if (!c) return false
  const [, o, h, l, cl] = c
  const range = h - l
  if (!(range > 0)) return false
  const closePos = (cl - l) / range
  const bearishBody = cl < o * 0.9995
  const closeLowerHalf = closePos <= 0.45
  return bearishBody && closeLowerHalf
}

/**
 * Strong green impulse into the local high = fuel still there / squeeze risk.
 */
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
  const nearHigh = last[4] >= hi * 0.995
  const range = last[2] - last[3]
  const body = Math.abs(last[4] - last[1])
  const strongGreen =
    last[4] > last[1] && range > 0 && body / range >= 0.55 && last[4] >= last[2] * 0.985
  return nearHigh && ((green >= 3 && netPct >= 0.9) || (strongGreen && netPct >= 0.45))
}

/** Volume dying on up-closes vs prior bars — soft exhaust proxy without book. */
function upVolumeFade(candles: Candle[]): boolean {
  if (candles.length < 12) return false
  const closed = candles.slice(0, -1).slice(-10)
  const ups = closed.filter((c) => c[4] > c[1])
  const downs = closed.filter((c) => c[4] < c[1])
  if (ups.length < 2 || downs.length < 1) return false
  const avgUp =
    ups.reduce((s, c) => s + c[5], 0) / Math.max(1, ups.length)
  const avgDown =
    downs.reduce((s, c) => s + c[5], 0) / Math.max(1, downs.length)
  const recentUp = ups.slice(-2)
  const recentUpVol =
    recentUp.reduce((s, c) => s + c[5], 0) / Math.max(1, recentUp.length)
  return avgDown > 0 && recentUpVol < avgUp * 0.72 && recentUpVol < avgDown * 0.95
}

export function detectPeakFuelFail(
  input: PeakFuelFailInput
): PeakFuelFailSignal | null {
  const price = input.price
  if (!(price > 0) || input.candles1m.length < 40) return null

  const pumpDay = input.dayBias === 'PUMP' || input.chg24hPct >= MIN_CHG_24H
  if (!pumpDay) return null
  if (input.dayBias === 'DUMP' && input.chg24hPct < 2) return null

  const ctx = measurePumpContext(input.candles1m, price)
  const hi = ctx.localHi
  if (!(hi > 0) || !(ctx.peak > 0)) return null

  // Enter at bounce resistance — not required to sit under absolute ATH
  const distPct = ctx.distLocalPct
  if (distPct > PEAK_DIST_PCT || distPct < -0.15) return null

  // Hard block: shorting the tip of a fresh vertical pump
  if (ctx.freshTip) return null

  if (stillFueledImpulse(input.candles1m, hi)) {
    return null
  }

  const failed = failedBreakHigher(input.candles1m)
  const wick = rejectionWick(input.candles1m)
  const lh = lowerHighStructure(input.candles1m)
  const stall = stallAtHigh(input.candles1m, price, hi)
  const bearish = bearishTrigger(input.candles1m)
  const volFade = upVolumeFade(input.candles1m)
  const technicalPeak = failed || wick || lh || stall
  if (!technicalPeak) return null

  let fuelScore = 0
  const notes: string[] = []
  const reasons: string[] = []
  let oiRising = false
  let oiExhaust = false

  reasons.push(`dump:${ctx.dumpPct.toFixed(1)}`)
  reasons.push(`peak_age:${ctx.peakAgeBars}`)
  reasons.push(`lh_vs_peak:${ctx.lowerHighPct.toFixed(1)}`)
  if (ctx.postDump) {
    fuelScore += 2
    notes.push(
      `Памп уже слит (−${ctx.dumpPct.toFixed(1)}% от пика, age ${ctx.peakAgeBars}m)`
    )
    reasons.push('post_dump')
  } else if (ctx.dumpPct >= 3 && ctx.peakAgeBars >= 10) {
    fuelScore += 1
    notes.push(`Частичный слив −${ctx.dumpPct.toFixed(1)}% · ждём lower high`)
    reasons.push('dump_partial')
  } else {
    reasons.push('dump_weak')
  }

  const hv = input.holdVol
  const prev = input.prevHoldVol
  if (hv != null && prev != null && prev > 0) {
    const oiChg = ((hv - prev) / prev) * 100
    // Glitch guard: ±25% in one scan tick is usually bad sample, not signal
    if (Math.abs(oiChg) > 25) {
      reasons.push(`oi_glitch:${oiChg.toFixed(1)}`)
    } else if (oiChg <= 0.15) {
      fuelScore += 2
      oiExhaust = true
      notes.push(`OI без топлива (${oiChg >= 0 ? '+' : ''}${oiChg.toFixed(2)}%)`)
      reasons.push(`oi_flat:${oiChg.toFixed(2)}`)
    } else if (oiChg < 0.7) {
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
  const bookConfidence = input.bookConfidence ?? 0
  const obi = input.obi ?? 0
  const obiChange = input.obiChange ?? 0
  let tapeStall = false
  let tapeDownHard = false
  if (
    buyFlow != null &&
    moveBps != null &&
    buyFlow >= 55 &&
    Math.abs(moveBps) <= 14
  ) {
    fuelScore += 2
    tapeStall = true
    notes.push(
      `Покупки ${buyFlow.toFixed(0)}% не двигают цену (${moveBps.toFixed(0)}bps)`
    )
    reasons.push(`tape_stall:buy${buyFlow.toFixed(0)}_bps${moveBps.toFixed(0)}`)
  } else if (moveBps != null && moveBps < -6 && distPct <= 1.2) {
    fuelScore += 1
    tapeDownHard = moveBps <= -10
    notes.push(`Лента уже давит вниз (${moveBps.toFixed(0)}bps)`)
    reasons.push(`tape_down:${moveBps.toFixed(0)}bps`)
  }

  const askHeavyStrong =
    Boolean(input.askHeavy) &&
    (obi <= -16 || obiChange <= -5) &&
    bookConfidence >= 72
  const bookConfirm = Boolean(
    input.absorptionShort || input.cvdBearish || askHeavyStrong
  )
  const strongBookConfirm = Boolean(
    input.absorptionShort ||
      input.cvdBearish ||
      (askHeavyStrong && (obi <= -20 || obiChange <= -7 || bookConfidence >= 80))
  )
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
  if (input.askHeavy) {
    fuelScore += 1
    notes.push('Стакан перевешен в asks')
    reasons.push(askHeavyStrong ? 'ask_heavy_strong' : 'ask_heavy')
  }

  if (failed) {
    fuelScore += 1
    notes.push('Failed break выше локального хая')
    reasons.push('failed_break')
  }
  if (wick) {
    fuelScore += 1
    notes.push('Rejection wick на отбое')
    reasons.push('rejection_wick')
  }
  if (lh) {
    notes.push('Lower high структура')
    reasons.push('lower_high')
  }
  if (stall) {
    notes.push('Застой под локальным хаем')
    reasons.push('stall_at_high')
  }
  if (bearish) {
    fuelScore += 1
    notes.push('Медвежья закрытая свеча — триггер шорта')
    reasons.push('bearish_trigger')
  }
  if (volFade) {
    fuelScore += 1
    notes.push('Объём покупок затухает')
    reasons.push('up_vol_fade')
  }
  reasons.push(`dist_local:${distPct.toFixed(2)}`)
  reasons.push(`chg24:${input.chg24hPct.toFixed(1)}`)

  // Exhaust = money/aggression not supporting continuation
  const exhaustConfirm =
    oiExhaust ||
    tapeStall ||
    bookConfirm ||
    volFade ||
    (wick && failed) ||
    (wick && bearish && oiExhaust) ||
    (ctx.postDump && wick && bearish)

  // Technical short trigger — not just "we are near a high"
  const technicalEntry =
    bearish ||
    (wick && failed) ||
    (wick && bearish) ||
    (failed && bearish) ||
    (bookConfirm && (wick || failed || stall)) ||
    (ctx.postDump && wick && (failed || lh || bearish))

  const downConfirm =
    strongBookConfirm ||
    (bearish && tapeDownHard) ||
    (wick && failed && tapeStall) ||
    (ctx.postDump && bearish && (tapeStall || tapeDownHard || strongBookConfirm))

  if (!exhaustConfirm || !technicalEntry) {
    // Still return B candidate for autopsy when structure exists near local high
    if (!(technicalPeak && (wick || failed || stall))) return null
  }

  let confidence = 66 + fuelScore * 3
  if (failed && wick) confidence += 5
  if (bearish) confidence += 4
  if (bookConfirm) confidence += 6
  if (strongBookConfirm) confidence += 4
  if (exhaustConfirm) confidence += 3
  if (downConfirm) confidence += 4
  if (ctx.postDump) confidence += 6
  if (ctx.lowerHighPct >= 4) confidence += 3
  if (input.chg24hPct >= 12 && input.chg24hPct < MEGA_PUMP_CHG) confidence += 2
  if (distPct <= 0.45) confidence += 2
  if (oiRising) confidence -= 10
  if (!ctx.postDump && ctx.dumpPct < 4) confidence -= 8
  if (!bearish && !bookConfirm) confidence -= 4
  confidence = Math.min(94, Math.max(0, Math.round(confidence)))

  if (confidence < 70) return null

  const stallOnly = stall && !failed && !wick && !lh && !bearish
  const megaPump = input.chg24hPct >= MEGA_PUMP_CHG
  const dumpOkForMega = !megaPump || ctx.dumpPct >= 8 || ctx.postDump
  // A-tier = UB chart + LIVE BOOK confirm (never blind tip-of-pump)
  const aTier =
    bookConfirm &&
    strongBookConfirm &&
    ctx.postDump &&
    dumpOkForMega &&
    exhaustConfirm &&
    technicalEntry &&
    downConfirm &&
    !stallOnly &&
    !oiRising &&
    !ctx.freshTip &&
    confidence >= A_MIN_CONF &&
    fuelScore >= A_MIN_FUEL &&
    distPct <= A_MAX_DIST &&
    input.chg24hPct >= A_MIN_CHG &&
    (wick || failed) &&
    (bearish || (wick && failed)) &&
    ctx.lowerHighPct >= A_MIN_LOWER_HIGH_PCT

  const quality: PeakQuality = aTier ? 'A' : 'B'
  reasons.push(`quality:${quality}`)
  reasons.push(`fuel:${fuelScore}`)
  reasons.push(`conf:${confidence}`)
  reasons.push(exhaustConfirm ? 'exhaust_ok' : 'exhaust_weak')
  reasons.push(technicalEntry ? 'tech_ok' : 'tech_weak')
  reasons.push(bookConfirm ? 'book_ok' : 'book_missing')
  reasons.push(downConfirm ? 'down_confirmed' : 'down_unconfirmed')

  // Enter at market; SL above LOCAL bounce high (room for wick)
  const entry = price
  const sl = Math.max(hi * 1.0025, entry * (1 + SL_PCT))
  return {
    ready: true,
    side: 'SHORT',
    setup: 'PEAK_FUEL_FAIL',
    confidence,
    quality,
    fuelScore,
    distToHighPct: distPct,
    limitPrice: entry,
    sl,
    tp: entry * (1 - TP_PCT),
    tp1: entry * (1 - TP1_PCT),
    notes: [
      ctx.postDump
        ? `Отбой после слива · SHORT`
        : `Пик без топлива · SHORT`,
      `24h ${input.chg24hPct >= 0 ? '+' : ''}${input.chg24hPct.toFixed(1)}% · к лок.хаю −${distPct.toFixed(2)}% · dump −${ctx.dumpPct.toFixed(1)}% · conf ${confidence}`,
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
