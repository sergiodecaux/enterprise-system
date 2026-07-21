import type { WallTrackerState, WhaleWatcherState } from '../types'
import type { TradeSide } from '../smc'

export interface ScoreBoost {
  boost: number
  reason: string
}

/**
 * Бонус к SMC score на основе недавно съеденных стенок
 */
export function calculateWallBoost(
  wallTracker: WallTrackerState,
  signalDirection: TradeSide | null
): ScoreBoost {
  if (!signalDirection) {
    return { boost: 0, reason: 'Нет сигнала' }
  }

  const now = Date.now()
  const recentWindow = 60_000
  const recentEaten = wallTracker.events.filter(
    (e) => e.type === 'EATEN' && now - e.timestamp < recentWindow
  )

  if (recentEaten.length === 0) {
    return { boost: 0, reason: 'Нет съеденных стенок' }
  }

  let boost = 0
  let reason = ''

  for (const event of recentEaten) {
    const { wall, reduction } = event
    const intensity = reduction != null ? Math.min(reduction / 100, 1) : 0.5

    if (signalDirection === 'LONG' && wall.side === 'ASK') {
      boost += 1 * intensity
      reason = `ASK стенка съедена на ${wall.price.toFixed(2)} (-${reduction?.toFixed(0) ?? 0}%)`
    } else if (signalDirection === 'SHORT' && wall.side === 'BID') {
      boost += 1 * intensity
      reason = `BID стенка съедена на ${wall.price.toFixed(2)} (-${reduction?.toFixed(0) ?? 0}%)`
    } else {
      boost -= 0.5 * intensity
      reason = 'Стенка против направления сигнала'
    }
  }

  boost = Math.max(-1, Math.min(boost, 2))
  return { boost, reason }
}

/**
 * calculateWhaleBoost — буст к SMC score от whale-ордеров.
 *
 * Логика:
 * - LONG сетап + крупный BID (Whale Support) рядом → позитивный буст
 * - SHORT сетап + крупный ASK (Whale Resistance) рядом → позитивный буст
 * - Противоположная сторона → лёгкий штраф
 */
export function calculateWhaleBoost(
  whaleState: WhaleWatcherState | null,
  signalDirection: TradeSide | null
): ScoreBoost {
  if (!whaleState || !signalDirection) {
    return { boost: 0, reason: 'Нет данных наблюдателя китов' }
  }

  const { strongestSupport, strongestResistance, scoreBoost } = whaleState

  if (signalDirection === 'LONG') {
    if (strongestSupport && strongestSupport.distancePct <= 3.0) {
      return {
        boost: scoreBoost,
        reason: `Поддержка китов $${(strongestSupport.volumeUsd / 1e6).toFixed(1)}M на ${strongestSupport.price.toFixed(4)} (${strongestSupport.distancePct.toFixed(1)}% ниже)`,
      }
    }
    if (strongestResistance && strongestResistance.distancePct <= 2.0) {
      return {
        boost: -0.5,
        reason: `Сопротивление китов против ЛОНГ на ${strongestResistance.price.toFixed(4)}`,
      }
    }
  }

  if (signalDirection === 'SHORT') {
    if (strongestResistance && strongestResistance.distancePct <= 3.0) {
      return {
        boost: scoreBoost,
        reason: `Сопротивление китов $${(strongestResistance.volumeUsd / 1e6).toFixed(1)}M на ${strongestResistance.price.toFixed(4)} (${strongestResistance.distancePct.toFixed(1)}% выше)`,
      }
    }
    if (strongestSupport && strongestSupport.distancePct <= 2.0) {
      return {
        boost: -0.5,
        reason: `Поддержка китов против ШОРТ на ${strongestSupport.price.toFixed(4)}`,
      }
    }
  }

  return { boost: 0, reason: 'Киты вне зоны влияния' }
}
