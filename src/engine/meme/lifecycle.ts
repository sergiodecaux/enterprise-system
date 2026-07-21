import type { OhlcvCandle } from '../../api/mexc'
import { calculateRsi } from '../smc'

export type MemeLifecyclePhase =
  | 'IGNITION'
  | 'FRENZY'
  | 'DISTRIBUTION'
  | 'WATERFALL'
  | 'UNKNOWN'

export interface LifecycleResult {
  phase: MemeLifecyclePhase
  badge: string
  color: string
  longAllowed: boolean
  shortAllowed: boolean
  label: string
  rsi: number | null
  deviationPct: number
}

/**
 * Фаза жизненного цикла мема по RSI + отклонению от SMA + структуре объёма.
 */
export function detectMemeLifecycle(
  ohlcv1m: OhlcvCandle[],
  ohlcv5m?: OhlcvCandle[]
): LifecycleResult {
  const unknown: LifecycleResult = {
    phase: 'UNKNOWN',
    badge: '❔ UNKNOWN',
    color: 'text-holo/40',
    longAllowed: true,
    shortAllowed: true,
    label: 'Недостаточно данных',
    rsi: null,
    deviationPct: 0,
  }

  const src = ohlcv5m && ohlcv5m.length >= 30 ? ohlcv5m : ohlcv1m
  if (src.length < 30) return unknown

  const closes = src.map((c) => c[4])
  const rsi = calculateRsi(closes, 14)
  const sma =
    closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length)
  const price = closes[closes.length - 1]
  const deviationPct = sma > 0 ? ((price - sma) / sma) * 100 : 0

  const recent = src.slice(-12)
  const vols = recent.map((c) => c[5])
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length
  const lastVol = vols[vols.length - 1]
  const volSpike = avgVol > 0 && lastVol >= avgVol * 3

  const ranges = recent.map((c) => ((c[2] - c[3]) / c[4]) * 100)
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length

  // Flat accumulation then breakout → Ignition
  const older = src.slice(-48, -12)
  if (older.length >= 20) {
    const olderRanges = older.map((c) => ((c[2] - c[3]) / c[4]) * 100)
    const olderAvg =
      olderRanges.reduce((a, b) => a + b, 0) / olderRanges.length
    const olderVol =
      older.reduce((s, c) => s + c[5], 0) / older.length
    if (olderAvg < 1.2 && olderVol > 0 && lastVol >= olderVol * 8 && volSpike) {
      return {
        phase: 'IGNITION',
        badge: '🟢 IGNITION',
        color: 'text-matrix',
        longAllowed: true,
        shortAllowed: false,
        label: 'Выход из накопления — идеальный вход',
        rsi,
        deviationPct,
      }
    }
  }

  // Frenzy: parabolic, high RSI, big deviation
  if ((rsi != null && rsi >= 78) || deviationPct >= 12) {
    if (avgRange >= 2.5 || deviationPct >= 20) {
      return {
        phase: 'FRENZY',
        badge: '🟡 FRENZY',
        color: 'text-yellow-400',
        longAllowed: true, // только жёсткий скальп
        shortAllowed: false,
        label: 'Парабола — только скальп, не усредняй',
        rsi,
        deviationPct,
      }
    }
  }

  // Distribution: high volume, saw, price not advancing
  const netMove =
    ((recent[recent.length - 1][4] - recent[0][1]) / recent[0][1]) * 100
  const highVolChop =
    avgVol > 0 &&
    vols.every((v) => v >= avgVol * 0.8) &&
    Math.abs(netMove) < 3 &&
    avgRange > 1.5

  if (highVolChop && (rsi == null || rsi > 55)) {
    return {
      phase: 'DISTRIBUTION',
      badge: '🔴 DISTRIBUTION',
      color: 'text-alert',
      longAllowed: false,
      shortAllowed: false,
      label: 'Пила на объёме — крупный выходит. Лонги запрещены',
      rsi,
      deviationPct,
    }
  }

  // Waterfall: structure break after pump
  const last3 = src.slice(-3)
  const falling =
    last3.length === 3 &&
    last3[2][4] < last3[1][4] &&
    last3[1][4] < last3[0][4] &&
    last3[2][4] < last3[2][1]

  if (falling && deviationPct > 5 && (rsi == null || rsi < 55)) {
    return {
      phase: 'WATERFALL',
      badge: '⚫️ WATERFALL',
      color: 'text-holo/70',
      longAllowed: false,
      shortAllowed: true,
      label: 'Слом параболы — ищи шорты',
      rsi,
      deviationPct,
    }
  }

  if (volSpike && deviationPct > 0 && (rsi == null || rsi < 70)) {
    return {
      phase: 'IGNITION',
      badge: '🟢 IGNITION',
      color: 'text-matrix',
      longAllowed: true,
      shortAllowed: false,
      label: 'Зажигание — всплеск объёма',
      rsi,
      deviationPct,
    }
  }

  return {
    phase: 'UNKNOWN',
    badge: '❔ RANGE',
    color: 'text-holo/40',
    longAllowed: true,
    shortAllowed: true,
    label: 'Нет явной фазы',
    rsi,
    deviationPct,
  }
}
