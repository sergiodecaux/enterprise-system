/**
 * Trader story for the chart: one strong take-from zone, arrows for the
 * working SMC path (sweep → displacement → liquidity), and live odds that
 * update as price approaches / holds / loses the zone.
 * Uses existing SR / setup / magnet / TP / BOS — no second prediction engine.
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { LiquidityZone } from '../indicators/types'
import type { PathPoint } from '../prediction/types'
import type { ConditionalSetup } from '../setups'
import { readCloseQuality } from './mmTrapThesis'
import type { StructureRead } from './structureRead'
import type { ZoneReaction, ZoneReactionBoard } from './zoneReaction'
import { reactionForZone } from './zoneReaction'

export type StoryNowKind = 'IN_ZONE' | 'APPROACHING' | 'BOUNCE' | 'OUTSIDE' | 'LOST'

export interface StoryOdds {
  /** Working-scenario % (hold the zone and go to liquidity) */
  pct: number
  failPct: number
  /** 0 far → 1 inside/on the zone. Tape weight rises with this. */
  proximity: number
  fact: string
  lost: boolean
}

export type StoryScenarioId = 'hold' | 'sweep' | 'break' | 'chop'

export interface StoryArrow {
  id: StoryScenarioId
  kind: 'PRIMARY' | 'FAIL' | 'SWEEP' | 'CHOP'
  side: 'LONG' | 'SHORT' | 'RANGE'
  fromPrice: number
  toPrice: number
  toLabel: string
  zoneTop: number
  zoneBottom: number
  zoneStartSec: number
  zoneEndSec: number
  oddsPct: number
  label: string
  sweepPrice: number | null
}

export interface StoryScenario {
  id: StoryScenarioId
  pct: number
  side: 'LONG' | 'SHORT' | 'RANGE'
  /** лонг / шорт / пила */
  dirLabel: string
  /** Explicit if-condition, e.g. «если закрепятся над зоной» */
  condition: string
  title: string
  path: PathPoint[]
  toPrice: number | null
  toLabel: string
}

export interface StoryLegendItem {
  role: 'STRONG' | 'WEAK'
  text: string
  range: string
  take: 'LONG' | 'SHORT' | null
}

export interface ChartStoryFuture {
  path: PathPoint[]
  failPath: PathPoint[] | null
  targetPrice: number
  targetLabel: string
  failTargetPrice: number | null
  failTargetLabel: string | null
  boxLow: number
  boxHigh: number
  bars: number
  side: 'LONG' | 'SHORT'
}

