/**
 * «Сундучки» — отложенные лимитные заявки на отскок от важных зон.
 *
 * Идея: цена ещё не дошла до зоны, но если дойдёт — там ставится лимитка
 * в сторону отскока. Считаем только те сценарии, где движение до цели
 * укладывается в 1–5 %, а риск/прибыль выглядят разумно.
 *
 * Все числа — оценка модели по доступным данным (зона, структура,
 * стакан, агрессия, импульс), а не гарантия сделки.
 */

import type { LiquidityZone } from '../indicators/types'

export interface LimitCase {
  id: string
  zoneId: string
  zoneLabel: string
  side: 'LONG' | 'SHORT'
  top: number
  bottom: number
  entry: number
  stop: number
  target: number
  /** Ход цены от лимитки до цели, % */
  movePct: number
  /** Расстояние до стопа, % */
  stopPct: number
  /** Соотношение прибыль/риск */
  rr: number
  /** Оценка модели, % (не гарантия) */
  probability: number
  strength: number
  reasons: string[]
  zone: LiquidityZone
}

export interface LimitCaseInput {
  zones: LiquidityZone[]
  price: number
  atr: number
  timeframe: string
  orderBookImbalance?: number | null
  buyerAggression?: number | null
  momentumPct?: number | null
  structureSide?: 'LONG' | 'SHORT' | null
  maxCases?: number
  minMovePct?: number
  maxMovePct?: number
}

const TYPE_RU: Record<LiquidityZone['type'], string> = {
  ORDER_BLOCK: 'блок заявок',
  FVG: 'FVG',
  FIBONACCI: 'Fibonacci',
  POC: 'POC',
  VALUE_AREA: 'зона проторговки',
  DAILY: 'дневной уровень',
  OTE: 'OTE',
  BSL: 'ликвидность сверху',
  SSL: 'ликвидность снизу',
  LIQ: 'ликвидность',
}

function norm(z: LiquidityZone): { top: number; bottom: number; height: number } {
  const top = Math.max(z.top, z.bottom)
  const bottom = Math.min(z.top, z.bottom)
  return { top, bottom, height: Math.max(0, top - bottom) }
}

