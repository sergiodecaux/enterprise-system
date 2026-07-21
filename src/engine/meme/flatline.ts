import type { OhlcvCandle } from '../../api/mexc'

export interface FlatlineResult {
  detected: boolean
  volumeMultiplier: number
  priceMovePct: number
  corridorPct: number
  scoreBoost: number
  label: string
  emoji: string
  alert: string | null
}

/**
 * Flatline Breakout / Ignition:
 * узкий коридор + мёртвый объём → внезапный объём ×20 при сдвиге 2–3%.
 */
export function detectFlatlineBreakout(
  ohlcv1m: OhlcvCandle[]
): FlatlineResult {
  const empty: FlatlineResult = {
    detected: false,
    volumeMultiplier: 0,
    priceMovePct: 0,
    corridorPct: 0,
    scoreBoost: 0,
    label: '',
    emoji: '',
    alert: null,
  }

  // ~3 дня 1m = много; берём что есть (до 500 если передадут), иначе 180+
  if (ohlcv1m.length < 90) return empty

  const last = ohlcv1m[ohlcv1m.length - 1]
  const base = ohlcv1m.slice(0, -1)
  // «мёртвый» период: последние 6–12ч без текущей свечи
  const deadWindow = base.slice(-Math.min(360, base.length))
  if (deadWindow.length < 60) return empty

  const highs = deadWindow.map((c) => c[2])
  const lows = deadWindow.map((c) => c[3])
  const rangeHigh = Math.max(...highs)
  const rangeLow = Math.min(...lows)
  const mid = (rangeHigh + rangeLow) / 2
  const corridorPct = mid > 0 ? ((rangeHigh - rangeLow) / mid) * 100 : 100

  const avgVol =
    deadWindow.reduce((s, c) => s + c[5], 0) / deadWindow.length
  // средний часовой ≈ 60 × avg 1m
  const avgHourlyVol = avgVol * 60

  if (avgHourlyVol <= 0 || corridorPct > 8) return empty

  const volMult = last[5] / avgHourlyVol
  const priceMovePct = Math.abs((last[4] - last[1]) / last[1]) * 100

  // объём ≥ 20× часового среднего, цена сдвинулась всего 1.5–5%
  if (volMult >= 20 && priceMovePct >= 1.5 && priceMovePct <= 5) {
    return {
      detected: true,
      volumeMultiplier: volMult,
      priceMovePct,
      corridorPct,
      scoreBoost: 40,
      emoji: '🔥',
      label: `IGNITION flatline | Vol ×${volMult.toFixed(0)} | Δ${priceMovePct.toFixed(1)}%`,
      alert:
        '🔥 IGNITION: алгоритм пампа запущен. Вход по рынку, стоп за свечу пробоя. R:R потенциал 1:20.',
    }
  }

  // softer ignition
  if (volMult >= 8 && priceMovePct >= 1 && corridorPct < 5) {
    return {
      detected: true,
      volumeMultiplier: volMult,
      priceMovePct,
      corridorPct,
      scoreBoost: 22,
      emoji: '🔥',
      label: `Early ignition | Vol ×${volMult.toFixed(0)}`,
      alert: '🔥 Раннее зажигание — следи за продолжением объёма',
    }
  }

  return {
    ...empty,
    volumeMultiplier: volMult,
    priceMovePct,
    corridorPct,
  }
}
