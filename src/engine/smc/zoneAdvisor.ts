/**
 * Tap a zone → SMC advisor: hold vs break probabilities, wait/entry/invalidation,
 * and a non-linear path (approach → chop in zone → displacement → target).
 */

import type { LiquidityZone } from '../indicators/types'
import type { PathPoint } from '../prediction/types'
import type { Fib141State, StructureRead } from './structureRead'
import { reactionForZone } from './zoneReaction'

export interface AdvisorLeg {
  side: 'LONG' | 'SHORT'
  probability: number
  title: string
  wait: string
  entry: number
  entryTop: number
  entryBottom: number
  invalidation: number
  invalidationHint: string
  targetPrice: number
  targetLabel: string
  magnetPrice: number | null
  magnetLabel: string | null
  path: PathPoint[]
}

export interface ZoneAdvisorBrief {
  zoneId: string
  kind: 'FVG' | 'OB' | 'RANGE'
  primary: AdvisorLeg
  alternate: AdvisorLeg
  summary: string
  timeframe: string
  /** Zone context: fib confluence, 141 band, liquidity, what was already swept */
  notes: ZoneNote[]
  /** 0…5 — how many independent factors line up with the zone */
  confluence: number
  strength: number
  strengthTier: 'WEAK' | 'MEDIUM' | 'STRONG'
  zoneLabel: string
  zoneTop: number
  zoneBottom: number
}

export interface ZoneNote {
  key: 'strength' | 'fib' | 'fib141' | 'liq' | 'sweep' | 'orderflow' | 'momentum'
  label: string
  value: string
  tone: 'good' | 'bad' | 'flat'
}

export interface ZoneContextFib {
  ratio: number
  price: number
  tf: string
  distPct: number
}

export interface ZoneContext141 {
  kind: 'sweep' | 'cont'
  state: Fib141State
  bias: 'LONG' | 'SHORT'
  top: number
  bottom: number
  price141: number | null
  price161: number | null
}

export interface ZoneContextLiq {
  price: number
  label: string
  distPct: number
}

export interface ZoneContextSweep {
  side: 'BSL' | 'SSL'
  price: number
  barsAgo: number
  reclaimed: boolean
}