function fmtPct(n: number): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`
}

/** Важная зона: сильная, первичная или структурная (OB/FVG/ликвидность). */
function isImportant(z: LiquidityZone): boolean {
  if (z.side === 'NEUTRAL') return false
  const strength = z.strength ?? 0
  if (z.storyRole === 'PRIMARY') return true
  if (z.type === 'ORDER_BLOCK' || z.type === 'FVG' || z.type === 'BSL' || z.type === 'SSL') {
    return strength >= 5 || Boolean(z.target) || Boolean(z.invalidation)
  }
  return strength >= 6
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Собрать отложенные лимитки-«сундучки» на отскок от важных зон.
 */
export function buildLimitCases(input: LimitCaseInput): LimitCase[] {
  const {
    price,
    atr,
    maxCases = 3,
    minMovePct = 1,
    maxMovePct = 5,
  } = input
  if (!(price > 0)) return []

  const buffer = Math.max(atr * 0.25, price * 0.0025)
  const zones = input.zones
    .map((z) => ({ z, ...norm(z) }))
    .filter(({ z, top, bottom, height }) => {
      if (!(top > bottom) || height / price > 0.25) return false
      if (!isImportant(z)) return false
      // Лимитка — только пока цена ещё не вошла в зону.
      if (price >= bottom && price <= top) return false
      const distPct = (Math.abs((top + bottom) / 2 - price) / price) * 100
      return distPct >= 0.15 && distPct <= 9
    })

  const cases: LimitCase[] = []

  for (const { z, top, bottom, height } of zones) {
    const below = top < price
    const side: 'LONG' | 'SHORT' = below ? 'LONG' : 'SHORT'

    const entry =
      side === 'LONG'
        ? top - height * 0.25
        : bottom + height * 0.25
    const stop =
      side === 'LONG' ? bottom - buffer : top + buffer
    if (!(entry > 0) || !(stop > 0)) continue
    if (side === 'LONG' && !(entry > stop)) continue
    if (side === 'SHORT' && !(stop > entry)) continue

    const stopPct = (Math.abs(entry - stop) / entry) * 100
    if (stopPct > 4) continue

    // Цель: ближайшая встречная зона, иначе измеренное движение.
    const opposite = zones
      .filter(({ z: o, top: oTop, bottom: oBottom }) => {
        if (o.id === z.id) return false
        if (side === 'LONG') return oBottom > entry * 1.004
        return oTop < entry * 0.996
      })
      .map(({ top: oTop, bottom: oBottom }) => ({
        edge: side === 'LONG' ? oBottom : oTop,
      }))
      .filter((o) => (side === 'LONG' ? o.edge > entry : o.edge < entry))
      .sort((a, b) =>
        side === 'LONG' ? a.edge - b.edge : b.edge - a.edge
      )

    let target = side === 'LONG' ? entry * 1.012 : entry * 0.988
    const zoneTarget = z.target
    if (
      zoneTarget != null &&
      zoneTarget > 0 &&
      ((side === 'LONG' && zoneTarget > entry) ||
        (side === 'SHORT' && zoneTarget < entry))
    ) {
      target = zoneTarget
    } else if (opposite[0]) {
      target = opposite[0].edge
    }

    // Держим ход в коридоре 1–5 %.
    let movePct = ((target - entry) / entry) * 100 * (side === 'LONG' ? 1 : -1)
    if (movePct < minMovePct) {
      const extended = opposite.find(
        (o) =>
          ((o.edge - entry) / entry) * 100 * (side === 'LONG' ? 1 : -1) >=
          minMovePct
      )
      if (extended) target = extended.edge
      else target = side === 'LONG' ? entry * (1 + minMovePct / 100) : entry * (1 - minMovePct / 100)
      movePct = ((target - entry) / entry) * 100 * (side === 'LONG' ? 1 : -1)
    }
    if (movePct > maxMovePct) {
      target = side === 'LONG' ? entry * (1 + maxMovePct / 100) : entry * (1 - maxMovePct / 100)
      movePct = maxMovePct
    }
    if (movePct < minMovePct || movePct > maxMovePct) continue

    const rr = movePct / Math.max(stopPct, 0.0001)
    if (rr < 1.1) continue

    const strength = z.strength ?? 0
    const flow =
      input.orderBookImbalance != null
        ? input.orderBookImbalance
        : input.buyerAggression != null
          ? (input.buyerAggression - 50) * 2
          : null
    const momentum = input.momentumPct ?? null
    const reasons: string[] = []

    let p = 44 + strength * 2.2
    reasons.push(
      `${TYPE_RU[z.type]} · сила ${strength > 0 ? `${Math.round(strength)}/12` : 'не оценена'}`
    )
    if (z.storyRole === 'PRIMARY') {
      p += 4
      reasons.push('главная зона текущего сценария')
    }
    if (input.structureSide === side) {
      p += 6
      reasons.push('совпадает со структурой рынка')
    } else if (input.structureSide) {
      p -= 6
      reasons.push('идёт против текущей структуры — осторожно')
    }
    if (
      (side === 'LONG' && z.side === 'BEARISH') ||
      (side === 'SHORT' && z.side === 'BULLISH')
    ) {
      p -= 3
      reasons.push('зона противоположного направления — реакция слабее')
    }
    if (flow != null && Math.abs(flow) >= 8) {
      const aligned = (side === 'LONG' && flow > 0) || (side === 'SHORT' && flow < 0)
      p += aligned ? 5 : -6
      reasons.push(
        aligned
          ? `стакан поддерживает: ${flow > 0 ? 'покупатели' : 'продавцы'} ${Math.abs(flow).toFixed(0)}%`
          : `стакан против: ${flow > 0 ? 'покупатели' : 'продавцы'} ${Math.abs(flow).toFixed(0)}%`
      )
    }
    if (momentum != null && Math.abs(momentum) >= 0.08) {
      const aligned = (side === 'LONG' && momentum > 0) || (side === 'SHORT' && momentum < 0)
      p += aligned ? 3 : -3
      reasons.push(
        `импульс ${fmtPct(momentum)} за 5 баров${aligned ? ' — по направлению' : ' — против входа'}`
      )
    }
    if (rr >= 2) {
      p += 3
      reasons.push(`прибыль/риск 1 : ${rr.toFixed(1)} — запас хороший`)
    } else if (rr < 1.4) {
      p -= 4
      reasons.push(`прибыль/риск 1 : ${rr.toFixed(1)} — тонкий запас`)
    }
    reasons.push(`цель ${fmtPct(movePct)} · стоп ${stopPct.toFixed(2)}%`)

    const probability = Math.round(clamp(p, 24, 84))
    cases.push({
      id: `case_${z.id}_${side}`,
      zoneId: z.id,
      zoneLabel: z.label || z.contextHint || TYPE_RU[z.type],
      side,
      top,
      bottom,
      entry,
      stop,
      target,
      movePct,
      stopPct,
      rr,
      probability,
      strength,
      reasons,
      zone: z,
    })
  }

  // Один вход на сторону — не заваливаем график сундуками.
  const bestBySide = new Map<'LONG' | 'SHORT', LimitCase>()
  for (const c of cases) {
    const prev = bestBySide.get(c.side)
    const score = c.probability * Math.min(c.rr, 2.5)
    const prevScore = prev ? prev.probability * Math.min(prev.rr, 2.5) : -1
    if (!prev || score > prevScore) bestBySide.set(c.side, c)
  }

  return [...bestBySide.values()]
    .sort((a, b) => b.probability * Math.min(b.rr, 2.5) - a.probability * Math.min(a.rr, 2.5))
    .slice(0, maxCases)
}
