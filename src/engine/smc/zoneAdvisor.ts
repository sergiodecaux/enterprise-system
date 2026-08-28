/**
 * Tap a zone → SMC advisor: hold vs break probabilities, wait/entry/invalidation,
 * and a non-linear path (approach → chop in zone → displacement → target).
 */

import type { LiquidityZone } from '../indicators/types'
import type { PathPoint } from '../prediction/types'
import type { StructureRead } from './structureRead'

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
  if (z.side === 'BULLISH') return 'LONG'
  if (z.side === 'BEARISH') return 'SHORT'
  const mid = (z.top + z.bottom) / 2
  return price >= mid ? 'SHORT' : 'LONG'
}

function pickTarget(
  side: 'LONG' | 'SHORT',
  price: number,
  structure: StructureRead | null
): { price: number; label: string } {
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

function holdPath(
  side: 'LONG' | 'SHORT',
  price: number,
  zone: LiquidityZone,
  target: number,
  magnet: number | null,
  bar: number
): PathPoint[] {
  const top = zone.top
  const bot = zone.bottom
  const mid = (top + bot) / 2
  const range = Math.max(top - bot, price * 0.001)
  const pts: PathPoint[] = [{ timeOffsetSeconds: 0, price, label: 'сейчас' }]
  if (side === 'SHORT') {
    pts.push(
      { timeOffsetSeconds: Math.round(bar * 1.4), price: lerp(price, top, 0.55), label: 'подход' },
      { timeOffsetSeconds: Math.round(bar * 2.4), price: top - range * 0.12, label: 'касание', isKeyLevel: true },
      { timeOffsetSeconds: Math.round(bar * 3.3), price: mid + range * 0.08, label: 'проторговка' },
      { timeOffsetSeconds: Math.round(bar * 4.2), price: top - range * 0.22, label: 'ещё в зоне' },
      { timeOffsetSeconds: Math.round(bar * 5.4), price: bot - range * 0.15, label: 'оторвались' },
      { timeOffsetSeconds: Math.round(bar * 10), price: target, label: 'цель', isKeyLevel: true }
    )
  } else {
    pts.push(
      { timeOffsetSeconds: Math.round(bar * 1.4), price: lerp(price, bot, 0.55), label: 'подход' },
      { timeOffsetSeconds: Math.round(bar * 2.4), price: bot + range * 0.12, label: 'касание', isKeyLevel: true },
      { timeOffsetSeconds: Math.round(bar * 3.3), price: mid - range * 0.08, label: 'проторговка' },
      { timeOffsetSeconds: Math.round(bar * 4.2), price: bot + range * 0.22, label: 'ещё в зоне' },
      { timeOffsetSeconds: Math.round(bar * 5.4), price: top + range * 0.15, label: 'оторвались' },
      { timeOffsetSeconds: Math.round(bar * 10), price: target, label: 'цель', isKeyLevel: true }
    )
  }
  if (magnet != null && magnet > 0) {
    const aligned =
      (side === 'LONG' && magnet > target) || (side === 'SHORT' && magnet < target)
    if (aligned) {
      pts.push({
        timeOffsetSeconds: Math.round(bar * 16),
        price: magnet,
        label: 'дальше',
        isKeyLevel: true,
      })
    }
  }
  return pts
}

function breakPath(
  side: 'LONG' | 'SHORT',
  price: number,
  zone: LiquidityZone,
  target: number,
  bar: number
): PathPoint[] {
  const range = Math.max(zone.top - zone.bottom, price * 0.001)
  if (side === 'LONG') {
    return [
      { timeOffsetSeconds: 0, price, label: 'сейчас' },
      { timeOffsetSeconds: Math.round(bar * 1.6), price: lerp(price, zone.top, 0.7), label: 'в зону' },
      { timeOffsetSeconds: Math.round(bar * 2.8), price: zone.top + range * 0.08, label: 'слом', isKeyLevel: true },
      { timeOffsetSeconds: Math.round(bar * 4.2), price: zone.top + range * 0.35, label: 'ретест сверху' },
      { timeOffsetSeconds: Math.round(bar * 11), price: target, label: 'полёт', isKeyLevel: true },
    ]
  }
  return [
    { timeOffsetSeconds: 0, price, label: 'сейчас' },
    { timeOffsetSeconds: Math.round(bar * 1.6), price: lerp(price, zone.bottom, 0.7), label: 'в зону' },
    { timeOffsetSeconds: Math.round(bar * 2.8), price: zone.bottom - range * 0.08, label: 'слом', isKeyLevel: true },
    { timeOffsetSeconds: Math.round(bar * 4.2), price: zone.bottom - range * 0.35, label: 'ретест снизу' },
    { timeOffsetSeconds: Math.round(bar * 11), price: target, label: 'падение', isKeyLevel: true },
  ]
}

/** Probability that the zone holds (bounce) vs breaks. */
function holdProbability(
  zone: LiquidityZone,
  side: 'LONG' | 'SHORT',
  price: number,
  structure: StructureRead | null
): number {
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

export function analyzeZoneTap(opts: {
  zone: LiquidityZone
  price: number
  structure: StructureRead | null
  timeframe: string
}): ZoneAdvisorBrief | null {
  const { zone, price, structure, timeframe } = opts
  if (!(price > 0) || !(zone.top > zone.bottom)) return null

  const kind = kindOf(zone)
  const side = bounceSide(zone, price)
  const bar = timeframeBarSeconds(timeframe)
  const pHold = holdProbability(zone, side, price, structure)
  const pBreak = 100 - pHold

  const holdT = pickTarget(side, price, structure)
  const breakSide: 'LONG' | 'SHORT' = side === 'LONG' ? 'SHORT' : 'LONG'
  const breakT = pickTarget(breakSide, price, structure)

  const mag =
    structure?.magnet &&
    ((side === 'LONG' && structure.magnet.price > holdT.price) ||
      (side === 'SHORT' && structure.magnet.price < holdT.price))
      ? structure.magnet
      : null

  const entry =
    side === 'SHORT'
      ? lerp(zone.top, zone.bottom, 0.35)
      : lerp(zone.bottom, zone.top, 0.35)
  const invalidation = side === 'SHORT' ? zone.top : zone.bottom
  const kindRu = kind === 'RANGE' ? 'проторговка' : kind

  const wait =
    side === 'SHORT'
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
    targetPrice: holdT.price,
    targetLabel: holdT.label,
    magnetPrice: mag?.price ?? null,
    magnetLabel: mag?.label ?? null,
    path: holdPath(side, price, zone, holdT.price, mag?.price ?? null, bar),
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
    targetPrice: breakT.price,
    targetLabel: breakT.label,
    magnetPrice: null,
    magnetLabel: null,
    path: breakPath(breakSide, price, zone, breakT.price, bar),
  }

  const summary =
    structure?.structureHeld
      ? `Закреп пока держит · основной сценарий: ${primary.title} (${pHold}%)`
      : `Структура слабая · сначала закреп в зоне, иначе слом (${pBreak}%)`

  return {
    zoneId: zone.id,
    kind,
    primary,
    alternate,
    summary,
    timeframe,
  }
}
