import type { PathPoint } from './types'
import type { TradeStyle } from '../strategies/types'

export interface GhostPathInput {
  entry: number
  tp1: number
  tp2: number | null
  sl: number
  direction: 'LONG' | 'SHORT'
  atr: number
  /** ATR за «день» (примерно ATR(1H)*sqrt(24) или ATR(1D)) */
  dailyAtrPct: number
  style: TradeStyle
  candleTimeframeSeconds: number
}

export interface GhostPathResult {
  path: PathPoint[]
  /** Контрольные точки Безье в цене (для canvas) */
  bezierControls: Array<{ t: number; price: number }>
  /** TP нереалистичен относительно ATR×время */
  unrealisticTp: boolean
  adjustedTp1: number
  adjustedTp2: number | null
  warning: string | null
  /** Ожидаемое время до TP1, секунды */
  expectedDurationSec: number
}

function horizonSeconds(style: TradeStyle): number {
  return style === 'SCALP' ? 45 * 60 : 8 * 3600
}

/**
 * Корректирует TP если движение нереалистично для ATR и горизонта.
 * Пример: ATR говорит 5%/день, а TP = +15% за 2 часа → unrealistically flagged.
 */
export function validateTpRealism(
  entry: number,
  tp: number,
  dailyAtrPct: number,
  horizonSec: number
): { ok: boolean; maxRealisticTp: number; movePct: number; maxPct: number } {
  const movePct = (Math.abs(tp - entry) / entry) * 100
  const dayFraction = horizonSec / 86400
  // Допускаем до ~1.8× дневного ATR на горизонт (с учётом импульса)
  const maxPct = Math.max(dailyAtrPct * dayFraction * 1.8, dailyAtrPct * 0.15)
  const direction = tp >= entry ? 1 : -1
  const maxRealisticTp = entry * (1 + direction * (maxPct / 100))

  return {
    ok: movePct <= maxPct * 1.05,
    maxRealisticTp,
    movePct,
    maxPct,
  }
}

/**
 * Строит Ghost Path: сглаженная траектория entry → TP с учётом ATR и времени.
 * Кривые Безье рисуются в overlay по контрольным точкам.
 */
export function buildGhostPath(input: GhostPathInput): GhostPathResult {
  const {
    entry,
    tp1,
    tp2,
    sl,
    direction,
    atr,
    dailyAtrPct,
    style,
    candleTimeframeSeconds,
  } = input

  const horizon = horizonSeconds(style)
  const check1 = validateTpRealism(entry, tp1, dailyAtrPct, horizon)
  let adjustedTp1 = tp1
  let adjustedTp2 = tp2
  let unrealisticTp = false
  let warning: string | null = null

  if (!check1.ok) {
    unrealisticTp = true
    adjustedTp1 = check1.maxRealisticTp
    warning = `Нереалистичный TP: ${check1.movePct.toFixed(1)}% за горизонт при дневном ATR ${dailyAtrPct.toFixed(1)}%. Скорректировано до ${check1.maxPct.toFixed(1)}%.`
    if (tp2 != null) {
      const check2 = validateTpRealism(entry, tp2, dailyAtrPct, horizon * 1.5)
      if (!check2.ok) adjustedTp2 = check2.maxRealisticTp
    }
  }

  // Скорость: сколько ATR в единицу времени типично проходит монета
  const atrPct = (atr / entry) * 100
  const expectedMovePct = (Math.abs(adjustedTp1 - entry) / entry) * 100
  const barsNeeded = Math.max(
    3,
    Math.ceil((expectedMovePct / Math.max(atrPct, 0.05)) * (style === 'SCALP' ? 2 : 4))
  )
  const expectedDurationSec = barsNeeded * candleTimeframeSeconds

  const sign = direction === 'LONG' ? 1 : -1
  // Лёгкий «pullback» в начале пути (реалистичный вход), затем импульс к TP
  const pullback = atr * (style === 'SCALP' ? 0.15 : 0.35)
  const mid1 = entry - sign * pullback * 0.4
  const mid2 = entry + sign * Math.abs(adjustedTp1 - entry) * 0.45
  const overshoot =
    adjustedTp2 != null
      ? entry + sign * Math.abs(adjustedTp2 - entry) * 0.85
      : adjustedTp1

  const path: PathPoint[] = [
    { timeOffsetSeconds: 0, price: entry, label: 'Entry', isKeyLevel: true },
    {
      timeOffsetSeconds: Math.round(expectedDurationSec * 0.15),
      price: mid1,
      label: 'OTE fill',
    },
    {
      timeOffsetSeconds: Math.round(expectedDurationSec * 0.45),
      price: mid2,
      label: 'Impulse',
    },
    {
      timeOffsetSeconds: Math.round(expectedDurationSec * 0.75),
      price: adjustedTp1,
      label: 'TP1',
      isKeyLevel: true,
    },
    {
      timeOffsetSeconds: Math.round(expectedDurationSec * 1.15),
      price: overshoot,
      label: adjustedTp2 != null ? 'TP2' : 'Extension',
      isKeyLevel: adjustedTp2 != null,
    },
  ]

  // Контрольные точки кубической Безье (нормализованное t 0..1)
  const bezierControls = [
    { t: 0, price: entry },
    { t: 0.25, price: mid1 },
    { t: 0.55, price: mid2 },
    { t: 0.8, price: adjustedTp1 },
    { t: 1, price: overshoot },
  ]

  // SL как «тень» ниже/выше — не в основном path, но валидируем
  void sl

  return {
    path,
    bezierControls,
    unrealisticTp,
    adjustedTp1,
    adjustedTp2,
    warning,
    expectedDurationSec,
  }
}

/** Выборка точек кубической Безье между контрольными для canvas */
export function sampleCubicBezier(
  controls: Array<{ t: number; price: number }>,
  samples = 32
): Array<{ t: number; price: number }> {
  if (controls.length < 2) return controls

  const pts: Array<{ t: number; price: number }> = []
  const n = controls.length - 1

  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1)
    // Piecewise: найти сегмент
    let seg = 0
    for (let s = 0; s < n; s++) {
      if (u >= controls[s].t && u <= controls[s + 1].t) {
        seg = s
        break
      }
      if (s === n - 1) seg = s
    }

    const a = controls[seg]
    const b = controls[Math.min(seg + 1, n)]
    const span = b.t - a.t || 1
    const localT = (u - a.t) / span

    // Сглаживание hermite / smoothstep
    const s = localT * localT * (3 - 2 * localT)
    const price = a.price + (b.price - a.price) * s
    pts.push({ t: u, price })
  }

  return pts
}
