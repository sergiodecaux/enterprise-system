/**
 * DUMP_FUEL_FAIL — LONG weak selloff AFTER a dump already failed.
 *
 * Mirror of PEAK_FUEL_FAIL SHORT:
 * vertical dump → bounce → consolidation → rejection at higher low
 * (not the tip of the crash candle). Tip-of-dump longs = SL.
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
  phase?: 'structure' | 'final'
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

const FLOOR_DIST_PCT = 3.2
const STRUCTURE_FLOOR_DIST_PCT = 4.2
const A_MAX_DIST = 1.6
const MAX_RISK_PCT = 0.011
const MIN_DUMP_24H = -4
const A_MIN_DUMP_24H = -5
const A_MIN_CONF = 76
const A_MIN_FUEL = 2
const MEGA_DUMP_CHG = -25
const FINAL_MIN_CONF = 70
const STRUCTURE_MIN_CONF = 55

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
  const structurePhase = input.phase === 'structure'
  const minConf = structurePhase ? STRUCTURE_MIN_CONF : FINAL_MIN_CONF
  const maxDist = structurePhase ? STRUCTURE_FLOOR_DIST_PCT : FLOOR_DIST_PCT

  const dumpDay = input.dayBias === 'DUMP' || input.chg24hPct <= MIN_DUMP_24H
  if (!dumpDay) return null
  if (input.dayBias === 'PUMP' && input.chg24hPct > -2) return null

  const ctx = measureDumpContext(input.candles1m, price)
  const lo = ctx.localLo
  if (!(lo > 0) || !(ctx.trough > 0)) return null

  const distPct = ctx.distLocalPct
  if (distPct > maxDist || distPct < -0.15) return null
  if (ctx.freshTip) return null
  if (stillDumpingImpulse(input.candles1m, lo)) return null

  const failed = failedBreakLower(input.candles1m)
  const wick = hammerWick(input.candles1m)
  const hl = higherLowStructure(input.candles1m)
  const stall = stallAtLow(input.candles1m, price, lo)
  const bullish = bullishTriggerCandle(input.candles1m)
  const volFade = downVolumeFade(input.candles1m)
  const chartOk = chartConfirmLong2m(input.candles1m)
  const candleEntry = longCandleEntryOk(input.candles1m)
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
  // Final: need buy-side pressure. Structure: candle reclaim is enough to queue book.
  const pressureOk = Boolean(
    input.absorptionLong ||
      input.cvdBullish ||
      (tapeUpHard && buyFlow != null && buyFlow >= 55) ||
      (bidHeavyStrong && (tapeStall || tapeUpHard || bullish)) ||
      (structurePhase && bullish && (wick || failed || ctx.postBounce))
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
  if (chartOk) {
    fuelScore += 2
    notes.push('2м свечи LONG подтвердили')
    reasons.push('chart_confirm_2m', 'chart_ok', 'score:+2:chart2m')
  } else {
    reasons.push('chart_wait_2m', 'candle_confirm_missing')
  }
  if (candleEntry) reasons.push('candle_entry_ok')
  else reasons.push('candle_entry_wait')
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
  if (!pressureOk && !structurePhase) confidence -= 12
  if (structurePhase && !bookConfirm) confidence += 8
  confidence = Math.min(94, Math.max(0, Math.round(confidence)))
  reasons.push(structurePhase ? 'phase:structure' : 'phase:final')

  if (confidence < minConf) return null

  const stallOnly = stall && !failed && !wick && !hl && !bullish
  const megaDump = input.chg24hPct <= MEGA_DUMP_CHG
  const bounceOkForMega = !megaDump || ctx.bouncePct >= 8 || ctx.postBounce

  const bounceStructure =
    ctx.postBounce ||
    (ctx.bouncePct >= 4 && ctx.troughAgeBars >= 12 && ctx.higherLowPct >= 1)
  // Book path (preferred) OR candle reclaim path for Elite when book not scanned
  const aBook =
    pressureOk &&
    bookConfirm &&
    candleEntry &&
    chartOk &&
    bullish &&
    (strongBookConfirm ||
      (bullish && (wick || failed) && fuelScore >= A_MIN_FUEL + 1)) &&
    bounceStructure &&
    bounceOkForMega &&
    exhaustConfirm &&
    technicalEntry &&
    (upConfirm || strongBookConfirm || (bullish && tapeUpHard)) &&
    !stallOnly &&
    !ctx.freshTip &&
    confidence >= A_MIN_CONF &&
    fuelScore >= A_MIN_FUEL &&
    distPct <= A_MAX_DIST &&
    input.chg24hPct <= A_MIN_DUMP_24H &&
    (wick || failed) &&
    ctx.higherLowPct >= A_MIN_HIGHER_LOW_PCT * 0.7

  const aCandle =
    !bookConfirm &&
    candleEntry &&
    chartOk &&
    bullish &&
    ctx.postBounce &&
    bounceStructure &&
    bounceOkForMega &&
    exhaustConfirm &&
    technicalEntry &&
    !stallOnly &&
    !ctx.freshTip &&
    (wick || failed) &&
    ctx.higherLowPct >= A_MIN_HIGHER_LOW_PCT &&
    ctx.bouncePct >= A_MIN_BOUNCE_PCT &&
    ctx.troughAgeBars >= A_MIN_TROUGH_AGE &&
    confidence >= 78 &&
    fuelScore >= A_MIN_FUEL &&
    distPct <= A_MAX_DIST &&
    input.chg24hPct <= A_MIN_DUMP_24H

  const aTier = aBook || aCandle
  if (aCandle) reasons.push('a_candle_reclaim')

  const quality: DumpQuality = aTier ? 'A' : 'B'
  reasons.push(`quality:${quality}`)
  reasons.push(`fuel:${fuelScore}`)
  reasons.push(`conf:${confidence}`)
  reasons.push(exhaustConfirm ? 'exhaust_ok' : 'exhaust_weak')
  reasons.push(technicalEntry ? 'tech_ok' : 'tech_weak')
  reasons.push(pressureOk ? 'pressure_ok' : 'pressure_missing')
  reasons.push(bookConfirm ? 'book_ok' : 'book_missing')
  reasons.push(upConfirm ? 'up_confirmed' : 'up_unconfirmed')
  reasons.push(chartOk ? 'chart_ok' : 'chart_early')
  reasons.push(candleEntry ? 'candle_entry_ok' : 'candle_entry_wait')
  if (!structurePhase && !candleEntry) reasons.push('final_needs_candle')

  const entry = price
  const atrDist = atrStopDistance(
    input.candles1m,
    entry,
    1.15,
    0.0045,
    MAX_RISK_PCT
  )
  const microLo = microStructureLevel(input.candles1m, 'LONG')
  const stop = memeRiskStop(entry, 'LONG', atrDist, microLo, {
    minPct: 0.0045,
    maxPct: MAX_RISK_PCT,
  })
  if (!stop) {
    reasons.push('sl_structure_too_wide')
    return null
  }
  // Local dump low only if still inside max risk (tighter = higher SL)
  let sl = stop.sl
  const loSl = lo > 0 ? lo * 0.9975 : 0
  if (loSl > 0 && loSl < entry && (entry - loSl) / entry <= MAX_RISK_PCT) {
    sl = Math.max(sl, loSl)
    if ((entry - sl) / entry < 0.0045) sl = entry * (1 - 0.0045)
    reasons.push('sl:local_low')
  }
  reasons.push(...stop.reasons)
  const risk = Math.max(entry - sl, entry * 0.0045)
  const tp1 = entry + risk * 1.15
  const tp = entry + risk * 2.2

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
    tp,
    tp1,
    notes: [
      ctx.postBounce
        ? `Отбой после дампа · LONG`
        : `Лой без топлива продавцов · LONG`,
      `Risk ${(stop.riskPct * 100).toFixed(2)}% · bounce +${ctx.bouncePct.toFixed(1)}% · conf ${confidence}`,
      ...notes.slice(0, 3),
    ],
    reasons,
  }
}