export interface ZoneContext {
  orderBookImbalance?: number | null
  buyerAggression?: number | null
  momentumPct?: number | null
  strength?: number
  tier?: 'WEAK' | 'MEDIUM' | 'STRONG'
  fib?: ZoneContextFib | null
  fib141?: ZoneContext141 | null
  liqAbove?: ZoneContextLiq | null
  liqBelow?: ZoneContextLiq | null
  swept?: ZoneContextSweep | null
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function timeframeBarSeconds(tf: string): number {
  if (tf === '1m') return 60
  if (tf === '5m') return 300
  if (tf === '15m') return 900
  if (tf === '4h') return 14_400
  if (tf === '1d') return 86_400
  return 3_600
}

function kindOf(z: LiquidityZone): ZoneAdvisorBrief['kind'] {
  if (z.type === 'FVG') return 'FVG'
  if (z.type === 'ORDER_BLOCK') return 'OB'
  return 'RANGE'
}

/** Smallest / most actionable painted band under a tap (price). Time is ignored — FVG/OB are drawn out to the right. */
export function hitZoneAt(
  zones: LiquidityZone[],
  price: number,
  _timeSec?: number | null
): LiquidityZone | null {
  if (!(price > 0) || !zones.length) return null
  const hits = zones.filter((z) => price <= z.top && price >= z.bottom)
  if (!hits.length) return null
  hits.sort((a, b) => {
    const rank = (z: LiquidityZone) => {
      if (z.storyRole === 'PRIMARY') return -1
      if (z.type === 'FVG') return 0
      if (z.type === 'ORDER_BLOCK') return 1
      if (z.contextHint) return 2
      return 3
    }
    const d = rank(a) - rank(b)
    if (d !== 0) return d
    return a.top - a.bottom - (b.top - b.bottom)
  })
  return hits[0]
}

function bounceSide(z: LiquidityZone, price: number): 'LONG' | 'SHORT' {
  if (price < z.bottom) return 'SHORT'
  if (price > z.top) return 'LONG'
  if (z.side === 'BULLISH') return 'LONG'
  if (z.side === 'BEARISH') return 'SHORT'
  const mid = (z.top + z.bottom) / 2
  return price >= mid ? 'SHORT' : 'LONG'
}

function pickTarget(
  side: 'LONG' | 'SHORT',
  price: number,
  structure: StructureRead | null,
  zone?: LiquidityZone
): { price: number; label: string } {
  const rx = zone ? reactionForZone(structure?.zones, zone) : null
  if (rx) {
    if (side === bounceSide(zone!, price) && rx.targetIfHold) {
      return { price: rx.targetIfHold.price, label: rx.targetIfHold.label }
    }
    const dump = side === 'LONG' ? rx.nextIfBreakUp : rx.nextIfBreakDown
    if (side !== bounceSide(zone!, price) && dump) {
      const mid = (dump.top + dump.bottom) / 2
      return { price: mid, label: dump.label }
    }
  }
  const h4 = structure?.h4
  const mag = structure?.magnet
  if (side === 'LONG') {
    const lvl = mag && mag.price > price ? mag : null
    const h4t = h4?.nextBsl ?? h4?.dealingHigh
    if (lvl) return { price: lvl.price, label: mag!.label }
    if (h4t != null && h4t > price) return { price: h4t, label: 'сопротивление 4ч' }
    return { price: price * 1.012, label: 'ликвидность сверху' }
  }
  const lvl = mag && mag.price < price ? mag : null
  const h4t = h4?.nextSsl ?? h4?.dealingLow
  if (lvl) return { price: lvl.price, label: mag!.label }
  if (h4t != null && h4t < price) return { price: h4t, label: 'поддержка 4ч' }
  return { price: price * 0.988, label: 'ликвидность снизу' }
}

/**
 * Path starts ON the selected zone (never at the current price) so the arrow
 * always grows out of the band the user clicked.
 */
function holdPath(
  side: 'LONG' | 'SHORT',
  zone: LiquidityZone,
  target: number,
  magnet: number | null,
  bar: number
): PathPoint[] {
  const top = zone.top
  const bot = zone.bottom
  const range = Math.max(top - bot, Math.max(top, 1) * 0.0008)
  let pts: PathPoint[]
  if (side === 'SHORT') {
    pts = [
      { timeOffsetSeconds: 0, price: bot, label: 'зона' },
      { timeOffsetSeconds: Math.round(bar * 1.1), price: top - range * 0.22, label: 'ретест' },
      { timeOffsetSeconds: Math.round(bar * 2.3), price: bot, label: 'закреп', isKeyLevel: true },
      { timeOffsetSeconds: Math.round(bar * 3.6), price: bot - (bot - target) * 0.45 },
      { timeOffsetSeconds: Math.round(bar * 9), price: target, label: 'цель', isKeyLevel: true },
    ]
  } else {
    pts = [
      { timeOffsetSeconds: 0, price: top, label: 'зона' },
      { timeOffsetSeconds: Math.round(bar * 1.1), price: bot + range * 0.22, label: 'ретест' },
      { timeOffsetSeconds: Math.round(bar * 2.3), price: top, label: 'закреп', isKeyLevel: true },
      { timeOffsetSeconds: Math.round(bar * 3.6), price: top + (target - top) * 0.45 },
      { timeOffsetSeconds: Math.round(bar * 9), price: target, label: 'цель', isKeyLevel: true },
    ]
  }
  if (magnet != null && magnet > 0) {
    const aligned =
      (side === 'LONG' && magnet > target) || (side === 'SHORT' && magnet < target)
    if (aligned) {
      pts.push({
        timeOffsetSeconds: Math.round(bar * 15),
        price: magnet,
        label: 'дальше',
        isKeyLevel: true,
      })
    }
  }
  return pts
}

/** Break leg: from the zone edge facing price, through the band, to the target. */
function breakPath(
  side: 'LONG' | 'SHORT',
  zone: LiquidityZone,
  target: number,
  bar: number
): PathPoint[] {
  const top = zone.top
  const bot = zone.bottom
  const range = Math.max(top - bot, Math.max(top, 1) * 0.0008)
  if (side === 'LONG') {
    return [
      { timeOffsetSeconds: 0, price: bot, label: 'зона' },
      { timeOffsetSeconds: Math.round(bar * 1.2), price: top, label: 'пробой', isKeyLevel: true },
      { timeOffsetSeconds: Math.round(bar * 2.2), price: top + range * 0.3, label: 'закреп' },
      { timeOffsetSeconds: Math.round(bar * 3.2), price: top + range * 0.15, label: 'ретест' },
      { timeOffsetSeconds: Math.round(bar * 9), price: target, label: 'цель', isKeyLevel: true },
    ]
  }
  return [
    { timeOffsetSeconds: 0, price: top, label: 'зона' },
    { timeOffsetSeconds: Math.round(bar * 1.2), price: bot, label: 'пробой', isKeyLevel: true },
    { timeOffsetSeconds: Math.round(bar * 2.2), price: bot - range * 0.3, label: 'закреп' },
    { timeOffsetSeconds: Math.round(bar * 3.2), price: bot - range * 0.15, label: 'ретест' },
    { timeOffsetSeconds: Math.round(bar * 9), price: target, label: 'цель', isKeyLevel: true },
  ]
}

/** Probability that the zone holds (bounce) vs breaks. */
function holdProbability(
  zone: LiquidityZone,
  side: 'LONG' | 'SHORT',
  price: number,
  structure: StructureRead | null
): number {
  const rx = reactionForZone(structure?.zones, zone)
  if (rx) {
    return Math.round(clamp(rx.holdProbability, 22, 84))
  }
  let p = 52
  const held = structure?.structureHeld ?? false
  const pref = structure?.preferredSide
  if (pref === side) p += 10
  else if (pref && pref !== side) p -= 12
  if (held && pref === side) p += 8
  if (!held && pref && pref !== side) p -= 6
  p += ((structure?.confidence ?? 40) - 50) * 0.12
  const inside = price <= zone.top && price >= zone.bottom
  if (inside) p += 4
  const kind = kindOf(zone)
  if (kind === 'FVG') p += 3
  if (kind === 'OB') p += 2
  return Math.round(clamp(p, 28, 76))
}

const TIER_RU: Record<'WEAK' | 'MEDIUM' | 'STRONG', string> = {
  WEAK: 'слабая',
  MEDIUM: 'средняя',
  STRONG: 'сильная',
}

const FIB141_RU: Record<Fib141State, string> = {
  NONE: 'нет реакции',
  APPROACHING: 'подход',
  INSIDE: 'внутри',
  BOUNCE: 'отскок',
  BREAK: 'пробой',
  RECLAIM: 'возврат',
}

function fmt(p: number): string {
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}

function buildNotes(
  ctx: ZoneContext | null | undefined,
  side: 'LONG' | 'SHORT',
  strength: number,
  tier: 'WEAK' | 'MEDIUM' | 'STRONG'
): { notes: ZoneNote[]; confluence: number; adj: number } {
  const notes: ZoneNote[] = []
  let adj = 0
  let conf = 0

  notes.push({
    key: 'strength',
    label: 'Сила зоны',
    value: `${strength > 0 ? Math.round(strength) : '—'} · ${TIER_RU[tier]}`,
    tone: tier === 'STRONG' ? 'good' : tier === 'WEAK' ? 'bad' : 'flat',
  })
  if (tier === 'STRONG') {
    adj += 5
    conf += 1
  } else if (tier === 'MEDIUM') {
    adj += 1
  } else {
    adj -= 5
  }

  if (ctx?.orderBookImbalance != null || ctx?.buyerAggression != null) {
    const obi = ctx.orderBookImbalance
    const aggression = ctx.buyerAggression
    const flow = obi != null ? obi : (aggression! - 50) * 2
    const aligned = (side === 'LONG' && flow >= 12) || (side === 'SHORT' && flow <= -12)
    const against = (side === 'LONG' && flow <= -12) || (side === 'SHORT' && flow >= 12)
    notes.push({
      key: 'orderflow',
      label: obi != null ? 'Стакан / дисбаланс' : 'Агрессия сделок',
      value: obi != null ? `${obi > 0 ? 'покупатели' : obi < 0 ? 'продавцы' : 'нейтр.'} ${Math.abs(obi).toFixed(0)}%` : `покупки ${aggression!.toFixed(0)}%`,
      tone: aligned ? 'good' : against ? 'bad' : 'flat',
    })
    if (aligned) { adj += 5; conf += 1 }
    else if (against) adj -= 7
  }

  if (ctx?.momentumPct != null) {
    const aligned = (side === 'LONG' && ctx.momentumPct > 0) || (side === 'SHORT' && ctx.momentumPct < 0)
    notes.push({
      key: 'momentum',
      label: 'Импульс цены',
      value: `${ctx.momentumPct > 0 ? '+' : ''}${ctx.momentumPct.toFixed(2)}% за 5 баров`,
      tone: aligned ? 'good' : Math.abs(ctx.momentumPct) < 0.08 ? 'flat' : 'bad',
    })
    if (aligned) adj += 3
    else if (Math.abs(ctx.momentumPct) >= 0.08) adj -= 4
  }

  const f = ctx?.fib
  if (f) {
    const near = Math.abs(f.distPct) <= 0.6
    notes.push({
      key: 'fib',
      label: `Фибо ${f.tf}`,
      value: `${(f.ratio * 100).toFixed(1)}% · ${fmt(f.price)}`,
      tone: near ? 'good' : 'flat',
    })
    if (near) {
      adj += 4
      conf += 1
    } else {
      adj += 1
    }
  }

  const z = ctx?.fib141
  if (z) {
    const active = z.state !== 'NONE'
    const aligned = active && z.bias === side
    notes.push({
      key: 'fib141',
      label: z.kind === 'sweep' ? '141 · свип' : '141 · продолжение',
      value: active
        ? `${FIB141_RU[z.state]} · ${aligned ? 'по сценарию' : 'против'}`
        : 'нет реакции',
      tone: active ? (aligned ? 'good' : 'bad') : 'flat',
    })
    if (active) {
      if (aligned) {
        adj += 4
        conf += 1
      } else {
        adj -= 5
      }
      if (z.state === 'BREAK') adj -= 6
      if (z.state === 'RECLAIM') adj += 3
      if (z.state === 'BOUNCE') adj += 3
    }
  }

  const la = ctx?.liqAbove
  const lb = ctx?.liqBelow
  if (la || lb) {
    const parts: string[] = []
    if (lb) parts.push(`↓ ${fmt(lb.price)} · ${lb.label}`)
    if (la) parts.push(`↑ ${fmt(la.price)} · ${la.label}`)
    const take = side === 'LONG' ? la : lb
    notes.push({
      key: 'liq',
      label: 'Ликвидность',
      value: parts.join('   '),
      tone: take && take.distPct <= 3 ? 'good' : 'flat',
    })
    if (take && take.distPct <= 3) {
      adj += 2
      conf += 1
    }
  }

  const s = ctx?.swept
  if (s) {
    notes.push({
      key: 'sweep',
      label: s.reclaimed ? 'Сняли и вернулись' : 'Сняли',
      value: `${s.side} ${fmt(s.price)} · ${s.barsAgo > 0 ? `${s.barsAgo} бар.` : 'только что'}`,
      tone: s.reclaimed ? 'good' : 'flat',
    })
    if (s.reclaimed) {
      adj += 2
      conf += 1
    }
  }

  return { notes, confluence: conf, adj }
}

export function analyzeZoneTap(opts: {
  zone: LiquidityZone
  price: number
  structure: StructureRead | null
  timeframe: string
  context?: ZoneContext | null
}): ZoneAdvisorBrief | null {
  const { price, structure, timeframe } = opts
  const zone: LiquidityZone =
    opts.zone.top >= opts.zone.bottom
      ? opts.zone
      : { ...opts.zone, top: opts.zone.bottom, bottom: opts.zone.top }
  if (!(price > 0) || !(zone.top > zone.bottom)) return null

  const ctx = opts.context ?? null
  const kind = kindOf(zone)
  const side = bounceSide(zone, price)
  const bar = timeframeBarSeconds(timeframe)
  const strength = ctx?.strength ?? zone.strength ?? 0
  const tier =
    ctx?.tier ??
    zone.strengthTier ??
    (strength >= 9 ? 'STRONG' : strength >= 6 ? 'MEDIUM' : 'WEAK')
  const { notes, confluence, adj } = buildNotes(ctx, side, strength, tier)
  const pHold = Math.round(clamp(holdProbability(zone, side, price, structure) + adj, 16, 90))
  const pBreak = 100 - pHold

  const holdT = pickTarget(side, price, structure, zone)
  const breakSide: 'LONG' | 'SHORT' = side === 'LONG' ? 'SHORT' : 'LONG'
  const breakT = pickTarget(breakSide, price, structure, zone)
  const rx = reactionForZone(structure?.zones, zone)

  const range = Math.max(zone.top - zone.bottom, price * 0.001)
  const room = Math.max(range * 1.6, price * 0.006)
  let holdTarget = holdT.price
  if (side === 'LONG' && holdTarget <= zone.top + range * 0.15) {
    holdTarget = zone.top + room
  }
  if (side === 'SHORT' && holdTarget >= zone.bottom - range * 0.15) {
    holdTarget = zone.bottom - room
  }
  let breakTarget = breakT.price
  if (breakSide === 'LONG' && breakTarget <= zone.top + range * 0.3) {
    breakTarget = zone.top + room * 1.25
  }
  if (breakSide === 'SHORT' && breakTarget >= zone.bottom - range * 0.3) {
    breakTarget = zone.bottom - room * 1.25
  }

  const mag =
    structure?.magnet &&
    ((side === 'LONG' && structure.magnet.price > holdTarget) ||
      (side === 'SHORT' && structure.magnet.price < holdTarget))
      ? structure.magnet
      : null

  const entry =
    side === 'SHORT'
      ? lerp(zone.top, zone.bottom, 0.35)
      : lerp(zone.bottom, zone.top, 0.35)
  const invalidation = side === 'SHORT' ? zone.top : zone.bottom
  const kindRu = kind === 'RANGE' ? 'проторговка' : kind

  const wait = rx
    ? rx.state === 'CONSOLIDATING_UNDER' || rx.state === 'HOLDING_BELOW'
      ? rx.going === 'DOWN'
        ? `Уже закрепились под зоной. Шорт от проторговки, цель ${holdT.label}.`
        : `Проторговка под зоной — ждём, пойдёт ли вниз. Слом вверх отменяет шорт.`
      : rx.state === 'CONSOLIDATING_OVER' || rx.state === 'HOLDING_ABOVE'
        ? rx.going === 'UP'
          ? `Закреп над зоной держит. Лонг от проторговки, цель ${holdT.label}.`
          : `Проторговка над зоной — закреп слабый, риск слива вниз.`
        : rx.state === 'RECLAIMED'
          ? `Ложный пробой и закреп обратно. Основной сценарий — от зоны.`
          : rx.narrative
    : side === 'SHORT'
      ? `Ждать заход в ${kindRu} и закреп свечой под зоной. Не ловить маркет сверху.`
      : `Ждать заход в ${kindRu} и закреп свечой над зоной. Не ловить маркет снизу.`

  const invHint =
    side === 'SHORT'
      ? `Сетап сломан, если час закроется выше ${invalidation.toFixed(price >= 100 ? 2 : 4)}`
      : `Сетап сломан, если час закроется ниже ${invalidation.toFixed(price >= 100 ? 2 : 4)}`

  const primary: AdvisorLeg = {
    side,
    probability: pHold,
    title: side === 'SHORT' ? `${kindRu} · шорт с отката` : `${kindRu} · лонг с отката`,
    wait,
    entry,
    entryTop: zone.top,
    entryBottom: zone.bottom,
    invalidation,
    invalidationHint: invHint,
    targetPrice: holdTarget,
    targetLabel: holdT.label,
    magnetPrice: mag?.price ?? null,
    magnetLabel: mag?.label ?? null,
    path: holdPath(side, zone, holdTarget, mag?.price ?? null, bar),
  }

  const breakInv = breakSide === 'LONG' ? zone.top : zone.bottom
  const alternate: AdvisorLeg = {
    side: breakSide,
    probability: pBreak,
    title:
      breakSide === 'LONG'
        ? `слом зоны · полёт вверх`
        : `слом зоны · падение вниз`,
    wait:
      breakSide === 'LONG'
        ? `Если цену выкупили выше зоны и закрепили — не шортить, ждать лонг после ретеста.`
        : `Если зону продавили и закрепили ниже — не лонговать, ждать шорт после ретеста.`,
    entry: breakInv,
    entryTop: zone.top,
    entryBottom: zone.bottom,
    invalidation: (zone.top + zone.bottom) / 2,
    invalidationHint:
      breakSide === 'LONG'
        ? `Идея полёта отменяется возвратом и закрепом обратно в зону`
        : `Идея падения отменяется возвратом и закрепом обратно в зону`,
    targetPrice: breakTarget,
    targetLabel: breakT.label,
    magnetPrice: null,
    magnetLabel: null,
    path: breakPath(breakSide, zone, breakTarget, bar),
  }

  const summary = rx
    ? rx.narrative
    : structure?.structureHeld
      ? `Закреп пока держит · основной сценарий: ${primary.title} (${pHold}%)`
      : `Структура слабая · сначала закреп в зоне, иначе слом (${pBreak}%)`

  return {
    zoneId: zone.id,
    kind,
    primary,
    alternate,
    summary,
    timeframe,
    notes,
    confluence,
    strength,
    strengthTier: tier,
    zoneLabel: zone.label ?? kindRu,
    zoneTop: zone.top,
    zoneBottom: zone.bottom,
  }
}
