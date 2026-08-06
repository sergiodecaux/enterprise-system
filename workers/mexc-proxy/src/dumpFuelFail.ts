/**
 * DUMP_FUEL_FAIL — LONG weak selloff AFTER a dump already failed.
 *
 * Mirror of PEAK_FUEL_FAIL SHORT:
 * vertical dump → bounce → consolidation → rejection at higher low
 * (not the tip of the crash candle). Tip-of-dump longs = SL.
 */

import type { Candle } from './peakFuelFail'

export interface DumpFuelFailInput {
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
  shortBaitAsks?: boolean
  crowdAskLevels?: number | null
}

export type DumpQuality = 'A' | 'B'

export interface DumpFuelFailSignal {
  ready: boolean
  side: 'LONG'
  setup: 'DUMP_FUEL_FAIL'
  confidence: number
  quality: DumpQuality
  fuelScore: number
  distToLowPct: number
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
const FLOOR_DIST_PCT = 2.8
const A_MAX_DIST = 1.8
const MIN_DUMP_24H = -4
const A_MIN_DUMP_24H = -5
const A_MIN_CONF = 76
const A_MIN_FUEL = 2
const MEGA_DUMP_CHG = -25

const EXT_BARS = 150
const LOC_BARS = 35
const A_MIN_BOUNCE_PCT = 5.5
const A_MIN_TROUGH_AGE = 18
const A_MIN_HIGHER_LOW_PCT = 1.5
const FRESH_TIP_AGE = 12
const FRESH_TIP_BOUNCE = 3.5

function recentLow(candles: Candle[], bars = 40): number {
  const w = candles.slice(-bars)
  let lo = Number.POSITIVE_INFINITY
  for (const c of w) lo = Math.min(lo, c[3])
  return Number.isFinite(lo) ? lo : 0
}

/** Absolute trough → bounce → optional retest of higher low. */
function measureDumpContext(
  candles: Candle[],
  price: number
): {
  trough: number
  troughAgeBars: number
  bouncePct: number
  localLo: number
  distLocalPct: number
  higherLowPct: number
  postBounce: boolean
  freshTip: boolean
} {
  const ext = candles.slice(-EXT_BARS)
  let trough = Number.POSITIVE_INFINITY
  let troughIdx = -1
  for (let i = 0; i < ext.length; i++) {
    if (ext[i]![3] <= trough) {
      trough = ext[i]![3]
      troughIdx = i
    }
  }
  if (!(trough > 0) || troughIdx < 0) {
    return {
      trough: 0,
      troughAgeBars: 0,
      bouncePct: 0,
      localLo: 0,
      distLocalPct: 99,
      higherLowPct: 0,
      postBounce: false,
      freshTip: false,
    }
  }
  const troughAgeBars = ext.length - 1 - troughIdx
  let peakAfter = trough
  for (let i = troughIdx; i < ext.length; i++) {
    peakAfter = Math.max(peakAfter, ext[i]![2])
  }
  const bouncePct = trough > 0 ? ((peakAfter - trough) / trough) * 100 : 0
  const localLo = recentLow(candles, LOC_BARS)
  const distLocalPct =
    localLo > 0 ? ((price - localLo) / localLo) * 100 : 99
  const higherLowPct =
    trough > 0 && localLo > 0 ? ((localLo - trough) / trough) * 100 : 0
  const postBounce =
    bouncePct >= A_MIN_BOUNCE_PCT &&
    troughAgeBars >= A_MIN_TROUGH_AGE &&
    higherLowPct >= A_MIN_HIGHER_LOW_PCT
  const freshTip =
    troughAgeBars < FRESH_TIP_AGE &&
    bouncePct < FRESH_TIP_BOUNCE &&
    price <= trough * 1.015
  return {
    trough,
    troughAgeBars,
    bouncePct,
    localLo,
    distLocalPct,
    higherLowPct,
    postBounce,
    freshTip,
  }
}

function failedBreakLower(candles: Candle[]): boolean {
  if (candles.length < 6) return false
  const closed = candles.slice(0, -1)
  for (let k = 0; k < 3; k++) {
    const last = closed[closed.length - 1 - k]
    if (!last) continue
    const prior = closed.slice(-(8 + k), -(1 + k))
    if (prior.length < 3) continue
    const priorLow = Math.min(...prior.map((c) => c[3]))
    if (last[3] < priorLow * 0.9997 && last[4] > priorLow * 0.9998) {
      return true
    }
  }
  return false
}

function hammerWick(candles: Candle[]): boolean {
  for (const c of [candles[candles.length - 2], candles[candles.length - 3]]) {
    if (!c) continue
    const [, o, h, l, cl] = c
    const range = h - l
    if (!(range > 0)) continue
    const lower = Math.min(o, cl) - l
    const body = Math.abs(cl - o)
    if (lower >= range * 0.32 && lower >= Math.max(body * 0.85, range * 0.18)) {
      return true
    }
  }
  return false
}

function higherLowStructure(candles: Candle[]): boolean {
  if (candles.length < 12) return false
  const w = candles.slice(-18)
  const swings: number[] = []
  for (let i = 2; i < w.length - 2; i++) {
    if (
      w[i]![3] <= w[i - 1]![3] &&
      w[i]![3] <= w[i - 2]![3] &&
      w[i]![3] <= w[i + 1]![3] &&
      w[i]![3] <= w[i + 2]![3]
    ) {
      swings.push(w[i]![3])
    }
  }
  if (swings.length < 2) return false
  return swings[swings.length - 1]! >= swings[swings.length - 2]! * 0.9995
}

function stallAtLow(candles: Candle[], price: number, lo: number): boolean {
  if (!(lo > 0) || candles.length < 6) return false
  const distPct = ((price - lo) / lo) * 100
  if (distPct > 1.6) return false
  const last3 = candles.slice(-4, -1)
  if (last3.length < 3) return false
  const maxClose = Math.max(...last3.map((c) => c[4]))
  const minClose = Math.min(...last3.map((c) => c[4]))
  const chopPct = ((maxClose - minClose) / price) * 100
  return chopPct <= 0.85 && minClose >= lo * 0.9988
}

function bullishTrigger(candles: Candle[]): boolean {
  const c = candles[candles.length - 2]
  if (!c) return false
  const [, o, h, l, cl] = c
  const range = h - l
  if (!(range > 0)) return false
  const closePos = (cl - l) / range
  const bullishBody = cl > o * 1.0005
  const closeUpperHalf = closePos >= 0.55
  return bullishBody && closeUpperHalf
}

function stillDumpingImpulse(candles: Candle[], lo: number): boolean {
  if (candles.length < 6 || !(lo > 0)) return false
  const closed = candles.slice(0, -1).slice(-5)
  if (closed.length < 4) return false
  let red = 0
  let netPct = 0
  for (const c of closed) {
    const [, o, , , cl] = c
    if (cl < o) red++
    netPct += ((cl - o) / o) * 100
  }
  const last = closed[closed.length - 1]!
  const nearLow = last[4] <= lo * 1.005
  const range = last[2] - last[3]
  const body = Math.abs(last[4] - last[1])
  const strongRed =
    last[4] < last[1] && range > 0 && body / range >= 0.55 && last[4] <= last[3] * 1.015
  return nearLow && ((red >= 3 && netPct <= -0.9) || (strongRed && netPct <= -0.45))
}

function downVolumeFade(candles: Candle[]): boolean {
  if (candles.length < 12) return false
  const closed = candles.slice(0, -1).slice(-10)
  const ups = closed.filter((c) => c[4] > c[1])
  const downs = closed.filter((c) => c[4] < c[1])
  if (ups.length < 1 || downs.length < 2) return false
  const avgUp = ups.reduce((s, c) => s + c[5], 0) / Math.max(1, ups.length)
  const avgDown = downs.reduce((s, c) => s + c[5], 0) / Math.max(1, downs.length)
  const recentDown = downs.slice(-2)
  const recentDownVol =
    recentDown.reduce((s, c) => s + c[5], 0) / Math.max(1, recentDown.length)
  return avgUp > 0 && recentDownVol < avgDown * 0.72 && recentDownVol < avgUp * 0.95
}

export function detectDumpFuelFail(
  input: DumpFuelFailInput
): DumpFuelFailSignal | null {
  const price = input.price
  if (!(price > 0) || input.candles1m.length < 40) return null

  const dumpDay = input.dayBias === 'DUMP' || input.chg24hPct <= MIN_DUMP_24H
  if (!dumpDay) return null
  if (input.dayBias === 'PUMP' && input.chg24hPct > -2) return null

  const ctx = measureDumpContext(input.candles1m, price)
  const lo = ctx.localLo
  if (!(lo > 0) || !(ctx.trough > 0)) return null

  const distPct = ctx.distLocalPct
  if (distPct > FLOOR_DIST_PCT || distPct < -0.15) return null
  if (ctx.freshTip) return null
  if (stillDumpingImpulse(input.candles1m, lo)) return null

  const failed = failedBreakLower(input.candles1m)
  const wick = hammerWick(input.candles1m)
  const hl = higherLowStructure(input.candles1m)
  const stall = stallAtLow(input.candles1m, price, lo)
  const bullish = bullishTrigger(input.candles1m)
  const volFade = downVolumeFade(input.candles1m)
  const technicalFloor = failed || wick || hl || stall
  if (!technicalFloor) return null

  let fuelScore = 0
  const notes: string[] = []
  const reasons: string[] = []
  let oiRising = false
  let oiExhaust = false

  reasons.push(`bounce:${ctx.bouncePct.toFixed(1)}`)
  reasons.push(`trough_age:${ctx.troughAgeBars}`)
  reasons.push(`hl_vs_trough:${ctx.higherLowPct.toFixed(1)}`)
  if (ctx.postBounce) {
    fuelScore += 2
    notes.push(
      `Дамп уже отбит (+${ctx.bouncePct.toFixed(1)}% от лоя, age ${ctx.troughAgeBars}m)`
    )
    reasons.push('post_bounce')
  } else if (ctx.bouncePct >= 3 && ctx.troughAgeBars >= 10) {
    fuelScore += 1
    notes.push(`Частичный отскок +${ctx.bouncePct.toFixed(1)}% · ждём higher low`)
    reasons.push('bounce_partial')
  } else {
    reasons.push('bounce_weak')
  }

  const hv = input.holdVol
  const prev = input.prevHoldVol
  if (hv != null && prev != null && prev > 0) {
    const oiChg = ((hv - prev) / prev) * 100
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
      // For LONG after dump, rising OI can be new longs — mild positive, not block
      reasons.push(`oi_rising:${oiChg.toFixed(2)}`)
      oiRising = oiChg > 2.5
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
  let tapeUpHard = false
  if (
    buyFlow != null &&
    moveBps != null &&
    buyFlow <= 45 &&
    Math.abs(moveBps) <= 14
  ) {
    fuelScore += 2
    tapeStall = true
    notes.push(
      `Продажи ${(100 - buyFlow).toFixed(0)}% не двигают цену (${moveBps.toFixed(0)}bps)`
    )
    reasons.push(`tape_stall:sell${(100 - buyFlow).toFixed(0)}_bps${moveBps.toFixed(0)}`)
  } else if (moveBps != null && moveBps > 6 && distPct <= 1.2) {
    fuelScore += 1
    tapeUpHard = moveBps >= 10
    notes.push(`Лента уже тянет вверх (${moveBps.toFixed(0)}bps)`)
    reasons.push(`tape_up:${moveBps.toFixed(0)}bps`)
  }

  const bidHeavyStrong =
    Boolean(input.bidHeavy) &&
    (obi >= 16 || obiChange >= 5) &&
    bookConfidence >= 72
  const bookConfirm = Boolean(
    input.absorptionLong || input.cvdBullish || bidHeavyStrong
  )
  const strongBookConfirm = Boolean(
    input.absorptionLong ||
      input.cvdBullish ||
      (bidHeavyStrong && (obi >= 20 || obiChange >= 7 || bookConfidence >= 80))
  )
  // Hard: no LONG without buy-side pressure
  const pressureOk = Boolean(
    input.absorptionLong ||
      input.cvdBullish ||
      (tapeUpHard && buyFlow != null && buyFlow >= 55) ||
      (bidHeavyStrong && (tapeStall || tapeUpHard || bullish))
  )
  if (input.absorptionLong) {
    fuelScore += 2
    notes.push('Bid-стена поглощает продажи')
    reasons.push('bid_absorption')
  }
  if (input.cvdBullish) {
    fuelScore += 1
    notes.push('CVD бычья дивергенция')
    reasons.push('cvd_bullish')
  }
  if (input.bidHeavy) {
    fuelScore += 1
    notes.push('Стакан перевешен в bids')
    reasons.push(bidHeavyStrong ? 'bid_heavy_strong' : 'bid_heavy')
  }
  if (input.shortBaitAsks) {
    fuelScore += 1
    notes.push(
      `Мелкие asks толпы ×${input.crowdAskLevels ?? 0} — ложное сопротивление`
    )
    reasons.push(`crowd_asks_bait:n${input.crowdAskLevels ?? 0}`)
  }

  if (failed) {
    fuelScore += 1
    notes.push('Failed break ниже локального лоя')
    reasons.push('failed_break_low')
  }
  if (wick) {
    fuelScore += 1
    notes.push('Hammer wick на отбое')
    reasons.push('hammer_wick')
  }
  if (hl) {
    notes.push('Higher low структура')
    reasons.push('higher_low')
  }
  if (stall) {
    notes.push('Застой над локальным лоем')
    reasons.push('stall_at_low')
  }
  if (bullish) {
    fuelScore += 1
    notes.push('Бычья закрытая свеча — триггер лонга')
    reasons.push('bullish_trigger')
  }
  if (volFade) {
    fuelScore += 1
    notes.push('Объём продаж затухает')
    reasons.push('down_vol_fade')
  }
  reasons.push(`dist_local:${distPct.toFixed(2)}`)
  reasons.push(`chg24:${input.chg24hPct.toFixed(1)}`)

  const exhaustConfirm =
    oiExhaust ||
    tapeStall ||
    bookConfirm ||
    volFade ||
    (wick && failed) ||
    (wick && bullish && oiExhaust) ||
    (ctx.postBounce && wick && bullish)

  const technicalEntry =
    bullish ||
    (wick && failed) ||
    (wick && bullish) ||
    (failed && bullish) ||
    (bookConfirm && (wick || failed || stall)) ||
    (ctx.postBounce && wick && (failed || hl || bullish))

  const upConfirm =
    strongBookConfirm ||
    (bullish && tapeUpHard) ||
    (wick && failed && tapeStall) ||
    (ctx.postBounce && bullish && (tapeStall || tapeUpHard || strongBookConfirm))

  if (!exhaustConfirm || !technicalEntry) {
    if (!(technicalFloor && (wick || failed || stall))) return null
  }

  let confidence = 66 + fuelScore * 3
  if (failed && wick) confidence += 5
  if (bullish) confidence += 4
  if (bookConfirm) confidence += 6
  if (strongBookConfirm) confidence += 4
  if (exhaustConfirm) confidence += 3
  if (pressureOk) confidence += 5
  if (upConfirm) confidence += 4
  if (ctx.postBounce) confidence += 6
  if (ctx.higherLowPct >= 4) confidence += 3
  if (input.chg24hPct <= -12 && input.chg24hPct > MEGA_DUMP_CHG) confidence += 2
  if (distPct <= 0.45) confidence += 2
  if (oiRising) confidence -= 4
  if (!ctx.postBounce && ctx.bouncePct < 4) confidence -= 8
  if (!bullish && !bookConfirm) confidence -= 4
  if (!pressureOk) confidence -= 12
  confidence = Math.min(94, Math.max(0, Math.round(confidence)))

  if (confidence < 70) return null

  const stallOnly = stall && !failed && !wick && !hl && !bullish
  const megaDump = input.chg24hPct <= MEGA_DUMP_CHG
  const bounceOkForMega = !megaDump || ctx.bouncePct >= 8 || ctx.postBounce

  const aTier =
    pressureOk &&
    bookConfirm &&
    strongBookConfirm &&
    ctx.postBounce &&
    bounceOkForMega &&
    exhaustConfirm &&
    technicalEntry &&
    upConfirm &&
    !stallOnly &&
    !ctx.freshTip &&
    confidence >= A_MIN_CONF &&
    fuelScore >= A_MIN_FUEL &&
    distPct <= A_MAX_DIST &&
    input.chg24hPct <= A_MIN_DUMP_24H &&
    (wick || failed) &&
    (bullish || (wick && failed)) &&
    ctx.higherLowPct >= A_MIN_HIGHER_LOW_PCT

  const quality: DumpQuality = aTier ? 'A' : 'B'
  reasons.push(`quality:${quality}`)
  reasons.push(`fuel:${fuelScore}`)
  reasons.push(`conf:${confidence}`)
  reasons.push(exhaustConfirm ? 'exhaust_ok' : 'exhaust_weak')
  reasons.push(technicalEntry ? 'tech_ok' : 'tech_weak')
  reasons.push(pressureOk ? 'pressure_ok' : 'pressure_missing')
  reasons.push(bookConfirm ? 'book_ok' : 'book_missing')
  reasons.push(upConfirm ? 'up_confirmed' : 'up_unconfirmed')

  const entry = price
  const sl = Math.min(lo * 0.9975, entry * (1 - SL_PCT))
  return {
    ready: true,
    side: 'LONG',
    setup: 'DUMP_FUEL_FAIL',
    confidence,
    quality,
    fuelScore,
    distToLowPct: distPct,
    limitPrice: entry,
    sl,
    tp: entry * (1 + TP_PCT),
    tp1: entry * (1 + TP1_PCT),
    notes: [
      ctx.postBounce
        ? `Отбой после дампа · LONG`
        : `Лой без топлива продавцов · LONG`,
      `24h ${input.chg24hPct.toFixed(1)}% · к лок.лою +${distPct.toFixed(2)}% · bounce +${ctx.bouncePct.toFixed(1)}% · conf ${confidence}`,
      ...notes.slice(0, 4),
    ],
    reasons,
  }
}
