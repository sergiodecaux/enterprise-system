/**
 * Live structure scenarios: 2–4 paths with probabilities, not a single
 * “reclaim = long” line. Texture (bleed / compression / displacement)
 * decides which MM script is actually running.
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { PathPoint } from '../prediction/types'
import type { LiqHeatmapModel } from '../derivatives/liqHeatmap'
import type { MmTrapThesis } from './mmTrapThesis'
import { readCloseQuality } from './mmTrapThesis'
import type { Fib141Reaction, TfStructure } from './structureRead'
import { deriveAltMacro } from '../analysis/altMacro'
import type { AltBias, AltRegime } from '../../api/marketContext'
import { readAuction, type AuctionRange } from './auction'
import type { CloseCascade } from './closeCascade'
import { closedSlice } from './closeCascade'

export const SCENARIO_COLORS = ['#22d3ee', '#f472b6', '#a78bfa', '#fbbf24'] as const

export type StructureScenarioKind =
  | 'BLEED_FLUSH'
  | 'HUNT_REVERSE'
  | 'RECLAIM_CONTINUE'
  | 'FAILED_RECLAIM'
  | 'RANGE_CHOP'
  | 'IMPULSE'
  | 'FADE_WICK'
  | 'HTF_CONTINUE'
  | 'BREAKOUT'
  | 'SNAP_BACK'
  | 'FIB_MAGNET'
  | 'DISTRIBUTION'
  | 'ACCUMULATION'
  | 'FAILED_RANGE_BREAK'
  | 'RANGE_HOLD'
  | 'TAKE_STOPS'
  | 'PULLBACK_FUEL'

export interface StructureScenario {
  id: 'A' | 'B' | 'C' | 'D'
  kind: StructureScenarioKind
  color: string
  probability: number
  title: string
  why: string
  invalidation: string
  side: 'LONG' | 'SHORT' | 'BOTH'
  path: PathPoint[]
  target: number | null
}

export interface StructureScenarioBoard {
  now: string
  leadId: 'A' | 'B' | 'C' | 'D'
  leadTitle: string
  scenarios: StructureScenario[]
}

const H = 3600

function fmt(p: number): string {
  if (!Number.isFinite(p) || !(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
  if (p >= 0.01) return p.toFixed(5)
  return p.toFixed(6)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function pct(a: number, b: number): number {
  if (!(b > 0)) return 99
  return (Math.abs(a - b) / b) * 100
}

function atr(candles: OhlcvCandle[], n = 14): number {
  if (candles.length < 3) return 0
  const k = Math.min(n, candles.length - 1)
  let sum = 0
  let c = 0
  for (let i = candles.length - k; i < candles.length; i++) {
    const prev = candles[i - 1]
    const cur = candles[i]
    if (!prev || !cur) continue
    const tr = Math.max(
      cur[2] - cur[3],
      Math.abs(cur[2] - prev[4]),
      Math.abs(cur[3] - prev[4])
    )
    sum += tr
    c++
  }
  return c ? sum / c : 0
}

interface TapeTexture {
  grind: 'DOWN' | 'UP' | 'NONE'
  grindBars: number
  compression: number
  lowerHighs: boolean
  higherLows: boolean
  avgBodyPct: number
  displacement: 'UP' | 'DOWN' | 'NONE'
  closePos: number
  overlapping: boolean
}

function readTape(candles: OhlcvCandle[]): TapeTexture {
  const empty: TapeTexture = {
    grind: 'NONE',
    grindBars: 0,
    compression: 0,
    lowerHighs: false,
    higherLows: false,
    avgBodyPct: 0.5,
    displacement: 'NONE',
    closePos: 0.5,
    overlapping: false,
  }
  if (candles.length < 6) return empty
  const last = candles.slice(-8)
  const q = readCloseQuality(last[last.length - 1])
  const displacement =
    q === 'DISPLACEMENT_UP' ? 'UP' : q === 'DISPLACEMENT_DOWN' ? 'DOWN' : 'NONE'

  let bodySum = 0
  let overlap = 0
  let lowerHighs = 0
  let higherLows = 0
  let downCloses = 0
  let upCloses = 0
  let closePos = 0.5
  for (let i = 0; i < last.length; i++) {
    const [, o, h, l, c] = last[i]
    const range = h - l
    const body = Math.abs(c - o)
    bodySum += range > 0 ? body / range : 0
    if (range > 0) closePos = (c - l) / range
    if (c < o) downCloses++
    else if (c > o) upCloses++
    if (i > 0) {
      const prev = last[i - 1]
      if (h < prev[2] - (prev[2] - prev[3]) * 0.05) lowerHighs++
      if (l > prev[3] + (prev[2] - prev[3]) * 0.05) higherLows++
      const ov = Math.min(h, prev[2]) - Math.max(l, prev[3])
      if (ov > 0) overlap++
    }
  }
  const steps = last.length - 1
  const avgBodyPct = bodySum / last.length
  const overlapping = steps > 0 && overlap / steps >= 0.6
  const lh = steps > 0 && lowerHighs / steps >= 0.55
  const hl = steps > 0 && higherLows / steps >= 0.55

  const recent = atr(last, 5)
  const prior = atr(candles.slice(-20), 14)
  const compression =
    prior > 0 ? Math.max(0, Math.min(1, 1 - recent / prior)) : 0

  let grind: TapeTexture['grind'] = 'NONE'
  let grindBars = 0
  const small = avgBodyPct <= 0.42
  if (lh && downCloses >= upCloses && small && displacement !== 'UP') {
    grind = 'DOWN'
    grindBars = lowerHighs + 1
  } else if (hl && upCloses >= downCloses && small && displacement !== 'DOWN') {
    grind = 'UP'
    grindBars = higherLows + 1
  }

  return {
    grind,
    grindBars,
    compression,
    lowerHighs: lh,
    higherLows: hl,
    avgBodyPct,
    displacement,
    closePos,
    overlapping,
  }
}

function mag(
  price: number,
  side: 'LONG' | 'SHORT',
  trap: MmTrapThesis | null,
  h1: TfStructure | null,
  h4: TfStructure | null
): { price: number; label: string } | null {
  if (side === 'SHORT') {
    const p =
      trap?.crowdLongs ??
      h1?.lastSwingLow?.price ??
      h1?.nextSsl ??
      h4?.nextSsl ??
      h1?.dealingLow ??
      null
    if (p != null && p > 0 && p < price) return { price: p, label: 'лонги' }
  } else {
    const p =
      trap?.crowdShorts ??
      h1?.lastSwingHigh?.price ??
      h1?.nextBsl ??
      h4?.nextBsl ??
      h1?.dealingHigh ??
      null
    if (p != null && p > 0 && p > price) return { price: p, label: 'шорты' }
  }
  return null
}

function path(points: Array<[number, number, string?]>): PathPoint[] {
  const out: PathPoint[] = []
  let tPrev = -1
  for (const [t, price, label] of points) {
    if (!(price > 0) || !Number.isFinite(price)) continue
    const time = t <= tPrev ? tPrev + 60 : t
    tPrev = time
    out.push({
      timeOffsetSeconds: Math.round(time),
      price,
      label,
      isKeyLevel: Boolean(label),
    })
  }
  return out
}

function reclaimHeld(
  price: number,
  trap: MmTrapThesis | null,
  last: OhlcvCandle | undefined
): boolean {
  if (!trap?.swept || !last) return false
  if (trap.swept.kind === 'SSL') {
    return (
      last[4] > trap.swept.price &&
      price > trap.swept.price &&
      trap.closeQuality === 'DISPLACEMENT_UP'
    )
  }
  return (
    last[4] < trap.swept.price &&
    price < trap.swept.price &&
    trap.closeQuality === 'DISPLACEMENT_DOWN'
  )
}

function reclaimLost(
  price: number,
  trap: MmTrapThesis | null,
  last: OhlcvCandle | undefined,
  tape: TapeTexture
): boolean {
  if (!trap?.swept) return false
  if (trap.swept.kind === 'SSL') {
    if (price < trap.swept.price || (last && last[4] < trap.swept.price)) return true
    return tape.grind === 'DOWN' || tape.lowerHighs
  }
  if (price > trap.swept.price || (last && last[4] > trap.swept.price)) return true
  return tape.grind === 'UP' || tape.higherLows
}

function chopIn(
  origin: number,
  lo: number,
  hi: number,
  startT: number,
  waves: number,
  step: number
): Array<[number, number, string?]> {
  const pts: Array<[number, number, string?]> = []
  let t = startT
  const n = Math.min(waves, 2)
  for (let i = 0; i < n; i++) {
    t += step
    const toLo = i % 2 === 0
    const depth = 0.22 + (i % 3) * 0.12
    const px = toLo ? lerp(origin, lo, depth) : lerp(origin, hi, depth)
    pts.push([t, px, i === 0 ? 'набор' : undefined])
  }
  return pts
}

function netOf(pts: PathPoint[]): 'UP' | 'DOWN' | 'FLAT' {
  if (pts.length < 2) return 'FLAT'
  const a = pts[0].price
  const b = pts[pts.length - 1].price
  if (b > a * 1.0015) return 'UP'
  if (b < a * 0.9985) return 'DOWN'
  return 'FLAT'
}

type ScenarioCtx = {
  stack: number
  h1: TfStructure | null
  h4: TfStructure | null
  d1: TfStructure | null
  w1: TfStructure | null
  trap: MmTrapThesis | null
  fib?: Fib141Reaction | null
  book: number
  drive: 'UP' | 'DOWN' | 'NEUTRAL'
  mmStopHunt: boolean
  mmHuntSide: 'LONG' | 'SHORT' | null
  mmMicroTarget: number | null
  mmMacroTarget: number | null
  altBias: AltBias | null
  altRegime: AltRegime | null
  fearGreed: number | null
  btcDominance: number | null
  total3Delta: number | null
  newsBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  newsScore: number
  btcRs: number | null
  isBtc: boolean
  cascade: CloseCascade | null
  fuel: { price: number; label: string } | null
}

function tiltWeight(s: RawScenario, ctx: ScenarioCtx): number {
  const dir = s.side === 'LONG' ? 1 : s.side === 'SHORT' ? -1 : 0
  const mag = Math.abs(ctx.stack)
  if (dir === 0) {
    return Math.max(5, s.weight + (mag < 0.28 ? 3 : -4))
  }
  let t = 0
  t += ctx.stack * 5.2 * dir

  const cas = ctx.cascade
  if (cas) {
    t += cas.execution * 8.4 * dir
    t += cas.global * 6.6 * dir
    t += cas.intraday * 3.2 * dir
    const trend = cas.globalSide ?? cas.actionSide
    const withTrend =
      (trend === 'LONG' && s.side === 'LONG') || (trend === 'SHORT' && s.side === 'SHORT')
    if (cas.regime === 'TREND') {
      t += withTrend ? 10 : -12
      if (s.kind === 'HTF_CONTINUE' || s.kind === 'PULLBACK_FUEL') t += 6
    }
    if (cas.regime === 'PULLBACK') {
      if (s.kind === 'PULLBACK_FUEL' || s.kind === 'SNAP_BACK' || s.kind === 'HTF_CONTINUE') t += 11
      if (s.kind === 'IMPULSE' || s.kind === 'BREAKOUT' || s.kind === 'HTF_CONTINUE') {
        const followLtf =
          (cas.entrySide === 'LONG' && s.side === 'LONG') ||
          (cas.entrySide === 'SHORT' && s.side === 'SHORT')
        if (followLtf && !withTrend) t -= 12
      }
      t += withTrend ? 7 : -9
    }
    if (cas.regime === 'COUNTERTREND') {
      if (withTrend) t += 8
      else t -= 10
      if (s.kind === 'IMPULSE' && !withTrend) t -= 8
    }
    if (cas.aligned && withTrend) t += 5
    const q4 = cas.h4?.quality
    const q1 = cas.h1?.quality
    const q15 = cas.m15?.quality
    if (q4 === 'DISPLACEMENT_DOWN' && s.side === 'LONG') t -= 6
    if (q4 === 'DISPLACEMENT_UP' && s.side === 'SHORT') t -= 6
    if (q1 === 'REJECT_HIGH' && s.side === 'LONG') t -= 3
    if (q1 === 'REJECT_LOW' && s.side === 'SHORT') t -= 3
    if (q15 === 'INDECISION' && (s.kind === 'IMPULSE' || s.kind === 'BREAKOUT')) t -= 4
  }

  if (mag >= 1.05) {
    const withHtf =
      (ctx.stack > 0 && s.side === 'LONG') || (ctx.stack < 0 && s.side === 'SHORT')
    t += withHtf ? 5 : -8
  } else if (mag < 0.22) {
    if (
      s.kind === 'RANGE_CHOP' ||
      s.kind === 'RANGE_HOLD' ||
      s.kind === 'TAKE_STOPS' ||
      s.kind === 'FAILED_RANGE_BREAK'
    ) {
      t += 4
    }
  }

  const h4dAgree =
    ctx.h4 &&
    ctx.d1 &&
    ctx.h4.trend !== 'RANGING' &&
    ctx.h4.trend === ctx.d1.trend
  if (h4dAgree) {
    t += (ctx.h4!.trend === 'BULLISH' ? 1 : -1) * dir * 4
  }
  if (ctx.w1?.trend === 'BULLISH') t += dir * 2.4
  if (ctx.w1?.trend === 'BEARISH') t -= dir * 2.4
  if (ctx.d1?.inDiscount && s.side === 'LONG') t += 2
  if (ctx.d1?.inPremium && s.side === 'SHORT') t += 2
  if (ctx.w1?.inDiscount && s.side === 'LONG') t += 1.4
  if (ctx.w1?.inPremium && s.side === 'SHORT') t += 1.4

  if (
    ctx.h1 &&
    ctx.h4 &&
    ctx.h1.trend !== 'RANGING' &&
    ctx.h4.trend !== 'RANGING' &&
    ctx.h1.trend !== ctx.h4.trend
  ) {
    const follow1h =
      (ctx.h1.trend === 'BULLISH' && s.side === 'LONG') ||
      (ctx.h1.trend === 'BEARISH' && s.side === 'SHORT')
    const follow4h =
      (ctx.h4.trend === 'BULLISH' && s.side === 'LONG') ||
      (ctx.h4.trend === 'BEARISH' && s.side === 'SHORT')
    if (follow1h) t -= 5
    if (follow4h) t += 6
  }

  if (ctx.trap?.tradeSide === s.side) t += 5
  if (ctx.trap?.trapSide === s.side) t -= 4.5
  if (ctx.trap?.phase === 'TRADE_READY' && ctx.trap.tradeSide === s.side) t += 3
  if (ctx.trap?.phase === 'HUNTING' || ctx.trap?.phase === 'TRAP') {
    if (s.kind === 'HUNT_REVERSE' || s.kind === 'SNAP_BACK') t += 3.5
    if (s.kind === 'IMPULSE' && ctx.trap.huntSide === s.side) t -= 3
  }

  const fib = ctx.fib
  if (fib?.state === 'INSIDE' || fib?.state === 'APPROACHING') {
    if (fib.bias === 'SHORT' && s.side === 'LONG') t -= 3.2
    if (fib.bias === 'LONG' && s.side === 'SHORT') t -= 3.2
  }
  if ((fib?.state === 'BOUNCE' || fib?.state === 'RECLAIM') && fib.bias === s.side) {
    t += 3.5
  }

  t += ctx.book * 2.2 * dir
  if (ctx.drive === 'UP') t += dir * 3
  if (ctx.drive === 'DOWN') t -= dir * 3

  if (ctx.mmStopHunt) {
    if (s.kind === 'HUNT_REVERSE' || s.kind === 'SNAP_BACK' || s.kind === 'FAILED_RANGE_BREAK') {
      t += 4
    }
    if (s.kind === 'IMPULSE' || s.kind === 'HTF_CONTINUE' || s.kind === 'BREAKOUT') {
      t -= 3.5
    }
  }
  if (ctx.mmHuntSide) {
    const reverse = ctx.mmHuntSide === 'LONG' ? 'SHORT' : 'LONG'
    if (s.kind === 'HUNT_REVERSE' && s.side === reverse) t += 3.5
    if (s.kind === 'TAKE_STOPS' && s.side === ctx.mmHuntSide) t += 2.5
  }
  if (ctx.mmMicroTarget != null && s.target != null && pct(s.target, ctx.mmMicroTarget) < 0.45) {
    t += ctx.mmStopHunt ? (s.kind === 'TAKE_STOPS' || s.kind === 'HUNT_REVERSE' ? 3 : -2) : 1.5
  }
  if (ctx.mmMacroTarget != null && s.target != null && pct(s.target, ctx.mmMacroTarget) < 0.7) {
    if (s.kind === 'HTF_CONTINUE' || s.kind === 'IMPULSE') t += 2
  }

  if (!ctx.isBtc) {
    if (ctx.altBias === 'LONG') t += dir * 3.4
    if (ctx.altBias === 'SHORT') t -= dir * 3.4
    if (ctx.altRegime === 'ALT_ON') t += dir * 2.2
    if (ctx.altRegime === 'ALT_OFF' || ctx.altRegime === 'RISK_OFF') t -= dir * 2.6
    if (ctx.altRegime === 'BTC_LEAD') t -= dir * 1.5
    if (ctx.btcDominance != null) {
      if (ctx.btcDominance >= 55) t -= dir * 2.4
      else if (ctx.btcDominance <= 48) t += dir * 2
    }
    if (ctx.total3Delta != null) {
      if (ctx.total3Delta >= 1) t += dir * 1.8
      if (ctx.total3Delta <= -1) t -= dir * 1.8
    }
    if (ctx.btcRs != null) {
      if (ctx.btcRs >= 2) t += dir * 2
      if (ctx.btcRs <= -2) t -= dir * 2
    }
  } else if (ctx.btcDominance != null && ctx.btcDominance >= 54) {
    t += dir * 1.3
  }

  const fg = ctx.fearGreed
  if (fg != null) {
    if (s.side === 'LONG' && fg <= 25) t += 2.2
    if (s.side === 'LONG' && fg >= 75) t -= 2.4
    if (s.side === 'SHORT' && fg >= 75) t += 2.2
    if (s.side === 'SHORT' && fg <= 25) t -= 2.4
  }
  if (ctx.newsBias === 'BULLISH') t += dir * 1.6
  if (ctx.newsBias === 'BEARISH') t -= dir * 1.6
  if (Number.isFinite(ctx.newsScore) && ctx.newsScore !== 0) {
    t += Math.max(-1.5, Math.min(1.5, ctx.newsScore)) * 2.2 * dir
  }

  return Math.max(4, s.weight + t)
}

function tfWord(tf: TfStructure | null, name: string): string | null {
  if (!tf) return null
  const t =
    tf.trend === 'BULLISH' ? 'бык' : tf.trend === 'BEARISH' ? 'медв' : 'флэт'
  return `${name} ${t}`
}

function stackLine(
  h1: TfStructure | null,
  h4: TfStructure | null,
  d1: TfStructure | null,
  w1: TfStructure | null,
  stack: number
): string {
  const parts = [
    tfWord(h1, '1ч'),
    tfWord(h4, '4ч'),
    tfWord(d1, 'день'),
    tfWord(w1, 'нед'),
  ].filter((x): x is string => x != null)
  const mag = Math.abs(stack)
  const force = mag >= 1.05 ? 'сильный' : mag >= 0.4 ? 'средний' : 'слабый'
  const dir =
    stack >= 0.28 ? 'вверх' : stack <= -0.28 ? 'вниз' : 'без явного направления'
  const extra =
    h1 && h4 && h1.trend !== 'RANGING' && h4.trend !== 'RANGING' && h1.trend !== h4.trend
      ? ' Час против 4ч — час чаще охота, не тренд.'
      : ''
  return `Стек ТФ ${force} ${dir}${parts.length ? ` (${parts.join(' · ')})` : ''}.${extra}`
}

function nowCopy(
  tape: TapeTexture,
  trap: MmTrapThesis | null,
  price: number,
  h1: TfStructure | null,
  h4: TfStructure | null,
  d1: TfStructure | null,
  w1: TfStructure | null,
  auction: AuctionRange | null,
  stack: number,
  cascade: CloseCascade | null
): string {
  const bits: string[] = []
  if (auction) {
    if (auction.kind === 'FAILED_BREAK_DOWN') {
      bits.push(
        `Был боковик ${fmt(auction.bottom)}–${fmt(auction.top)}. Пробили вниз, сняли ${auction.lowLabel} и вернули цену внутрь — шорт пробоя не удержали.`
      )
    } else if (auction.kind === 'FAILED_BREAK_UP') {
      bits.push(
        `Боковик ${fmt(auction.bottom)}–${fmt(auction.top)}. Вынос хая не закрепили, стопы шортов сняли и вернули внутрь.`
      )
    } else if (auction.kind === 'BREAK_DOWN') {
      bits.push(
        `Диапазон ${fmt(auction.bottom)}–${fmt(auction.top)} потерян телом вниз. Пока нет возврата над ${fmt(auction.bottom)}, это не боковик.`
      )
    } else if (auction.kind === 'BREAK_UP') {
      bits.push(
        `Диапазон пробит телом вверх. Закреп над ${fmt(auction.top)} — иначе это вынос шортов, не тренд.`
      )
    } else if (auction.kind === 'INSIDE') {
      bits.push(
        `Цена в диапазоне ${fmt(auction.bottom)}–${fmt(auction.top)}. Стопы: ${auction.lowLabel} ${fmt(auction.stopsLow)} / ${auction.highLabel} ${fmt(auction.stopsHigh)}.`
      )
    }
  }
  if (!auction) {
    if (tape.grind === 'DOWN') {
      bits.push(
        tape.compression > 0.35
          ? 'Поджимают вниз мелкими телами — готовят пролив, не лонг.'
          : 'Час режет хаи мелкими телами. Поджим, не смещение.'
      )
    } else if (tape.grind === 'UP') {
      bits.push('Час поднимает лои без широкого тела. Могут добрать шорты и развернуть.')
    } else if (tape.displacement === 'UP') {
      bits.push('Последний час закрылся телом вверх — смещение настоящее.')
    } else if (tape.displacement === 'DOWN') {
      bits.push('Последний час закрылся телом вниз — смещение настоящее.')
    }
  }

  if (trap?.swept?.kind === 'SSL' && trap.reclaimLevel != null && auction?.kind !== 'FAILED_BREAK_DOWN') {
    const held = price > trap.reclaimLevel
    bits.push(
      held
        ? `Цена над снятым лоем ${fmt(trap.reclaimLevel)}, но закреп — только тело, которое держат следующие часы.`
        : `Лои сняли у ${fmt(trap.swept.price)}, цена не держит уровень — лонг с закрепа сейчас не читается.`
    )
  } else if (trap?.swept?.kind === 'BSL' && trap.reclaimLevel != null) {
    const held = price < trap.reclaimLevel
    bits.push(
      held
        ? `Цена под снятым хаем ${fmt(trap.reclaimLevel)}.`
        : `Хаи сняли у ${fmt(trap.swept.price)}, шорт с закрепа ещё не факт.`
    )
  }

  if (cascade?.line) bits.unshift(cascade.line)
  else bits.push(stackLine(h1, h4, d1, w1, stack))
  return bits.slice(0, 3).join(' ')
}

function compactPath(pts: PathPoint[]): PathPoint[] {
  if (pts.length <= 3) return pts
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (!first || !last) return pts
  let bend = pts[Math.floor(pts.length / 2)] ?? last
  let best = 0
  const dt = last.timeOffsetSeconds - first.timeOffsetSeconds || 1
  const dp = last.price - first.price
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]
    const t = (p.timeOffsetSeconds - first.timeOffsetSeconds) / dt
    const line = first.price + dp * t
    const d = Math.abs(p.price - line)
    if (d >= best) {
      best = d
      bend = p
    }
  }
  return [first, bend, last]
}

function spreadProbs(weights: number[]): number[] {
  if (!weights.length) return []
  if (weights.length === 1) return [100]
  const pow = weights.map((w) => Math.pow(Math.max(0.5, w), 1.9))
  const sum = pow.reduce((a, b) => a + b, 0) || 1
  const pcts = pow.map((p) => (p / sum) * 100)
  if (pcts[0] < 54) {
    const bump = 54 - pcts[0]
    const rest = pcts.slice(1).reduce((a, b) => a + b, 0) || 1
    pcts[0] = 54
    for (let i = 1; i < pcts.length; i++) pcts[i] -= bump * (pcts[i] / rest)
  }
  if (pcts.length >= 2 && pcts[0] - pcts[1] < 16) {
    const gap = (16 - (pcts[0] - pcts[1])) / 2
    pcts[0] += gap
    pcts[1] -= gap
  }
  const rounded = pcts.map((p) => Math.max(8, Math.round(p)))
  const drift = rounded.reduce((a, b) => a + b, 0) - 100
  rounded[0] = Math.max(8, rounded[0] - drift)
  return rounded
}

function pickBoard(sorted: RawScenario[]): RawScenario[] {
  if (!sorted[0]) return []
  const lead = sorted[0]
  const picked: RawScenario[] = [lead]
  const leadNet = netOf(lead.path)
  const opp = sorted.find(
    (s) => s !== lead && netOf(s.path) !== 'FLAT' && netOf(s.path) !== leadNet
  )
  if (opp && opp.weight >= lead.weight * 0.4) picked.push(opp)
  else if (sorted[1] && sorted[1].weight >= lead.weight * 0.62) picked.push(sorted[1])
  if (lead.weight >= (sorted[1]?.weight ?? 0) * 1.7) return picked.slice(0, Math.min(2, picked.length))
  return picked.slice(0, 2)
}

interface RawScenario {
  kind: StructureScenarioKind
  weight: number
  title: string
  why: string
  invalidation: string
  side: 'LONG' | 'SHORT' | 'BOTH'
  path: PathPoint[]
  target: number | null
}

export function buildStructureScenarios(input: {
  price: number
  candlesTape?: OhlcvCandle[]
  candles1h?: OhlcvCandle[]
  h1: TfStructure | null
  h4: TfStructure | null
  d1: TfStructure | null
  w1?: TfStructure | null
  htfStack?: number
  fib?: Fib141Reaction | null
  trap: MmTrapThesis | null
  bookImbalance?: number | null
  mmDrive?: 'UP' | 'DOWN' | 'NEUTRAL' | null
  mmStopHunt?: boolean
  mmHuntSide?: 'LONG' | 'SHORT' | null
  mmMicroTarget?: number | null
  mmMacroTarget?: number | null
  liq?: LiqHeatmapModel | null
  equalHighs?: Array<{ price: number; strength: string; isActive: boolean }>
  equalLows?: Array<{ price: number; strength: string; isActive: boolean }>
  altBias?: AltBias | null
  altRegime?: AltRegime | null
  fearGreed?: number | null
  btcDominance?: number | null
  btcDomDelta24h?: number | null
  total3Delta24h?: number | null
  newsBias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  newsScore?: number
  btcRs?: number | null
  isBtc?: boolean
  cascade?: CloseCascade | null
  fuel?: { price: number; label: string } | null
  tapeBarMs?: number
}): StructureScenarioBoard {
  const price = input.price
  const tapeRaw =
    input.candlesTape && input.candlesTape.length >= 8
      ? input.candlesTape
      : input.candles1h ?? []
  const tapeSrc = closedSlice(tapeRaw, input.tapeBarMs ?? 3_600_000)
  const tape = readTape(tapeSrc.length >= 6 ? tapeSrc : tapeRaw)
  const last = tapeSrc[tapeSrc.length - 1] ?? tapeRaw[tapeRaw.length - 1]
  const origin =
    last && Number.isFinite(last[4]) && last[4] > 0 ? last[4] : price
  const trap = input.trap
  const h1 = input.h1
  const h4 = input.h4
  const d1 = input.d1
  const w1 = input.w1 ?? null
  const book = input.bookImbalance ?? 0
  const drive = input.mmDrive ?? 'NEUTRAL'
  const atr1 = atr(tapeSrc.length >= 8 ? tapeSrc : input.candles1h ?? [], 14) || price * 0.008
  const longs = mag(price, 'SHORT', trap, h1, h4)
  const shorts = mag(price, 'LONG', trap, h1, h4)
  const distL = longs ? pct(longs.price, price) : 99
  const distS = shorts ? pct(shorts.price, price) : 99
  const htfDown = h4?.trend === 'BEARISH' || d1?.trend === 'BEARISH'
  const htfUp = h4?.trend === 'BULLISH' || d1?.trend === 'BULLISH'
  const premium = Boolean(h1?.inPremium || d1?.inPremium)
  const discount = Boolean(h1?.inDiscount || d1?.inDiscount)
  const fibTrapLong = input.fib?.state === 'INSIDE' && premium
  const held = reclaimHeld(price, trap, last)
  const lost = reclaimLost(price, trap, last, tape)
  const auction = readAuction(
    tapeSrc.length >= 16 ? tapeSrc : input.candles1h ?? tapeSrc,
    price,
    input.liq,
    input.equalHighs,
    input.equalLows
  )
  const stack = input.htfStack ?? 0
  const macro = deriveAltMacro({
    btcDominance: input.btcDominance,
    btcDomDelta24h: input.btcDomDelta24h,
    total3Delta24h: input.total3Delta24h,
    altRegime: input.altRegime,
    altBias: input.altBias,
  })
  const tiltCtx: ScenarioCtx = {
    stack,
    h1,
    h4,
    d1,
    w1,
    trap,
    fib: input.fib,
    book,
    drive,
    mmStopHunt: Boolean(input.mmStopHunt),
    mmHuntSide: input.mmHuntSide ?? trap?.huntSide ?? null,
    mmMicroTarget: input.mmMicroTarget ?? null,
    mmMacroTarget: input.mmMacroTarget ?? null,
    altBias: input.altBias ?? macro.altBias,
    altRegime: input.altRegime ?? macro.regime,
    fearGreed: input.fearGreed ?? null,
    btcDominance: input.btcDominance ?? null,
    total3Delta: input.total3Delta24h ?? null,
    newsBias: input.newsBias ?? 'NEUTRAL',
    newsScore: input.newsScore ?? 0,
    btcRs: input.btcRs ?? null,
    isBtc: Boolean(input.isBtc),
    cascade: input.cascade ?? null,
    fuel: input.fuel ?? null,
  }
  const raw: RawScenario[] = []

  const cas = input.cascade ?? null
  const fuel = input.fuel ?? null
  const trendSide = cas?.globalSide ?? cas?.actionSide ?? null
  if (fuel && trendSide && (cas?.regime === 'PULLBACK' || cas?.regime === 'TREND')) {
    const up = trendSide === 'LONG'
    const cont = up
      ? shorts?.price ?? h4?.nextBsl ?? h4?.dealingHigh ?? origin + atr1 * 1.8
      : longs?.price ?? h4?.nextSsl ?? h4?.dealingLow ?? origin - atr1 * 1.8
    const pullW =
      (cas?.regime === 'PULLBACK' ? 40 : 22) +
      (h4 && ((up && h4.trend === 'BULLISH') || (!up && h4.trend === 'BEARISH')) ? 8 : 0)
    raw.push({
      kind: 'PULLBACK_FUEL',
      weight: pullW,
      title: up
        ? 'Откат в топливо лонгов → дальше по 4ч'
        : 'Откат в топливо шортов → дальше по 4ч',
      why: `${cas?.line ?? ''} 15м — место входа, не тренд. Небольшой откат в ${fuel.label} ${fmt(fuel.price)}, оттуда топливо на ход к ${fmt(cont)}.`,
      invalidation: up
        ? `Слом тренда: 4ч закроется телом под ${fmt(h4?.lastSwingLow?.price ?? fuel.price)}.`
        : `Слом тренда: 4ч закроется телом над ${fmt(h4?.lastSwingHigh?.price ?? fuel.price)}.`,
      side: trendSide,
      target: cont,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.2, fuel.price, fuel.label],
        [H * 3.6, cont, up ? 'по тренду вверх' : 'по тренду вниз'],
      ]),
    })
  }

  if (auction) {
    const { top, bottom, mid, stopsHigh, stopsLow } = auction
    const lo = Math.min(origin, lerp(origin, bottom, 0.7))
    const hi = Math.max(origin, lerp(origin, top, 0.7))
    if (auction.kind === 'FAILED_BREAK_DOWN') {
      raw.push({
        kind: 'FAILED_RANGE_BREAK',
        weight: 34 + (auction.strongLow ? 6 : 0) + (htfUp ? 6 : 0),
        title: 'Вернули диапазон → к стопам шортов',
        why: `Пробой вниз не удержали: ${auction.lowLabel} уже сняли. Дальше цена обычно не «летит вверх стрелкой», а набирает у лоя ${fmt(bottom)} и идёт в ${auction.highLabel} ${fmt(stopsHigh)}.`,
        invalidation: `Слом: час закроется телом обратно под ${fmt(bottom)}.`,
        side: 'LONG',
        target: stopsHigh,
        path: path([
          [0, origin, 'сейчас'],
          ...chopIn(origin, bottom, mid, 0, 4, H * 0.55),
          [H * 3.4, lerp(origin, bottom, 0.35), 'ретест лоя'],
          [H * 4.2, mid, 'внутрь диапазона'],
          [H * 6.2, stopsHigh, auction.highLabel],
        ]),
      })
      raw.push({
        kind: 'RANGE_HOLD',
        weight: 18 + (htfDown ? 10 : 0) + (drive === 'DOWN' ? 6 : 0),
        title: 'Второй пробой — не удержали возврат',
        why: `Если набор у ${fmt(bottom)} не даст тела, диапазон потеряют снова. Тогда идут в следующую пачку лонгов ${fmt(stopsLow < bottom ? stopsLow : bottom - atr1 * 1.4)}.`,
        invalidation: `Слом: два часа держатся над ${fmt(bottom)}.`,
        side: 'SHORT',
        target: Math.min(stopsLow, bottom - atr1),
        path: path([
          [0, origin, 'сейчас'],
          ...chopIn(origin, bottom, mid, 0, 3, H * 0.5),
          [H * 2.8, bottom, 'теряют лой'],
          [H * 3.6, bottom - (top - bottom) * 0.12, 'слом'],
          [H * 5.8, Math.min(stopsLow, bottom - atr1 * 1.2), auction.lowLabel],
        ]),
      })
    } else if (auction.kind === 'FAILED_BREAK_UP') {
      raw.push({
        kind: 'FAILED_RANGE_BREAK',
        weight: 34 + (auction.strongHigh ? 6 : 0) + (htfDown ? 6 : 0),
        title: 'Вынос хая не закрепили → к лонгам',
        why: `${auction.highLabel} сняли и вернули внутрь. Дальше набор под хаем ${fmt(top)} и ход в ${auction.lowLabel} ${fmt(stopsLow)}.`,
        invalidation: `Слом: час закроется телом над ${fmt(top)}.`,
        side: 'SHORT',
        target: stopsLow,
        path: path([
          [0, origin, 'сейчас'],
          ...chopIn(origin, mid, top, 0, 4, H * 0.55),
          [H * 3.4, lerp(origin, top, 0.35), 'ретест хая'],
          [H * 4.2, mid, 'внутрь'],
          [H * 6.2, stopsLow, auction.lowLabel],
        ]),
      })
      raw.push({
        kind: 'RANGE_HOLD',
        weight: 18 + (htfUp ? 10 : 0),
        title: 'Всё-таки закреп над диапазоном',
        why: `Если следующее тело удержится над ${fmt(top)}, это уже не вынос, а слом. Тогда к следующей ликвидности сверху.`,
        invalidation: `Слом: возврат телом под ${fmt(top)}.`,
        side: 'LONG',
        target: top + (top - bottom) * 0.6,
        path: path([
          [0, origin, 'сейчас'],
          ...chopIn(origin, mid, top, 0, 3, H * 0.5),
          [H * 2.8, top, 'хай'],
          [H * 3.8, top + (top - bottom) * 0.1, 'закреп'],
          [H * 5.8, top + (top - bottom) * 0.55, 'вынос дальше'],
        ]),
      })
    } else if (auction.kind === 'INSIDE') {
      raw.push({
        kind: 'TAKE_STOPS',
        weight: 24 + (auction.strongHigh ? 5 : 0) + (distS < distL ? 6 : 0),
        title: 'Набор в диапазоне → снятие шортов',
        why: `Стопы шортов на ${fmt(stopsHigh)} (${auction.highLabel}${auction.strongHigh ? ', плотные' : ''}). Сначала пила ${fmt(bottom)}–${fmt(top)}, потом вынос хая — это не лонг из середины.`,
        invalidation: `Слом: закреп телом под ${fmt(bottom)}.`,
        side: 'LONG',
        target: stopsHigh,
        path: path([
          [0, origin, 'сейчас'],
          ...chopIn(origin, lo, hi, 0, 4, H * 0.5),
          [H * 3.6, lerp(origin, top, 0.7), 'к хаю'],
          [H * 5.5, stopsHigh, auction.highLabel],
        ]),
      })
      raw.push({
        kind: 'TAKE_STOPS',
        weight: 24 + (auction.strongLow ? 5 : 0) + (distL < distS ? 6 : 0),
        title: 'Набор в диапазоне → снятие лонгов',
        why: `Стопы лонгов на ${fmt(stopsLow)} (${auction.lowLabel}${auction.strongLow ? ', плотные' : ''}). Та же пила, другой край. Пока нет тела за границу — оба хода живы.`,
        invalidation: `Слом: закреп телом над ${fmt(top)}.`,
        side: 'SHORT',
        target: stopsLow,
        path: path([
          [0, origin, 'сейчас'],
          ...chopIn(origin, lo, hi, 0, 4, H * 0.52),
          [H * 3.6, lerp(origin, bottom, 0.7), 'к лою'],
          [H * 5.5, stopsLow, auction.lowLabel],
        ]),
      })
    } else if (auction.kind === 'BREAK_DOWN') {
      raw.push({
        kind: 'IMPULSE',
        weight: 28 + (htfDown ? 8 : 0),
        title: 'Диапазон потерян — добор лонгов',
        why: `Тело под ${fmt(bottom)}. Возврат в боковик ещё не факт. Цель — ${auction.lowLabel} ${fmt(stopsLow)}.`,
        invalidation: `Слом: закреп телом обратно над ${fmt(bottom)}.`,
        side: 'SHORT',
        target: stopsLow,
        path: path([
          [0, origin, 'сейчас'],
          [H * 0.9, lerp(origin, bottom, 0.5), 'ретест снизу'],
          [H * 1.8, bottom - (top - bottom) * 0.08, 'не пускают'],
          [H * 4.4, stopsLow, auction.lowLabel],
        ]),
      })
      raw.push({
        kind: 'FAILED_RANGE_BREAK',
        weight: 16 + (htfUp ? 8 : 0),
        title: 'Ложный слом — вернут в диапазон',
        why: `Как на типичном BTC: пробой шортом, набор под лоем, возврат внутрь к ${fmt(stopsHigh)}. Для этого нужно тело над ${fmt(bottom)}.`,
        invalidation: `Слом возврата: час не может закрыться над ${fmt(bottom)}.`,
        side: 'LONG',
        target: mid,
        path: path([
          [0, origin, 'сейчас'],
          ...chopIn(origin, origin * 0.998, bottom, 0, 3, H * 0.5),
          [H * 2.6, bottom, 'бой за лой'],
          [H * 4.0, mid, 'внутрь'],
          [H * 5.8, stopsHigh, auction.highLabel],
        ]),
      })
    } else if (auction.kind === 'BREAK_UP') {
      raw.push({
        kind: 'IMPULSE',
        weight: 28 + (htfUp ? 8 : 0),
        title: 'Диапазон сломан вверх — добор шортов',
        why: `Тело над ${fmt(top)}. Если удержат, идут в ${auction.highLabel} ${fmt(stopsHigh)}.`,
        invalidation: `Слом: закреп телом обратно под ${fmt(top)}.`,
        side: 'LONG',
        target: stopsHigh,
        path: path([
          [0, origin, 'сейчас'],
          [H * 0.9, lerp(origin, top, 0.5), 'ретест сверху'],
          [H * 4.4, stopsHigh, auction.highLabel],
        ]),
      })
      raw.push({
        kind: 'FAILED_RANGE_BREAK',
        weight: 16 + (htfDown ? 8 : 0),
        title: 'Вынос шортов — вернут в диапазон',
        why: `Пробой может быть охотой. Возврат под ${fmt(top)} → к ${fmt(stopsLow)}.`,
        invalidation: `Слом: два часа держатся над ${fmt(top)}.`,
        side: 'SHORT',
        target: stopsLow,
        path: path([
          [0, origin, 'сейчас'],
          ...chopIn(origin, top, origin * 1.002, 0, 3, H * 0.5),
          [H * 2.6, top, 'теряют хай'],
          [H * 4.0, mid, 'внутрь'],
          [H * 5.8, stopsLow, auction.lowLabel],
        ]),
      })
    }
  }

  // 1) Slow squeeze then flush — the script the old HUD ignored
  {
    const down =
      tape.grind === 'DOWN' ||
      (tape.lowerHighs && tape.displacement !== 'UP' && tape.avgBodyPct < 0.45)
    const up =
      tape.grind === 'UP' ||
      (tape.higherLows && tape.displacement !== 'DOWN' && tape.avgBodyPct < 0.45)
    if (down) {
      let w = 22 + tape.grindBars * 4 + tape.compression * 18
      if (htfDown) w += 12
      if (htfUp) w -= 10
      if (book < -0.12) w += 8
      if (drive === 'DOWN') w += 10
      if (drive === 'UP') w -= 6
      if (longs && distL <= 2.2) w += 10
      if (tape.displacement === 'DOWN') w += 8
      if (held && trap?.swept?.kind === 'SSL') w -= 16
      if (fibTrapLong) w += 6
      const target = longs?.price ?? (h1?.dealingLow ?? price - atr1 * 2.4)
      const mid = lerp(price, target, 0.28)
      const squeeze = lerp(price, target, 0.48)
      raw.push({
        kind: 'BLEED_FLUSH',
        weight: w,
        title: 'Поджим вниз → пролив',
        why: `Хаи ниже, тела ~${Math.round(tape.avgBodyPct * 100)}% диапазона${
          tape.compression > 0.3 ? ', волатильность сжалась' : ''
        }. Так не «лонг с другой зоны» — так выжимают заявки и потом срывают лонги${
          longs ? ` к ${fmt(longs.price)}` : ''
        }.`,
        invalidation: `Слом варианта: час закроется телом выше ${fmt(
          h1?.lastSwingHigh?.price ?? price + atr1 * 0.9
        )}, не фитилём.`,
        side: 'SHORT',
        target,
        path: path([
          [0, origin, 'сейчас'],
          [H * 0.9, lerp(price, mid, 0.7), 'поджим'],
          [H * 1.8, mid, 'ещё ниже'],
          [H * 2.7, squeeze, 'сжатие'],
          [H * 4.4, target, longs ? 'пролив в лонги' : 'пролив'],
        ]),
      })
    } else if (up) {
      let w = 20 + tape.grindBars * 4 + tape.compression * 16
      if (htfUp) w += 10
      if (htfDown) w -= 10
      if (book > 0.12) w += 8
      if (drive === 'UP') w += 10
      if (shorts && distS <= 2.2) w += 10
      if (held && trap?.swept?.kind === 'BSL') w -= 16
      const target = shorts?.price ?? (h1?.dealingHigh ?? price + atr1 * 2.4)
      raw.push({
        kind: 'BLEED_FLUSH',
        weight: w,
        title: 'Поджим вверх → вынос шортов',
        why: `Лои выше без широкого тела. Могут дотянуть до шортов${
          shorts ? ` ${fmt(shorts.price)}` : ''
        } и там решить — закреп или слив.`,
        invalidation: `Слом: час телом ниже ${fmt(
          h1?.lastSwingLow?.price ?? price - atr1 * 0.9
        )}.`,
        side: 'LONG',
        target,
        path: path([
          [0, origin, 'сейчас'],
          [H * 0.9, lerp(price, target, 0.25), 'поджим'],
          [H * 1.8, lerp(price, target, 0.5), 'ещё выше'],
          [H * 3.6, target, shorts ? 'шорты' : 'вынос'],
        ]),
      })
    }
  }

  // 2) Hunt nearer crowd, then reverse — classic MM
  if (longs || shorts) {
    const huntShorts = shorts && distS <= distL
    const nearer = huntShorts ? shorts : longs
    const later = huntShorts ? longs : shorts
    if (nearer) {
      let w = 18
      if (pct(nearer.price, price) <= 1.4) w += 12
      else if (pct(nearer.price, price) <= 2.4) w += 6
      if (trap?.phase === 'HUNTING' || trap?.phase === 'TRAP') w += 8
      if (premium && huntShorts) w += 8
      if (discount && !huntShorts) w += 8
      if (tape.displacement !== 'NONE') w -= 6
      const laterPx =
        later?.price ??
        (huntShorts ? price - atr1 * 2.1 : price + atr1 * 2.1)
      raw.push({
        kind: 'HUNT_REVERSE',
        weight: w,
        title: huntShorts
          ? 'Сначала шорты, потом вниз'
          : 'Сначала лонги, потом вверх',
        why: huntShorts
          ? `Ближе висят шорты ${fmt(nearer.price)} (${pct(nearer.price, price).toFixed(2)}%). Их снимают раньше, чем «лонг с закрепа». После снятия без тела над уровнем — возврат${later ? ` в лонги ${fmt(later.price)}` : ''}.`
          : `Ближе висят лонги ${fmt(nearer.price)}. Сначала снятие, не шорт в рынок. Если уровень не удержали телом — разворот вверх${later ? ` к ${fmt(later.price)}` : ''}.`,
        invalidation: huntShorts
          ? `Слом: закреп телом над ${fmt(nearer.price)} и удержание следующего часа.`
          : `Слом: закреп телом под ${fmt(nearer.price)} и удержание следующего часа.`,
        side: 'BOTH',
        target: laterPx,
        path: path([
          [0, origin, 'сейчас'],
          [H * 1.1, lerp(price, nearer.price, 0.7), 'охота'],
          [H * 2.0, nearer.price, huntShorts ? 'снятие шортов' : 'снятие лонгов'],
          [H * 3.2, lerp(nearer.price, laterPx, 0.35), 'возврат'],
          [H * 5.2, laterPx, later ? later.label : 'разворот'],
        ]),
      })
    }
  }

  // 3) Genuine reclaim continuation — only if the close actually holds
  if (trap?.swept && held && !lost) {
    const isLong = trap.swept.kind === 'SSL'
    let w = 16
    if (tape.displacement === (isLong ? 'UP' : 'DOWN')) w += 16
    if (isLong && htfUp) w += 10
    if (!isLong && htfDown) w += 10
    if (isLong && htfDown) w -= 14
    if (!isLong && htfUp) w -= 14
    if (tape.grind === (isLong ? 'DOWN' : 'UP')) w -= 18
    const target = isLong
      ? shorts?.price ?? h4?.nextBsl ?? h1?.dealingHigh ?? price + atr1 * 2
      : longs?.price ?? h4?.nextSsl ?? h1?.dealingLow ?? price - atr1 * 2
    const rec = trap.reclaimLevel ?? trap.swept.price
    raw.push({
      kind: 'RECLAIM_CONTINUE',
      weight: w,
      title: isLong ? 'Закреп держит — вынос шортов' : 'Закреп держит — слив лонгов',
      why: isLong
        ? `Сняли лои и закрылись телом над ${fmt(rec)}. Это единственный лонг, который сейчас имеет право: не «если закреп», а факт закрытия. Цель — ${shorts ? `шорты ${fmt(shorts.price)}` : 'ликвидность сверху'}.`
        : `Сняли хаи и закрылись телом под ${fmt(rec)}. Шорт по факту, не по BOS. Цель — ${longs ? `лонги ${fmt(longs.price)}` : 'ликвидность снизу'}.`,
      invalidation: isLong
        ? `Слом: час закроется обратно под ${fmt(rec)}.`
        : `Слом: час закроется обратно над ${fmt(rec)}.`,
      side: isLong ? 'LONG' : 'SHORT',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.3, lerp(price, rec, 0.45), 'ретест закрепа'],
        [H * 2.2, rec, 'держат'],
        [H * 5.0, target, isLong ? 'шорты' : 'лонги'],
      ]),
    })
  }

  // 4) Failed spring — they swept, then walked it back
  if (trap?.swept && (lost || !held)) {
    const springLong = trap.swept.kind === 'SSL'
    let w = 14
    if (lost) w += 12
    if (tape.grind === (springLong ? 'DOWN' : 'UP')) w += 14
    if (trap.closeQuality === 'REJECT_LOW' && springLong) w += 8
    if (trap.closeQuality === 'REJECT_HIGH' && !springLong) w += 8
    if (held) w -= 20
    if (springLong && htfDown) w += 10
    if (!springLong && htfUp) w += 10
    const target = springLong
      ? longs?.price ?? h1?.dealingLow ?? price - atr1 * 2.2
      : shorts?.price ?? h1?.dealingHigh ?? price + atr1 * 2.2
    const rec = trap.reclaimLevel ?? trap.swept.price
    raw.push({
      kind: 'FAILED_RECLAIM',
      weight: w,
      title: springLong ? 'Пружина не удержалась — вниз' : 'Пружина не удержалась — вверх',
      why: springLong
        ? `Лои сняли у ${fmt(trap.swept.price)}, но тела над ${fmt(rec)} нет${
            tape.grind === 'DOWN' ? ', плюс час уже поджимает вниз' : ''
          }. Это не «лонг с другой зоны» — это срыв пружины в тех, кто купил фитиль.`
        : `Хаи сняли у ${fmt(trap.swept.price)}, закреп под ${fmt(rec)} не держится. Кто шортил фитиль — кормят обратно.`,
      invalidation: springLong
        ? `Слом: два часа подряд закрываются над ${fmt(rec)}.`
        : `Слом: два часа подряд закрываются под ${fmt(rec)}.`,
      side: springLong ? 'SHORT' : 'LONG',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.0, lerp(price, rec, 0.6), 'теряют уровень'],
        [H * 1.8, rec, 'срыв закрепа'],
        [H * 4.2, target, springLong ? 'лонги' : 'шорты'],
      ]),
    })
  }

  // 5) Chop in the 1H dealing range
  if (h1 && price <= h1.dealingHigh && price >= h1.dealingLow) {
    const span = h1.dealingHigh - h1.dealingLow
    if (span > 0 && pct(h1.dealingHigh, h1.dealingLow) >= 0.6) {
      let w = 10
      if (tape.grind === 'NONE' && tape.displacement === 'NONE') w += 10
      if (tape.overlapping) w += 6
      if (trap?.phase === 'NEUTRAL') w += 6
      if (tape.grind !== 'NONE') w -= 8
      raw.push({
        kind: 'RANGE_CHOP',
        weight: w,
        title: 'Пила в диапазоне часа',
        why: `Цена внутри ${fmt(h1.dealingLow)}–${fmt(h1.dealingHigh)}. Пока нет тела за край, оба направления — шум. Ждём выход и закреп за границей, не ловим середину.`,
        invalidation: `Слом пилы: закреп телом за ${fmt(h1.dealingHigh)} или за ${fmt(h1.dealingLow)}.`,
        side: 'BOTH',
        target: (h1.dealingHigh + h1.dealingLow) / 2,
        path: path([
          [0, origin, 'сейчас'],
          [H * 1.2, lerp(price, h1.dealingHigh, 0.55), 'к хаю диапазона'],
          [H * 2.6, lerp(price, h1.dealingLow, 0.55), 'к лою'],
          [H * 4.0, (h1.dealingHigh + h1.dealingLow) / 2, 'середина'],
        ]),
      })
    }
  }

  // Impulse already in play — follow the body, not the story
  if (tape.displacement === 'UP' || tape.displacement === 'DOWN') {
    const up = tape.displacement === 'UP'
    let w = 20
    if (up && htfUp) w += 12
    if (!up && htfDown) w += 12
    if (up && htfDown) w -= 8
    if (!up && htfUp) w -= 8
    if (drive === (up ? 'UP' : 'DOWN')) w += 8
    const target = up
      ? shorts?.price ?? h4?.nextBsl ?? price + atr1 * 1.8
      : longs?.price ?? h4?.nextSsl ?? price - atr1 * 1.8
    raw.push({
      kind: 'IMPULSE',
      weight: w,
      title: up ? 'Импульс вверх продолжают' : 'Импульс вниз продолжают',
      why: up
        ? `Час закрылся телом вверх. Пока следующее тело не развернёт, логика — добор ликвидности сверху${shorts ? ` (${fmt(shorts.price)})` : ''}, не поиск лонга «с закрепа».`
        : `Час закрылся телом вниз. Пока покупатель не вернул уровень телом, ждут продолжение к лонгам${longs ? ` ${fmt(longs.price)}` : ''}.`,
      invalidation: up
        ? `Слом: час закроется телом ниже ${fmt(last?.[3] ?? price - atr1)}.`
        : `Слом: час закроется телом выше ${fmt(last?.[2] ?? price + atr1)}.`,
      side: up ? 'LONG' : 'SHORT',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.2, lerp(origin, target, 0.4), 'продолжение'],
        [H * 3.4, target, up ? 'ликвидность сверху' : 'ликвидность снизу'],
      ]),
    })
  }

  // Fade the wick — spike is the trap
  if (trap?.closeQuality === 'REJECT_HIGH' || trap?.closeQuality === 'REJECT_LOW') {
    const fadeDown = trap.closeQuality === 'REJECT_HIGH'
    let w = 18
    if (fadeDown && (premium || htfDown)) w += 10
    if (!fadeDown && (discount || htfUp)) w += 10
    if (tape.grind === (fadeDown ? 'DOWN' : 'UP')) w += 8
    const target = fadeDown
      ? longs?.price ?? h1?.dealingLow ?? price - atr1 * 1.6
      : shorts?.price ?? h1?.dealingHigh ?? price + atr1 * 1.6
    raw.push({
      kind: 'FADE_WICK',
      weight: w,
      title: fadeDown ? 'Фитиль сверху — отдают' : 'Фитиль снизу — закрывают шорт',
      why: fadeDown
        ? `Хаи не приняли: длинный верхний фитиль, закрытие внутри. Это не пробой, это снятие. Часто цена идёт обратно к толпе лонгов${longs ? ` ${fmt(longs.price)}` : ''}.`
        : `Лои сняли фитилём и вернули. Покупать сам фитиль рано; если тело удержали — возможен вынос шортов${shorts ? ` к ${fmt(shorts.price)}` : ''}.`,
      invalidation: fadeDown
        ? `Слом: закреп телом над максимумом этого часа.`
        : `Слом: закреп телом под минимумом этого часа.`,
      side: fadeDown ? 'SHORT' : 'LONG',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.4, lerp(origin, target, 0.45), 'откат фитиля'],
        [H * 3.6, target, fadeDown ? 'к лонгам' : 'к шортам'],
      ]),
    })
  }

  // HTF continuation vs 1H noise
  if (h4 && h4.trend !== 'RANGING') {
    const up = h4.trend === 'BULLISH'
    let w = 12
    if (d1 && d1.trend === h4.trend) w += 10
    if (tape.grind === (up ? 'DOWN' : 'UP')) w += 6
    if (tape.displacement === (up ? 'DOWN' : 'UP')) w -= 6
    const target = up
      ? h4.nextBsl ?? shorts?.price ?? price + atr1 * 2.2
      : h4.nextSsl ?? longs?.price ?? price - atr1 * 2.2
    raw.push({
      kind: 'HTF_CONTINUE',
      weight: w + (cas?.regime === 'TREND' ? 10 : cas?.regime === 'PULLBACK' ? 6 : 0),
      title: up ? '4ч бычий — час могут крутить вниз' : '4ч медвежий — час могут крутить вверх',
      why: up
        ? `Матрёшка: неделя/день и 4ч вверх. Слив часа — откат за топливом, не шорт дня. Ход к ${fmt(target)}${fuel ? `, топливо у ${fmt(fuel.price)}` : ''}.`
        : `Матрёшка: неделя/день и 4ч вниз. Отскок часа — корм шортам. Ход к ${fmt(target)}${fuel ? `, топливо у ${fmt(fuel.price)}` : ''}.`,
      invalidation: up
        ? `Слом: 4ч закроется телом ниже ${fmt(h4.lastSwingLow?.price ?? h4.dealingLow)}.`
        : `Слом: 4ч закроется телом выше ${fmt(h4.lastSwingHigh?.price ?? h4.dealingHigh)}.`,
      side: up ? 'LONG' : 'SHORT',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [
          H * 1.4,
          fuel
            ? fuel.price
            : lerp(origin, up ? price - atr1 * 0.5 : price + atr1 * 0.5, 0.8),
          fuel ? fuel.label : 'шум часа',
        ],
        [H * 4.2, target, 'ход 4ч'],
      ]),
    })
  }

  // Compression: both breakouts are live until a body chooses
  if (tape.compression > 0.28 && tape.displacement === 'NONE') {
    const upT = shorts?.price ?? h1?.dealingHigh ?? price + atr1 * 1.5
    const dnT = longs?.price ?? h1?.dealingLow ?? price - atr1 * 1.5
    let wUp = 11 + tape.compression * 10
    let wDn = 11 + tape.compression * 10
    if (htfUp) wUp += 8
    if (htfDown) wDn += 8
    if (book > 0.1) wUp += 5
    if (book < -0.1) wDn += 5
    raw.push({
      kind: 'BREAKOUT',
      weight: wUp,
      title: 'Сжатие → вынос вверх',
      why: `Диапазон сжался. Пока нет тела, направление не выбрано — это не «лонг если закреп». Если снимут шорты${shorts ? ` ${fmt(shorts.price)}` : ''} и закроют выше, сжатие отработает вверх.`,
      invalidation: `Слом: час закрывается телом вниз и держит ниже ${fmt(origin - atr1 * 0.4)}.`,
      side: 'LONG',
      target: upT,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.1, lerp(origin, upT, 0.2), 'ещё сжатие'],
        [H * 3.2, upT, 'вынос'],
      ]),
    })
    raw.push({
      kind: 'BREAKOUT',
      weight: wDn,
      title: 'Сжатие → пролив вниз',
      why: `То же сжатие может разрешиться вниз: поджим, срыв лонгов${longs ? ` к ${fmt(longs.price)}` : ''}. Оба выхода живы, пока нет тела за край.`,
      invalidation: `Слом: час закрывается телом вверх и держит выше ${fmt(origin + atr1 * 0.4)}.`,
      side: 'SHORT',
      target: dnT,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.1, lerp(origin, dnT, 0.2), 'поджим'],
        [H * 3.2, dnT, 'пролив'],
      ]),
    })
  }

  // Snap-back after a run (dead cat / bull trap)
  if (tape.displacement !== 'NONE' && tape.compression < 0.25) {
    const afterDump = tape.displacement === 'DOWN'
    let w = 11
    if (afterDump && htfDown) w += 6
    if (!afterDump && htfUp) w += 6
    if (trap?.closeQuality === 'INDECISION') w += 5
    const mid = h1 ? (h1.dealingHigh + h1.dealingLow) / 2 : origin
    const target = afterDump
      ? lerp(origin, shorts?.price ?? h1?.dealingHigh ?? origin + atr1, 0.55)
      : lerp(origin, longs?.price ?? h1?.dealingLow ?? origin - atr1, 0.55)
    raw.push({
      kind: 'SNAP_BACK',
      weight: w,
      title: afterDump ? 'Отскок после слива — не разворот' : 'Откат после выноса — не смена тренда',
      why: afterDump
        ? `После смещения вниз часто дают мёртвого кота к ${fmt(target)} / середине ${fmt(mid)}. Это закрытие шортов, не лонг, пока нет закрепа над сломом.`
        : `После выноса вверх часто возвращают к ${fmt(target)}. Кормят опоздавших лонгов, если час не удержал хаи телом.`,
      invalidation: afterDump
        ? `Слом отскока как «только шорт»: закреп телом над ${fmt(h1?.lastSwingHigh?.price ?? origin + atr1)}.`
        : `Слом отката как «только лонг»: закреп телом под ${fmt(h1?.lastSwingLow?.price ?? origin - atr1)}.`,
      side: afterDump ? 'LONG' : 'SHORT',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.5, lerp(origin, target, 0.6), 'откат'],
        [H * 3.0, target, afterDump ? 'мёртвый кот' : 'сброс'],
      ]),
    })
  }

  // Fib 141 magnet
  if (input.fib && (input.fib.state === 'APPROACHING' || input.fib.state === 'INSIDE') && input.fib.bias) {
    const mid = (input.fib.zoneTop + input.fib.zoneBottom) / 2
    let w = 13
    if (input.fib.state === 'INSIDE') w += 6
    if (premium && input.fib.bias === 'SHORT') w += 8
    if (discount && input.fib.bias === 'LONG') w += 8
    const then =
      input.fib.bias === 'SHORT'
        ? longs?.price ?? price - atr1 * 1.8
        : shorts?.price ?? price + atr1 * 1.8
    raw.push({
      kind: 'FIB_MAGNET',
      weight: w,
      title:
        input.fib.bias === 'SHORT'
          ? 'Тянет в 141, оттуда часто слив'
          : 'Тянет в 141, оттуда часто вынос',
      why: `Цена ${input.fib.state === 'INSIDE' ? 'уже в' : 'идёт в'} зону 141 (${fmt(input.fib.zoneBottom)}–${fmt(input.fib.zoneTop)}). Это магнит, не сигнал. Реакция — после тела от границы, не внутри зоны.`,
      invalidation: `Слом магнита: закреп телом за 161 (${fmt(input.fib.zoneTop > input.fib.zoneBottom ? input.fib.zoneTop : input.fib.zoneBottom)}).`,
      side: input.fib.bias === 'SHORT' ? 'SHORT' : 'LONG',
      target: then,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.8, mid, 'зона 141'],
        [H * 4.0, then, input.fib.bias === 'SHORT' ? 'реакция вниз' : 'реакция вверх'],
      ]),
    })
  }

  // Distribution / accumulation
  if (premium && tape.lowerHighs && tape.displacement !== 'UP') {
    const target = longs?.price ?? h1?.dealingLow ?? price - atr1 * 2
    raw.push({
      kind: 'DISTRIBUTION',
      weight: 14 + (htfDown ? 8 : 0) + (book < 0 ? 5 : 0),
      title: 'Раздача в премиуме',
      why: `Цена в верхней половине, хаи ниже, смещения вверх нет. Типичная раздача: ещё чуть вверх в шорты, потом слив в лонги${longs ? ` ${fmt(longs.price)}` : ''}.`,
      invalidation: `Слом: закреп телом над последним хаем ${fmt(h1?.lastSwingHigh?.price ?? price + atr1)}.`,
      side: 'SHORT',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.2, lerp(origin, shorts?.price ?? origin + atr1 * 0.5, 0.5), 'ещё в шорты'],
        [H * 3.8, target, 'слив'],
      ]),
    })
  }
  if (discount && tape.higherLows && tape.displacement !== 'DOWN') {
    const target = shorts?.price ?? h1?.dealingHigh ?? price + atr1 * 2
    raw.push({
      kind: 'ACCUMULATION',
      weight: 14 + (htfUp ? 8 : 0) + (book > 0 ? 5 : 0),
      title: 'Набор в дисконте',
      why: `Цена в нижней половине, лои выше, смещения вниз нет. Могут ещё раз сходить в лонги и потом вынести шорты${shorts ? ` ${fmt(shorts.price)}` : ''}.`,
      invalidation: `Слом: закреп телом под последним лоем ${fmt(h1?.lastSwingLow?.price ?? price - atr1)}.`,
      side: 'LONG',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.2, lerp(origin, longs?.price ?? origin - atr1 * 0.5, 0.5), 'ещё в лонги'],
        [H * 3.8, target, 'вынос'],
      ]),
    })
  }

  for (const s of raw) {
    s.weight = tiltWeight(s, tiltCtx)
    s.path = compactPath(s.path)
  }

  const sorted = raw
    .filter((s) => s.weight >= 6 && s.path.length >= 2)
    .sort((a, b) => b.weight - a.weight)

  const picked = pickBoard(sorted)

  if (!picked.length) {
    return {
      now: nowCopy(tape, trap, price, h1, h4, d1, w1, auction, stack, input.cascade ?? null),
      leadId: 'A',
      leadTitle: 'Ждём закрытие 15м / часа',
      scenarios: [],
    }
  }

  const rounded = spreadProbs(picked.map((s) => Math.max(1, s.weight)))
  const scenarios: StructureScenario[] = picked
    .map((s, i) => ({
      id: 'A' as StructureScenario['id'],
      kind: s.kind,
      color: SCENARIO_COLORS[0],
      probability: rounded[i],
      title: s.title,
      why: s.why,
      invalidation: s.invalidation,
      side: s.side,
      path: s.path,
      target: s.target,
    }))
    .sort((a, b) => b.probability - a.probability)
    .map((s, i) => ({
      ...s,
      id: (['A', 'B', 'C', 'D'] as const)[i],
      color: SCENARIO_COLORS[i],
    }))

  const lead = scenarios[0]
  return {
    now: nowCopy(tape, trap, price, h1, h4, d1, w1, auction, stack, input.cascade ?? null),
    leadId: lead?.id ?? 'A',
    leadTitle: lead?.title ?? 'Ждём факт',
    scenarios,
  }
}
