/**
 * «Сундучки» — отложенные лимитные заявки на отскок от важных зон.
 *
 * Вход ставится в объёмный POC/CE зоны, а не в её геометрический край.
 * Стоп — структурная инвалидация ± 0.5×ATR. Цель — реальная встречная
 * ликвидность/структура; никаких принудительных 1–5% клампов.
 * Быстрое падение в LONG-зону (и рост в SHORT-зону) блокирует слепой филл.
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
  /** @deprecated Targets are no longer clamped; kept for call-site compatibility. */
  maxMovePct?: number
}

/** Maximum distance from price to the zone mid. */
const MAX_ZONE_DIST_PCT = 3.5
/** A structural stop wider than this is not a limit-case, it is a knife. */
const MAX_STOP_PCT = 3.5

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
  } = input
  if (!(price > 0)) return []

  const buffer = atr > 0 ? atr * 0.5 : price * 0.0025
  const zones = input.zones
    .map((z) => ({ z, ...norm(z) }))
    .filter(({ z, top, bottom, height }) => {
      if (!(top > bottom) || height / price > 0.25) return false
      if (z.mitigated) return false
      if (!isImportant(z)) return false
      // A zone whose far edge has already been accepted through is dead.
      if (z.invalidation != null && Number.isFinite(z.invalidation)) {
        if (z.side === 'BULLISH' && price < z.invalidation) return false
        if (z.side === 'BEARISH' && price > z.invalidation) return false
      }
      // Лимитка — только пока цена ещё не вошла в зону.
      if (price >= bottom && price <= top) return false
      const distPct = (Math.abs((top + bottom) / 2 - price) / price) * 100
      return distPct >= 0.1 && distPct <= MAX_ZONE_DIST_PCT
    })

  const cases: LimitCase[] = []
  const atrPct = price > 0 ? (atr / price) * 100 : 0.5
  // A fast move into a zone is a knife, not a limit fill. Use ATR-normalized
  // velocity so the gate adapts to the instrument.
  const velocityLimitPct = Math.max(0.35, atrPct * 1.5)

  for (const { z, top, bottom, height } of zones) {
    const below = top < price
    const side: 'LONG' | 'SHORT' = below ? 'LONG' : 'SHORT'

    // Enter at the zone's volume POC / FVG CE, never blindly at the edge.
    const insideAnchor = (n: number | undefined): n is number =>
      typeof n === 'number' &&
      Number.isFinite(n) &&
      n >= bottom &&
      n <= top
    const rawEntry =
      insideAnchor(z.poc) && z.poc > 0
        ? z.poc
        : insideAnchor(z.ce) && z.ce > 0
          ? z.ce
          : side === 'LONG'
            ? top - height * 0.25
            : bottom + height * 0.25
    const inset = height * 0.05
    const entry =
      top - inset > bottom + inset
        ? clamp(rawEntry, bottom + inset, top - inset)
        : rawEntry
    if (!(entry > 0)) continue

    const structEdge =
      side === 'LONG'
        ? Math.min(bottom, z.invalidation ?? bottom)
        : Math.max(top, z.invalidation ?? top)
    const stop = side === 'LONG' ? structEdge - buffer : structEdge + buffer
    if (!(stop > 0)) continue
    if (side === 'LONG' && !(entry > stop)) continue
    if (side === 'SHORT' && !(stop > entry)) continue

    const stopPct = (Math.abs(entry - stop) / entry) * 100
    if (stopPct > MAX_STOP_PCT) continue

    // Velocity / exhaustion gate: do not fill a long into a fast waterfall,
    // or a short into a vertical squeeze.
    const momentum = input.momentumPct ?? null
    if (
      momentum != null &&
      ((side === 'LONG' && momentum < -velocityLimitPct) ||
        (side === 'SHORT' && momentum > velocityLimitPct))
    ) {
      continue
    }

    const flow =
      input.orderBookImbalance != null
        ? input.orderBookImbalance
        : input.buyerAggression != null
          ? (input.buyerAggression - 50) * 2
          : null
    if (
      flow != null &&
      ((side === 'LONG' && flow <= -30) ||
        (side === 'SHORT' && flow >= 30))
    ) {
      continue
    }

    // Targets: zone's own target + real opposite zone edges. No synthetic
    // 1–5% clamp, no arbitrary extension.
    const targetCandidates: number[] = []
    if (
      z.target != null &&
      Number.isFinite(z.target) &&
      z.target > 0 &&
      ((side === 'LONG' && z.target > entry) ||
        (side === 'SHORT' && z.target < entry))
    ) {
      targetCandidates.push(z.target)
    }
    for (const o of zones) {
      if (o.z.id === z.id) continue
      const edge = side === 'LONG' ? o.bottom : o.top
      if (side === 'LONG' ? edge > entry : edge < entry) {
        targetCandidates.push(edge)
      }
    }

    const targets = Array.from(new Set(targetCandidates))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => (side === 'LONG' ? a - b : b - a))

    let target: number | null = null
    for (const candidate of targets) {
      const move =
        ((candidate - entry) / entry) * 100 * (side === 'LONG' ? 1 : -1)
      if (move >= minMovePct) {
        target = candidate
        break
      }
    }
    if (target == null) continue

    const movePct =
      ((target - entry) / entry) * 100 * (side === 'LONG' ? 1 : -1)
    const rr = movePct / Math.max(stopPct, 0.0001)
    if (rr < 1.2) continue

    const strength = z.strength ?? 0
    const reasons: string[] = []

    let p = 44 + strength * 2.2
    reasons.push(
      `${TYPE_RU[z.type]} · сила ${strength > 0 ? `${Math.round(strength)}/10` : 'не оценена'}`
    )
    if (
      (insideAnchor(z.poc) && entry === z.poc) ||
      (insideAnchor(z.ce) && entry === z.ce)
    ) {
      p += 2
      reasons.push('вход в объёмный POC/CE зоны')
    }
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