export interface ChartStory {
  primary: LiquidityZone | null
  secondary: LiquidityZone[]
  displayZones: LiquidityZone[]
  nowKind: StoryNowKind
  nowLine: string
  side: 'LONG' | 'SHORT' | null
  future: ChartStoryFuture | null
  odds: StoryOdds | null
  arrows: StoryArrow[]
  scenarios: StoryScenario[]
  legend: StoryLegendItem[]
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function overlapRatio(a: LiquidityZone, b: LiquidityZone): number {
  const hi = Math.min(a.top, b.top)
  const lo = Math.max(a.bottom, b.bottom)
  const ov = hi - lo
  if (ov <= 0) return 0
  const ha = Math.max(a.top - a.bottom, 1e-12)
  const hb = Math.max(b.top - b.bottom, 1e-12)
  return ov / Math.min(ha, hb)
}

function inside(z: LiquidityZone, price: number): boolean {
  return price <= z.top && price >= z.bottom
}

function edgeDist(z: LiquidityZone, price: number): number {
  if (inside(z, price)) return 0
  return Math.min(Math.abs(price - z.top), Math.abs(price - z.bottom))
}

function near(z: LiquidityZone, price: number, atr: number): boolean {
  const pad = Math.max(atr * 0.7, price * 0.004, (z.top - z.bottom) * 0.35)
  return price <= z.top + pad && price >= z.bottom - pad
}

function fmtPx(p: number): string {
  if (!(p > 0) || !Number.isFinite(p)) return '—'
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  if (p >= 0.01) return p.toFixed(5)
  return p.toPrecision(5)
}

export interface ZoneMeaning {
  word: string
  meaning: string
  take: 'LONG' | 'SHORT' | null
}

/** SMC meaning for a chart zone — never a generic «зона». */
export function readZoneMeaning(z: LiquidityZone): ZoneMeaning {
  const id = (z.id ?? '').toLowerCase()
  const side = sideOfZone(z)
  if (id.includes('eqh')) return { word: 'EQH', meaning: 'равные хаи', take: 'SHORT' }
  if (id.includes('eql')) return { word: 'EQL', meaning: 'равные лои', take: 'LONG' }
  if (id.includes('deal_hi')) return { word: 'BSL', meaning: 'ликвидность сверху', take: 'SHORT' }
  if (id.includes('deal_lo')) return { word: 'SSL', meaning: 'ликвидность снизу', take: 'LONG' }
  if (z.type === 'BSL') return { word: 'BSL', meaning: 'ликвидность сверху', take: 'SHORT' }
  if (z.type === 'SSL' || z.type === 'LIQ') {
    return { word: 'SSL', meaning: 'ликвидность снизу', take: 'LONG' }
  }
  if (z.type === 'ORDER_BLOCK') {
    return side === 'SHORT'
      ? { word: 'предложение', meaning: 'предложение', take: 'SHORT' }
      : { word: 'спрос', meaning: 'спрос', take: 'LONG' }
  }
  if (z.type === 'FVG') {
    return side === 'SHORT'
      ? { word: 'FVG', meaning: 'гэп предложения', take: 'SHORT' }
      : { word: 'FVG', meaning: 'гэп спроса', take: 'LONG' }
  }
  if (id.includes('premium') || id.includes('sr_res')) {
    return { word: 'предложение', meaning: 'предложение', take: 'SHORT' }
  }
  if (id.includes('discount') || id.includes('sr_sup')) {
    return { word: 'спрос', meaning: 'спрос', take: 'LONG' }
  }
  if (id.includes('cong') || z.type === 'VALUE_AREA' || z.type === 'POC') {
    return { word: 'проторговка', meaning: 'проторговка', take: side }
  }
  if (side === 'LONG') return { word: 'спрос', meaning: 'спрос', take: 'LONG' }
  if (side === 'SHORT') return { word: 'предложение', meaning: 'предложение', take: 'SHORT' }
  return { word: 'контекст', meaning: 'контекст', take: null }
}

export function humanizeStoryTarget(
  raw: string,
  side: 'LONG' | 'SHORT' | null
): string {
  const src = (raw || '').trim()
  const s = src.toLowerCase()
  if (!s || s === 'цель' || s === 'target') {
    return side === 'SHORT' ? 'стопы снизу' : 'ликвидность сверху'
  }
  if (s.includes('равные хаи') || s.includes('eqh')) return 'равные хаи'
  if (s.includes('равные лои') || s.includes('eql')) return 'равные лои'
  if (s === 'bsl' || s.includes('bsl') || s.includes('ликвидность сверху')) {
    return 'ликвидность сверху'
  }
  if (s === 'ssl' || s.includes('ssl') || s.includes('ликвидность снизу')) {
    return 'стопы снизу'
  }
  if (s.includes('стопы снизу') || s.includes('стопы лонг')) return 'стопы снизу'
  if (s.includes('стопы шорт') || s.includes('шорты')) return 'ликвидность сверху'
  if (s.includes('магнит')) return 'магнит'
  if (src.length <= 22 && /[а-яё]/i.test(src)) return src
  return side === 'SHORT' ? 'стопы снизу' : 'ликвидность сверху'
}

function strongCaption(
  z: LiquidityZone,
  side: 'LONG' | 'SHORT' | null
): { full: string; word: string } {
  const take = side ?? sideOfZone(z)
  if (take === 'LONG') {
    return { full: 'сильная · спрос · лонг отсюда', word: 'сильная · спрос' }
  }
  if (take === 'SHORT') {
    return {
      full: 'сильная · предложение · шорт отсюда',
      word: 'сильная · предложение',
    }
  }
  const m = readZoneMeaning(z)
  return { full: `сильная · ${m.meaning}`, word: `сильная · ${m.word}` }
}

function weakCaption(
  z: LiquidityZone,
  primary: LiquidityZone,
  side: 'LONG' | 'SHORT' | null,
  magnet: { price: number; label: string } | null
): { full: string; word: string } {
  const m = readZoneMeaning(z)
  const isMag =
    magnet != null &&
    magnet.price > 0 &&
    magnet.price <= z.top &&
    magnet.price >= z.bottom
  if (isMag) {
    const magRu = humanizeStoryTarget(magnet.label, side)
    return { full: `слабая · ${magRu}`, word: `слабая · ${magRu}` }
  }
  const mid = (z.top + z.bottom) / 2
  const pMid = (primary.top + primary.bottom) / 2
  const above = mid > pMid
  if (side === 'LONG' && above && (m.word === 'BSL' || m.word === 'EQH' || m.take === 'SHORT')) {
    const meaning = m.meaning === 'равные хаи' ? 'равные хаи' : 'ликвидность сверху'
    return { full: `слабая · ${meaning}`, word: `слабая · ${meaning}` }
  }
  if (side === 'SHORT' && !above && (m.word === 'SSL' || m.word === 'EQL' || m.take === 'LONG')) {
    const meaning = m.meaning === 'равные лои' ? 'равные лои' : 'стопы снизу'
    return { full: `слабая · ${meaning}`, word: `слабая · ${meaning}` }
  }
  return { full: `слабая · ${m.meaning}`, word: `слабая · ${m.meaning}` }
}

function holdArrowCaption(side: 'LONG' | 'SHORT', dest: string): string {
  const d = humanizeStoryTarget(dest, side)
  return side === 'LONG' ? `лонг → ${d}` : `шорт → ${d}`
}

function tagRole(
  z: LiquidityZone,
  role: 'PRIMARY' | 'SECONDARY',
  side: 'LONG' | 'SHORT' | null,
  primary?: LiquidityZone | null,
  magnet?: { price: number; label: string } | null
): LiquidityZone {
  if (role === 'PRIMARY') {
    const cap = strongCaption(z, side)
    const take = side ?? sideOfZone(z)
    return {
      ...z,
      side:
        take === 'LONG' ? 'BULLISH' : take === 'SHORT' ? 'BEARISH' : z.side,
      storyRole: 'PRIMARY',
      strengthTier: 'STRONG',
      strength: Math.max(z.strength ?? 8, 11),
      contextHint: cap.full,
      label: cap.word,
    }
  }
  const cap = weakCaption(z, primary ?? z, side, magnet ?? null)
  return {
    ...z,
    storyRole: 'SECONDARY',
    strengthTier: 'WEAK',
    strength: Math.min(z.strength ?? 6, 7),
    contextHint: cap.full,
    label: cap.word,
  }
}

function sideOfZone(z: LiquidityZone | null): 'LONG' | 'SHORT' | null {
  if (!z) return null
  if (z.side === 'BULLISH') return 'LONG'
  if (z.side === 'BEARISH') return 'SHORT'
  return null
}

function goingToSide(going: ZoneReaction['going'] | undefined): 'LONG' | 'SHORT' | null {
  if (going === 'UP') return 'LONG'
  if (going === 'DOWN') return 'SHORT'
  return null
}

function timeSec(t: LiquidityZone['startTime'] | undefined): number {
  if (typeof t === 'number' && t > 0) return t
  return 0
}

function lostThrough(
  primary: LiquidityZone,
  side: 'LONG' | 'SHORT' | null,
  price: number,
  atr: number,
  rx: ZoneReaction | null
): boolean {
  if (rx?.state === 'BROKEN') return true
  if (!side) return false
  const pad = Math.max(atr * 0.12, (primary.top - primary.bottom) * 0.08, price * 0.0003)
  if (side === 'LONG' && price < primary.bottom - pad) return true
  if (side === 'SHORT' && price > primary.top + pad) return true
  return false
}

function nowKindOf(
  primary: LiquidityZone | null,
  rx: ZoneReaction | null,
  price: number,
  atr: number,
  side: 'LONG' | 'SHORT' | null
): StoryNowKind {
  if (!primary || !(price > 0)) return 'OUTSIDE'
  if (lostThrough(primary, side, price, atr, rx)) return 'LOST'
  const st = rx?.state
  if (
    st === 'HOLDING_ABOVE' ||
    st === 'HOLDING_BELOW' ||
    st === 'RECLAIMED' ||
    st === 'CONSOLIDATING_OVER' ||
    st === 'CONSOLIDATING_UNDER'
  ) {
    return 'BOUNCE'
  }
  if (st === 'INSIDE' || inside(primary, price)) return 'IN_ZONE'
  if (st === 'APPROACHING' || near(primary, price, atr)) return 'APPROACHING'
  return 'OUTSIDE'
}

function nowLineOf(
  kind: StoryNowKind,
  side: 'LONG' | 'SHORT' | null,
  oddsPct: number | null
): string {
  const k =
    kind === 'IN_ZONE'
      ? 'в зоне'
      : kind === 'APPROACHING'
        ? 'подход к зоне'
        : kind === 'BOUNCE'
          ? 'отскок'
          : kind === 'LOST'
            ? 'зона потеряна'
            : 'вне зоны'
  const dir = side === 'LONG' ? 'лонг' : side === 'SHORT' ? 'шорт' : ''
  const pct =
    oddsPct != null && Number.isFinite(oddsPct) ? ` ${Math.round(oddsPct)}%` : ''
  if (dir) return `${k} · ${dir}${pct}`
  return k
}

function widenBand(z: LiquidityZone, price: number, atr: number): LiquidityZone {
  const n =
    z.top < z.bottom ? { ...z, top: z.bottom, bottom: z.top } : { ...z }
  const minH = Math.max(atr * 0.5, (price > 0 ? price : n.top) * 0.0028)
  const h = n.top - n.bottom
  if (h >= minH) return n
  const mid = h > 0 ? (n.top + n.bottom) / 2 : price || n.top
  return { ...n, top: mid + minH / 2, bottom: mid - minH / 2 }
}

function makeSynthBand(
  price: number,
  atr: number,
  side: 'LONG' | 'SHORT' | null,
  candles: OhlcvCandle[],
  barSeconds: number
): LiquidityZone {
  const h = Math.max(atr * 0.75, price * 0.0038)
  const last = candles.length
    ? Math.floor(candles[candles.length - 1][0] / 1000)
    : Math.floor(Date.now() / 1000)
  const look = Math.min(48, Math.max(16, candles.length))
  const start = candles.length
    ? Math.floor(candles[Math.max(0, candles.length - look)][0] / 1000)
    : last - barSeconds * look
  return {
    id: 'story_synth',
    type: 'VALUE_AREA',
    side: side === 'SHORT' ? 'BEARISH' : 'BULLISH',
    top: price + h / 2,
    bottom: price - h / 2,
    startTime: start as LiquidityZone['startTime'],
    endTime: last as LiquidityZone['endTime'],
    strength: 12,
    strengthTier: 'STRONG',
  }
}

function pickPrimary(
  zones: LiquidityZone[],
  opts: {
    focusId: string | null
    launchId: string | null
    board: ZoneReactionBoard | null
    price: number
  }
): LiquidityZone | null {
  const { focusId, launchId, board, price } = opts
  if (focusId) {
    const hit = zones.find((z) => z.id === focusId)
    if (hit) return hit
  }
  if (board?.active) {
    const id = board.active.zone.id
    const hit = zones.find((z) => z.id === id)
    if (hit) return hit
    const z = board.active.zone
    return (
      zones.find(
        (c) =>
          Math.min(c.top, z.top) - Math.max(c.bottom, z.bottom) >
          Math.min(c.top - c.bottom, z.top - z.bottom) * 0.45
      ) ?? null
    )
  }
  if (launchId) {
    const hit = zones.find((z) => z.id === launchId)
    if (hit) return hit
  }
  if (!zones.length || !(price > 0)) return null
  const scored = [...zones].sort((a, b) => {
    const da = edgeDist(a, price)
    const db = edgeDist(b, price)
    const ta = a.strengthTier === 'STRONG' ? 0 : a.strengthTier === 'MEDIUM' ? 1 : 2
    const tb = b.strengthTier === 'STRONG' ? 0 : b.strengthTier === 'MEDIUM' ? 1 : 2
    if (ta !== tb) return ta - tb
    return da - db || (b.strength ?? 0) - (a.strength ?? 0)
  })
  return scored[0] ?? null
}

function pickContextZones(
  zones: LiquidityZone[],
  primary: LiquidityZone,
  side: 'LONG' | 'SHORT' | null,
  max: number,
  magnet: { price: number; label: string } | null
): LiquidityZone[] {
  const pMid = (primary.top + primary.bottom) / 2
  const cands = zones.filter((z) => {
    if (z.id === primary.id) return false
    if (overlapRatio(z, primary) > 0.4) return false
    return true
  })
  const score = (z: LiquidityZone): number => {
    const m = readZoneMeaning(z)
    const mid = (z.top + z.bottom) / 2
    let s = z.strength ?? 5
    if (m.word === 'EQH' || m.word === 'EQL') s += 8
    if (m.word === 'BSL' || m.word === 'SSL') s += 6
    if (magnet && magnet.price > 0 && magnet.price <= z.top && magnet.price >= z.bottom) {
      s += 7
    }
    if (side === 'LONG' && mid > pMid) s += 4
    if (side === 'SHORT' && mid < pMid) s += 4
    s -= Math.min(8, edgeDist(z, pMid) / Math.max(pMid * 0.002, 1e-8))
    return s
  }
  cands.sort((a, b) => score(b) - score(a) || (b.strength ?? 0) - (a.strength ?? 0))
  const out: LiquidityZone[] = []
  for (const z of cands) {
    if (out.length >= max) break
    if (out.some((x) => overlapRatio(x, z) > 0.45)) continue
    out.push(tagRole(z, 'SECONDARY', side, primary, magnet))
  }
  return out
}

function targetFrom(opts: {
  setup: ConditionalSetup | null
  rx: ZoneReaction | null
  structure: StructureRead | null
  primary: LiquidityZone | null
  side: 'LONG' | 'SHORT' | null
  price: number
}): { price: number; label: string } | null {
  const { setup, rx, structure, primary, side, price } = opts
  if (setup && setup.target > 0) {
    const aligned =
      !side ||
      (side === 'LONG' && setup.target >= price) ||
      (side === 'SHORT' && setup.target <= price)
    if (aligned) return { price: setup.target, label: setup.magnet?.label ?? 'цель' }
  }
  if (rx?.destination && rx.destination.price > 0) {
    const aligned =
      !side ||
      (side === 'LONG' && rx.destination.price >= price) ||
      (side === 'SHORT' && rx.destination.price <= price)
    if (aligned) return rx.destination
  }
  if (rx?.targetIfHold && rx.targetIfHold.price > 0) {
    const aligned =
      !side ||
      (side === 'LONG' && rx.targetIfHold.price >= price) ||
      (side === 'SHORT' && rx.targetIfHold.price <= price)
    if (aligned) return rx.targetIfHold
  }
  const mag = structure?.magnet
  if (mag && mag.price > 0) {
    const aligned =
      !side ||
      (side === 'LONG' && mag.price >= price) ||
      (side === 'SHORT' && mag.price <= price)
    if (aligned) return mag
  }
  if (side === 'LONG') {
    const bsl =
      structure?.h1?.nextBsl ?? structure?.h4?.nextBsl ?? structure?.h4?.dealingHigh ?? null
    if (bsl != null && bsl > price) return { price: bsl, label: 'BSL' }
  }
  if (side === 'SHORT') {
    const ssl =
      structure?.h1?.nextSsl ?? structure?.h4?.nextSsl ?? structure?.h4?.dealingLow ?? null
    if (ssl != null && ssl < price) return { price: ssl, label: 'SSL' }
  }
  if (primary?.target && primary.target > 0) {
    return { price: primary.target, label: 'цель' }
  }
  const lead = structure?.scenarios?.scenarios[0]
  if (lead) {
    const last = [...lead.path].reverse().find((p) => p.price > 0)
    if (last) return { price: last.price, label: last.label || lead.title }
  }
  return null
}

function failTargetFrom(opts: {
  rx: ZoneReaction | null
  structure: StructureRead | null
  primary: LiquidityZone
  opposite: LiquidityZone | null
  side: 'LONG' | 'SHORT'
  price: number
}): { price: number; label: string } | null {
  const { rx, structure, primary, opposite, side, price } = opts
  if (side === 'LONG') {
    const dump = rx?.nextIfBreakDown
    if (dump) return { price: dump.top, label: dump.label }
    const ssl =
      structure?.h1?.nextSsl ?? structure?.h4?.nextSsl ?? structure?.h4?.dealingLow ?? null
    if (ssl != null && ssl < Math.min(price, primary.bottom)) {
      return { price: ssl, label: 'SSL' }
    }
  } else {
    const dump = rx?.nextIfBreakUp
    if (dump) return { price: dump.bottom, label: dump.label }
    const bsl =
      structure?.h1?.nextBsl ?? structure?.h4?.nextBsl ?? structure?.h4?.dealingHigh ?? null
    if (bsl != null && bsl > Math.max(price, primary.top)) {
      return { price: bsl, label: 'BSL' }
    }
  }
  if (opposite) {
    const mid = (opposite.top + opposite.bottom) / 2
    const aligned =
      (side === 'LONG' && mid < primary.bottom) || (side === 'SHORT' && mid > primary.top)
    if (aligned) return { price: mid, label: opposite.label || 'противоположная зона' }
  }
  if (primary.invalidation && primary.invalidation > 0) {
    const inv = primary.invalidation
    const aligned =
      (side === 'LONG' && inv < primary.bottom) || (side === 'SHORT' && inv > primary.top)
    if (aligned) return { price: inv, label: 'слом' }
  }
  return null
}

function sweepPriceOf(
  primary: LiquidityZone,
  side: 'LONG' | 'SHORT',
  structure: StructureRead | null
): number | null {
  const trap = structure?.trap?.swept
  if (trap && trap.price > 0) {
    if (side === 'LONG' && trap.kind === 'SSL') return trap.price
    if (side === 'SHORT' && trap.kind === 'BSL') return trap.price
  }
  const ev = structure?.h1?.lastSweep ?? structure?.h4?.lastSweep
  if (ev && ev.price > 0) {
    if (side === 'LONG' && ev.side === 'DOWN') return ev.price
    if (side === 'SHORT' && ev.side === 'UP') return ev.price
  }
  return side === 'LONG' ? primary.bottom : primary.top
}

/** Straight / 2-segment path — TradingView path-to-target, not a doodle. */
function twoSeg(
  a: { t: number; price: number; label: string },
  b: { t: number; price: number; label: string; key?: boolean },
  c?: { t: number; price: number; label: string; key?: boolean }
): PathPoint[] {
  const pts: PathPoint[] = [
    { timeOffsetSeconds: a.t, price: a.price, label: a.label },
    {
      timeOffsetSeconds: b.t,
      price: b.price,
      label: b.label,
      isKeyLevel: b.key,
    },
  ]
  if (c) {
    pts.push({
      timeOffsetSeconds: c.t,
      price: c.price,
      label: c.label,
      isKeyLevel: c.key,
    })
  }
  return pts
}

function holdPathOf(opts: {
  price: number
  primary: LiquidityZone
  target: { price: number; label: string }
  side: 'LONG' | 'SHORT'
  barSeconds: number
}): PathPoint[] {
  const { price, primary, target, side, barSeconds } = opts
  const bar = Math.max(1, barSeconds)
  const mid = (primary.top + primary.bottom) / 2
  const leave = side === 'LONG' ? primary.top : primary.bottom
  const from = Number.isFinite(price) && price > 0 ? (mid + price) / 2 : mid
  return twoSeg(
    { t: Math.round(-bar * 0.4), price: from, label: 'зона' },
    { t: Math.round(bar * 2.2), price: leave, label: 'выход' },
    { t: Math.round(bar * 8), price: target.price, label: target.label, key: true }
  )
}

function sweepPathOf(opts: {
  price: number
  primary: LiquidityZone
  target: { price: number; label: string }
  side: 'LONG' | 'SHORT'
  barSeconds: number
  sweepPrice: number | null
}): PathPoint[] {
  const { price, primary, target, side, barSeconds, sweepPrice } = opts
  const bar = Math.max(1, barSeconds)
  const sweep =
    sweepPrice && sweepPrice > 0
      ? sweepPrice
      : side === 'LONG'
        ? primary.bottom
        : primary.top
  const now = price > 0 ? price : (primary.top + primary.bottom) / 2
  return twoSeg(
    { t: 0, price: now, label: 'сейчас' },
    { t: Math.round(bar * 2.4), price: sweep, label: 'свип', key: true },
    { t: Math.round(bar * 8), price: target.price, label: target.label, key: true }
  )
}

function breakPathOf(opts: {
  price: number
  primary: LiquidityZone
  target: { price: number; label: string }
  side: 'LONG' | 'SHORT'
  barSeconds: number
}): PathPoint[] {
  const { price, primary, target, side, barSeconds } = opts
  const bar = Math.max(1, barSeconds)
  const through = side === 'LONG' ? primary.bottom : primary.top
  const now = price > 0 ? price : (primary.top + primary.bottom) / 2
  return twoSeg(
    { t: 0, price: now, label: 'сейчас' },
    { t: Math.round(bar * 2), price: through, label: 'слом', key: true },
    { t: Math.round(bar * 8), price: target.price, label: target.label, key: true }
  )
}

function chopPathOf(opts: {
  price: number
  primary: LiquidityZone
  barSeconds: number
}): PathPoint[] {
  const { price, primary, barSeconds } = opts
  const bar = Math.max(1, barSeconds)
  const mid = (primary.top + primary.bottom) / 2
  const now = price > 0 ? price : mid
  const far = Math.abs(now - primary.top) >= Math.abs(now - primary.bottom)
    ? primary.bottom
    : primary.top
  return twoSeg(
    { t: 0, price: now, label: 'сейчас' },
    { t: Math.round(bar * 3.2), price: far, label: 'край' },
    { t: Math.round(bar * 7), price: mid, label: 'середина' }
  )
}

interface LastTape {
  overlapping: boolean
  displacement: 'UP' | 'DOWN' | 'NONE'
  upCloses: number
  downCloses: number
  heldCloses: number
  rejected: boolean
}

function readLastTape(
  candles: OhlcvCandle[],
  primary: LiquidityZone,
  side: 'LONG' | 'SHORT',
  atr: number
): LastTape {
  const empty: LastTape = {
    overlapping: false,
    displacement: 'NONE',
    upCloses: 0,
    downCloses: 0,
    heldCloses: 0,
    rejected: false,
  }
  if (candles.length < 3) return empty
  const last = candles.slice(-6)
  const pad = Math.max(atr * 0.1, (primary.top - primary.bottom) * 0.08)
  let overlap = 0
  let upCloses = 0
  let downCloses = 0
  let heldCloses = 0
  for (let i = 0; i < last.length; i++) {
    const [, o, h, l, c] = last[i]
    if (c > o) upCloses++
    else if (c < o) downCloses++
    if (side === 'LONG' && c >= primary.bottom - pad * 0.2) heldCloses++
    if (side === 'SHORT' && c <= primary.top + pad * 0.2) heldCloses++
    if (i > 0) {
      const prev = last[i - 1]
      const ov = Math.min(h, prev[2]) - Math.max(l, prev[3])
      if (ov > 0) overlap++
    }
  }
  const cur = last[last.length - 1]
  const range = cur[2] - cur[3]
  const body = Math.abs(cur[4] - cur[1])
  const displacement: LastTape['displacement'] =
    range > 0 && body / range >= 0.62
      ? cur[4] > cur[1]
        ? 'UP'
        : 'DOWN'
      : 'NONE'
  const q = readCloseQuality(cur)
  const rejected =
    (side === 'LONG' && (q === 'REJECT_LOW' || (cur[3] <= primary.bottom && cur[4] >= primary.bottom))) ||
    (side === 'SHORT' && (q === 'REJECT_HIGH' || (cur[2] >= primary.top && cur[4] <= primary.top)))
  const steps = last.length - 1
  return {
    overlapping: steps > 0 && overlap / steps >= 0.58,
    displacement,
    upCloses,
    downCloses,
    heldCloses,
    rejected,
  }
}

function bosAligned(
  structure: StructureRead | null,
  side: 'LONG' | 'SHORT'
): { aligned: boolean; against: boolean; held: boolean; kind: string } {
  const ev =
    structure?.h1?.lastBos ??
    structure?.h1?.lastChoch ??
    structure?.h4?.lastBos ??
    structure?.h4?.lastChoch ??
    null
  if (!ev) return { aligned: false, against: false, held: false, kind: '' }
  const want = side === 'LONG' ? 'UP' : 'DOWN'
  const aligned = ev.side === want
  const kind = ev.kind === 'CHOCH' ? 'MSS' : ev.kind === 'BOS' ? 'BOS' : ev.kind
  return { aligned, against: ev.side !== want, held: ev.held, kind }
}

function scoreLiveOdds(opts: {
  primary: LiquidityZone
  rx: ZoneReaction | null
  structure: StructureRead | null
  candles: OhlcvCandle[]
  price: number
  atr: number
  side: 'LONG' | 'SHORT'
  kind: StoryNowKind
}): StoryOdds {
  const { primary, rx, structure, candles, price, atr, side, kind } = opts
  const dist = edgeDist(primary, price)
  const scale = Math.max(atr * 2.4, (primary.top - primary.bottom) * 1.8, price * 0.008)
  const proximity = clamp(1 - dist / scale, 0, 1)

  let p =
    kind === 'BOUNCE'
      ? rx?.continueProbability ?? rx?.holdProbability ?? 52
      : rx?.holdProbability ?? rx?.continueProbability ?? 48

  const tape = readLastTape(candles, primary, side, atr)
  const q = readCloseQuality(candles[candles.length - 1])
  const pad = Math.max(atr * 0.12, (primary.top - primary.bottom) * 0.08, price * 0.0003)
  const live = price > 0 ? price : candles[candles.length - 1]?.[4] ?? 0
  const inBand = live <= primary.top && live >= primary.bottom
  const lost =
    kind === 'LOST' ||
    (side === 'LONG' && live < primary.bottom - pad) ||
    (side === 'SHORT' && live > primary.top + pad)
  const accepted =
    (side === 'LONG' &&
      (rx?.state === 'HOLDING_ABOVE' ||
        rx?.state === 'CONSOLIDATING_OVER' ||
        rx?.state === 'RECLAIMED')) ||
    (side === 'SHORT' &&
      (rx?.state === 'HOLDING_BELOW' ||
        rx?.state === 'CONSOLIDATING_UNDER' ||
        rx?.state === 'RECLAIMED'))

  let tapeAdj = 0
  if (inBand) tapeAdj += 5
  if (kind === 'APPROACHING') tapeAdj += 2
  if (accepted) tapeAdj += 11
  if (tape.rejected && !lost) tapeAdj += 9
  if (tape.heldCloses >= 3 && !lost) tapeAdj += 6
  if (tape.overlapping) tapeAdj -= 7
  if (side === 'LONG') {
    if (tape.displacement === 'UP' || q === 'DISPLACEMENT_UP') tapeAdj += 10
    if (tape.displacement === 'DOWN' || q === 'DISPLACEMENT_DOWN') tapeAdj -= 12
    if (q === 'REJECT_LOW') tapeAdj += 7
    if (q === 'REJECT_HIGH') tapeAdj -= 5
    if (tape.upCloses > tape.downCloses + 1) tapeAdj += 3
    if (tape.downCloses > tape.upCloses + 1) tapeAdj -= 3
  } else {
    if (tape.displacement === 'DOWN' || q === 'DISPLACEMENT_DOWN') tapeAdj += 10
    if (tape.displacement === 'UP' || q === 'DISPLACEMENT_UP') tapeAdj -= 12
    if (q === 'REJECT_HIGH') tapeAdj += 7
    if (q === 'REJECT_LOW') tapeAdj -= 5
    if (tape.downCloses > tape.upCloses + 1) tapeAdj += 3
    if (tape.upCloses > tape.downCloses + 1) tapeAdj -= 3
  }
  if (lost) tapeAdj -= 20
  if (rx?.state === 'BREAKING') tapeAdj -= 10

  const bos = bosAligned(structure, side)
  if (bos.aligned && bos.held) tapeAdj += 8
  else if (bos.aligned) tapeAdj += 4
  else if (bos.against && bos.held) tapeAdj -= 8
  else if (bos.against) tapeAdj -= 4

  if (structure?.structureHeld && structure.preferredSide === side) tapeAdj += 5
  else if (structure?.preferredSide && structure.preferredSide !== side) tapeAdj -= 5

  const sweep = structure?.h1?.lastSweep ?? structure?.h4?.lastSweep
  if (sweep) {
    if (side === 'LONG' && sweep.side === 'DOWN' && sweep.held) tapeAdj += 6
    if (side === 'SHORT' && sweep.side === 'UP' && sweep.held) tapeAdj += 6
  }
  if (structure?.trap?.phase === 'TRADE_READY' && structure.trap.tradeSide === side) {
    tapeAdj += 6
  }

  /* Closer to the zone → last candles dominate the printed %. */
  const w = 0.18 + proximity * 0.82
  p = p + tapeAdj * w

  if (lost) p = Math.min(p, 38)

  const pct = Math.round(clamp(p, 18, 86))
  const failPct = 100 - pct

  let fact = 'ждём реакцию'
  if (lost) fact = 'закрылись сквозь зону'
  else if (accepted && tape.displacement !== 'NONE') fact = 'закреп + импульс'
  else if (accepted) fact = 'закреп / принятие'
  else if (tape.rejected) fact = 'отбой фитилём'
  else if (tape.overlapping) fact = 'пила / перекрытие'
  else if (bos.aligned && bos.held) fact = `${bos.kind} держит`
  else if (bos.against && bos.held) fact = `${bos.kind} против`
  else if (inBand) fact = 'внутри зоны'
  else if (kind === 'APPROACHING') fact = 'подход, смотрим закрытие'
  else if (tape.displacement === 'UP') fact = 'тело вверх'
  else if (tape.displacement === 'DOWN') fact = 'тело вниз'

  return { pct, failPct, proximity, fact, lost }
}

function roundFour(hold: number, sweep: number, brk: number, chop: number): {
  hold: number
  sweep: number
  brk: number
  chop: number
} {
  const raw = [hold, sweep, brk, chop].map((n) => Math.max(4, n))
  const sum = raw.reduce((a, b) => a + b, 0) || 1
  const rounded = raw.map((n) => Math.round((n / sum) * 100))
  let drift = 100 - rounded.reduce((a, b) => a + b, 0)
  let idx = 0
  for (let i = 1; i < 4; i++) if (rounded[i] > rounded[idx]) idx = i
  rounded[idx] += drift
  return { hold: rounded[0], sweep: rounded[1], brk: rounded[2], chop: rounded[3] }
}

function scoreFourScenarios(opts: {
  odds: StoryOdds
  kind: StoryNowKind
  tape: LastTape
  bos: { aligned: boolean; against: boolean; held: boolean; kind: string }
  trapPhase: string | null
  side: 'LONG' | 'SHORT'
}): { hold: number; sweep: number; brk: number; chop: number } {
  const { odds, kind, tape, bos, trapPhase, side } = opts
  let hold = odds.pct * 0.72
  let brk = odds.failPct * 0.72
  let sweep = 14
  let chop = 12

  const near = odds.proximity
  hold += near * 5
  if (kind === 'APPROACHING') {
    sweep += 10
    chop += 2
  } else if (kind === 'IN_ZONE') {
    chop += 10
    sweep += 6
    hold += 2
  } else if (kind === 'BOUNCE') {
    hold += 12
    sweep -= 4
    chop -= 4
  } else if (kind === 'OUTSIDE') {
    sweep += 4
    chop -= 2
  }

  if (tape.overlapping) {
    chop += 12
    hold -= 6
  }
  if (tape.rejected && !odds.lost) {
    sweep += 8
    hold += 4
    brk -= 4
  }
  if (tape.heldCloses >= 3 && !odds.lost) {
    hold += 6
    brk -= 4
  }

  const withSide =
    (side === 'LONG' && tape.displacement === 'UP') ||
    (side === 'SHORT' && tape.displacement === 'DOWN')
  const againstSide =
    (side === 'LONG' && tape.displacement === 'DOWN') ||
    (side === 'SHORT' && tape.displacement === 'UP')
  if (withSide) {
    hold += 10
    chop -= 6
  }
  if (againstSide) {
    brk += 10
    hold -= 8
  }

  if (bos.aligned && bos.held) hold += 8
  else if (bos.aligned) hold += 4
  else if (bos.against && bos.held) brk += 8
  else if (bos.against) brk += 4

  if (trapPhase === 'TRADE_READY') {
    sweep += 6
    hold += 5
  } else if (trapPhase === 'HUNTING' || trapPhase === 'SWEPT') {
    sweep += 10
  } else if (trapPhase === 'TRAP') {
    sweep += 8
    brk += 4
  }

  if (odds.lost) {
    brk += 22
    hold = Math.min(hold, 14)
    chop = Math.min(chop, 12)
    sweep += 2
  }

  return roundFour(hold, sweep, brk, chop)
}

function legendOf(
  primary: LiquidityZone | null,
  secondary: LiquidityZone[]
): StoryLegendItem[] {
  const items: StoryLegendItem[] = []
  if (primary) {
    items.push({
      role: 'STRONG',
      text: primary.contextHint || strongCaption(primary, sideOfZone(primary)).full,
      range: `${fmtPx(Math.min(primary.bottom, primary.top))}–${fmtPx(
        Math.max(primary.bottom, primary.top)
      )}`,
      take: sideOfZone(primary),
    })
  }
  for (const z of secondary) {
    items.push({
      role: 'WEAK',
      text: z.contextHint || z.label || readZoneMeaning(z).meaning,
      range: `${fmtPx(Math.min(z.bottom, z.top))}–${fmtPx(Math.max(z.bottom, z.top))}`,
      take: sideOfZone(z),
    })
  }
  return items
}

function dirWord(side: 'LONG' | 'SHORT' | 'RANGE'): string {
  if (side === 'LONG') return 'лонг'
  if (side === 'SHORT') return 'шорт'
  return 'пила'
}

export function padStoryScenarios(
  rows: StoryScenario[],
  side: 'LONG' | 'SHORT' | null,
  price: number,
  barSeconds: number
): StoryScenario[] {
  const s: 'LONG' | 'SHORT' = side === 'SHORT' ? 'SHORT' : 'LONG'
  const fail: 'LONG' | 'SHORT' = s === 'LONG' ? 'SHORT' : 'LONG'
  const bar = Math.max(1, barSeconds)
  const now = price > 0 ? price : 1
  const holdTo = s === 'LONG' ? now * 1.006 : now * 0.994
  const breakTo = s === 'LONG' ? now * 0.994 : now * 1.006
  const holdDest = s === 'LONG' ? 'ликвидность сверху' : 'стопы снизу'
  const breakDest = s === 'LONG' ? 'стопы снизу' : 'ликвидность сверху'
  const stubs: StoryScenario[] = [
    {
      id: 'hold',
      pct: 40,
      side: s,
      dirLabel: dirWord(s),
      condition: holdCondition(s),
      title: holdArrowCaption(s, holdDest),
      path: twoSeg(
        { t: 0, price: now, label: 'сейчас' },
        { t: Math.round(bar * 8), price: holdTo, label: holdDest, key: true }
      ),
      toPrice: holdTo,
      toLabel: holdDest,
    },
    {
      id: 'sweep',
      pct: 22,
      side: s,
      dirLabel: dirWord(s),
      condition: sweepCondition(s),
      title: 'свип → разворот',
      path: twoSeg(
        { t: 0, price: now, label: 'сейчас' },
        { t: Math.round(bar * 2.4), price: s === 'LONG' ? now * 0.997 : now * 1.003, label: 'свип', key: true },
        { t: Math.round(bar * 8), price: holdTo, label: holdDest, key: true }
      ),
      toPrice: holdTo,
      toLabel: holdDest,
    },
    {
      id: 'break',
      pct: 22,
      side: fail,
      dirLabel: dirWord(fail),
      condition: breakCondition(s),
      title: `слом → ${breakDest}`,
      path: twoSeg(
        { t: 0, price: now, label: 'сейчас' },
        { t: Math.round(bar * 8), price: breakTo, label: breakDest, key: true }
      ),
      toPrice: breakTo,
      toLabel: breakDest,
    },
    {
      id: 'chop',
      pct: 16,
      side: 'RANGE',
      dirLabel: dirWord('RANGE'),
      condition: 'если останемся внутри',
      title: 'пила внутри зоны',
      path: twoSeg(
        { t: 0, price: now, label: 'сейчас' },
        { t: Math.round(bar * 7), price: now, label: 'середина' }
      ),
      toPrice: now,
      toLabel: 'середина зоны',
    },
  ]
  const byId = new Map(rows.map((r) => [r.id, r]))
  return stubs.map((stub) => byId.get(stub.id) ?? stub)
}

function holdCondition(side: 'LONG' | 'SHORT'): string {
  return side === 'LONG' ? 'если закрепятся над зоной' : 'если закрепятся под зоной'
}

function sweepCondition(side: 'LONG' | 'SHORT'): string {
  return side === 'LONG'
    ? 'если снимут лои и закроются обратно'
    : 'если снимут хаи и закроются обратно'
}

function breakCondition(side: 'LONG' | 'SHORT'): string {
  return side === 'LONG' ? 'если закроют ниже зоны' : 'если закроют выше зоны'
}

export function buildChartStory(opts: {
  zones: LiquidityZone[]
  price: number
  atr?: number
  board?: ZoneReactionBoard | null
  structure?: StructureRead | null
  setup?: ConditionalSetup | null
  focusId?: string | null
  launchId?: string | null
  barSeconds?: number
  onlyStrong?: boolean
  candles?: OhlcvCandle[]
}): ChartStory {
  const price = opts.price
  const atr = opts.atr && opts.atr > 0 ? opts.atr : Math.max(price * 0.004, 1e-8)
  const board = opts.board ?? opts.structure?.zones ?? null
  const onlyStrong = opts.onlyStrong !== false
  const candles = opts.candles ?? []
  const barSeconds = opts.barSeconds ?? 3600

  const fibish = (z: LiquidityZone) =>
    z.type === 'FIBONACCI' || (z.id ?? '').startsWith('fib141_')
  const pool = opts.zones
    .filter((z) => !fibish(z) && z.top > 0 && z.bottom > 0)
    .map((z) => widenBand(z, price, atr))

  const fromSetup = opts.setup?.side ?? null
  const fromStruct = opts.structure?.preferredSide ?? null
  let livePrice = price
  if (!(livePrice > 0) && candles.length) {
    livePrice = candles[candles.length - 1]?.[4] ?? 0
  }

  let rawPrimary = pickPrimary(pool, {
    focusId: opts.focusId ?? null,
    launchId: opts.launchId ?? null,
    board,
    price: livePrice,
  })
  if (!rawPrimary && livePrice > 0) {
    rawPrimary = makeSynthBand(
      livePrice,
      atr,
      fromSetup ?? fromStruct,
      candles,
      barSeconds
    )
  }
  if (rawPrimary && livePrice > 0) {
    rawPrimary = widenBand(rawPrimary, livePrice, atr)
  }
  const rx = rawPrimary ? reactionForZone(board, rawPrimary) : board?.active ?? null

  const fromGoing = goingToSide(rx?.going)
  const holdSide =
    fromSetup ?? fromGoing ?? fromStruct ?? sideOfZone(rawPrimary) ?? (livePrice > 0 ? 'LONG' : null)
  const primary = rawPrimary ? tagRole(rawPrimary, 'PRIMARY', holdSide) : null
  const nowKind = nowKindOf(primary, rx, livePrice || price, atr, holdSide)

  const magnet = opts.structure?.magnet ?? null
  const secondary = primary
    ? pickContextZones(pool, primary, holdSide, onlyStrong ? 2 : 3, magnet)
    : []
  const opposite = secondary[0] ?? null

  const displayZones = primary ? [primary, ...secondary] : []

  const scoredOdds =
    primary && holdSide
      ? scoreLiveOdds({
          primary,
          rx,
          structure: opts.structure ?? null,
          candles,
          price: livePrice,
          atr,
          side: holdSide,
          kind: nowKind,
        })
      : null

  const nowLine = nowLineOf(nowKind, holdSide, scoredOdds?.pct ?? null)

  const holdTgt =
    primary && holdSide
      ? targetFrom({
          setup: opts.setup ?? null,
          rx,
          structure: opts.structure ?? null,
          primary,
          side: holdSide,
          price: livePrice,
        })
      : null

  const failTgt =
    primary && holdSide
      ? failTargetFrom({
          rx,
          structure: opts.structure ?? null,
          primary,
          opposite,
          side: holdSide,
          price: livePrice,
        })
      : null

  const holdTgtRu = holdTgt
    ? {
        ...holdTgt,
        label: humanizeStoryTarget(holdTgt.label || 'цель', holdSide),
      }
    : null
  const failSide: 'LONG' | 'SHORT' | null =
    holdSide === 'LONG' ? 'SHORT' : holdSide === 'SHORT' ? 'LONG' : null
  const failTgtRu = failTgt
    ? {
        ...failTgt,
        label: humanizeStoryTarget(failTgt.label || 'следующая ликвидность', failSide),
      }
    : null

  const arrows: StoryArrow[] = []
  const scenarios: StoryScenario[] = []
  let future: ChartStoryFuture | null = null

  if (primary && holdSide && livePrice > 0) {
    const sweep = sweepPriceOf(primary, holdSide, opts.structure ?? null)
    const tape = readLastTape(candles, primary, holdSide, atr)
    const bos = bosAligned(opts.structure ?? null, holdSide)
    const four = scoredOdds
      ? scoreFourScenarios({
          odds: scoredOdds,
          kind: nowKind,
          tape,
          bos,
          trapPhase: opts.structure?.trap?.phase ?? null,
          side: holdSide,
        })
      : { hold: 40, sweep: 22, brk: 22, chop: 16 }

    const holdDest = holdTgtRu ?? {
      price: holdSide === 'LONG' ? primary.top + atr * 2 : primary.bottom - atr * 2,
      label: holdSide === 'LONG' ? 'ликвидность сверху' : 'стопы снизу',
    }
    const breakDest = failTgtRu ?? {
      price: holdSide === 'LONG' ? primary.bottom - atr * 2 : primary.top + atr * 2,
      label: holdSide === 'LONG' ? 'стопы снизу' : 'ликвидность сверху',
    }

    const holdPath = holdPathOf({
      price: livePrice,
      primary,
      target: holdDest,
      side: holdSide,
      barSeconds,
    })
    const sweepPath = sweepPathOf({
      price: livePrice,
      primary,
      target: holdDest,
      side: holdSide,
      barSeconds,
      sweepPrice: sweep,
    })
    const lostPath = breakPathOf({
      price: livePrice,
      primary,
      target: breakDest,
      side: holdSide,
      barSeconds,
    })
    const rangePath = chopPathOf({ price: livePrice, primary, barSeconds })

    const zStart = timeSec(primary.startTime)
    const zEnd = timeSec(primary.endTime) || zStart
    const fromPrice = (primary.top + primary.bottom) / 2

    scenarios.push(
      {
        id: 'hold',
        pct: four.hold,
        side: holdSide,
        dirLabel: dirWord(holdSide),
        condition: holdCondition(holdSide),
        title: holdArrowCaption(holdSide, holdDest.label),
        path: holdPath,
        toPrice: holdDest.price,
        toLabel: holdDest.label,
      },
      {
        id: 'sweep',
        pct: four.sweep,
        side: holdSide,
        dirLabel: dirWord(holdSide),
        condition: sweepCondition(holdSide),
        title: 'свип → разворот',
        path: sweepPath,
        toPrice: holdDest.price,
        toLabel: holdDest.label,
      },
      {
        id: 'break',
        pct: four.brk,
        side: failSide ?? (holdSide === 'LONG' ? 'SHORT' : 'LONG'),
        dirLabel: dirWord(failSide ?? 'RANGE'),
        condition: breakCondition(holdSide),
        title: `слом → ${breakDest.label}`,
        path: lostPath,
        toPrice: breakDest.price,
        toLabel: breakDest.label,
      },
      {
        id: 'chop',
        pct: four.chop,
        side: 'RANGE',
        dirLabel: dirWord('RANGE'),
        condition: 'если останемся внутри',
        title: 'пила внутри зоны',
        path: rangePath,
        toPrice: (primary.top + primary.bottom) / 2,
        toLabel: 'середина зоны',
      }
    )

    const prices = [
      livePrice,
      holdDest.price,
      breakDest.price,
      ...holdPath.map((p) => p.price),
    ].filter((p) => p > 0 && Number.isFinite(p))
    prices.push(primary.top, primary.bottom)
    const boxLow = Math.min(...prices)
    const boxHigh = Math.max(...prices)
    const maxOff = Math.max(1, ...holdPath.map((p) => p.timeOffsetSeconds || 0))
    const bar = Math.max(1, barSeconds)
    future = {
      path: holdPath,
      failPath: lostPath,
      targetPrice: holdDest.price,
      targetLabel: holdDest.label,
      failTargetPrice: breakDest.price,
      failTargetLabel: breakDest.label,
      boxLow,
      boxHigh,
      bars: Math.min(14, Math.max(6, Math.ceil(maxOff / bar) + 2)),
      side: holdSide,
    }

    arrows.push({
      id: 'hold',
      kind: 'PRIMARY',
      side: holdSide,
      fromPrice,
      toPrice: holdDest.price,
      toLabel: holdDest.label,
      zoneTop: primary.top,
      zoneBottom: primary.bottom,
      zoneStartSec: zStart,
      zoneEndSec: zEnd,
      oddsPct: four.hold,
      label: holdArrowCaption(holdSide, holdDest.label),
      sweepPrice: sweep,
    })
  }

  const legend = legendOf(primary, secondary)
  return {
    primary,
    secondary,
    displayZones,
    nowKind,
    nowLine,
    side: holdSide,
    future,
    odds: scoredOdds,
    arrows,
    scenarios: padStoryScenarios(scenarios, holdSide, livePrice || price, barSeconds),
    legend: legend.length
      ? legend
      : [
          {
            role: 'STRONG',
            text: 'сильная · зона на графике',
            range: '—',
            take: holdSide,
          },
        ],
  }
}

export { fmtPx as fmtStoryPrice }
