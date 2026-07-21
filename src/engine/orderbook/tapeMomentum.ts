import type {
  ImbalanceStats,
  OrderBookHistory,
  TapeMomentumState,
} from '../types'

/**
 * computeTapeMomentum — вычисляет состояние Tape Momentum.
 */
export function computeTapeMomentum(
  history: OrderBookHistory,
  stats: ImbalanceStats | null
): TapeMomentumState {
  const NEUTRAL: TapeMomentumState = {
    signal: 'NEUTRAL',
    imbalanceDelta: 0,
    pressure: 'NEUTRAL',
    consecutiveTicks: 0,
    isBurst: false,
    color: 'rgba(100, 116, 139, 0.8)',
    label: 'Нейтрально',
    lastUpdated: Date.now(),
  }

  if (!stats || history.imbalanceHistory.length < 5) return NEUTRAL

  const recent = history.imbalanceHistory.slice(-10)
  if (recent.length < 3) return NEUTRAL

  const last5 = recent.slice(-5)
  const first = last5[0].imbalance
  const last = last5[last5.length - 1].imbalance
  const delta = last - first

  const lastDelta =
    recent.length >= 2
      ? recent[recent.length - 1].imbalance -
        recent[recent.length - 2].imbalance
      : 0
  const isBurst = Math.abs(lastDelta) > 0.15

  let consecutiveTicks = 0
  for (let i = recent.length - 1; i >= 1; i--) {
    const d = recent[i].imbalance - recent[i - 1].imbalance
    if (delta > 0 && d > 0) consecutiveTicks++
    else if (delta < 0 && d < 0) consecutiveTicks++
    else break
  }

  const pressure =
    stats.current > 0.1
      ? 'BUYERS'
      : stats.current < -0.1
        ? 'SELLERS'
        : 'NEUTRAL'

  let signal: TapeMomentumState['signal'] = 'NEUTRAL'
  let color = 'rgba(100, 116, 139, 0.8)'
  let label = 'Нейтрально'

  if (delta > 0.2 && pressure === 'BUYERS' && consecutiveTicks >= 3) {
    signal = 'STRONG_BUY'
    color = 'rgba(0, 255, 65, 1)'
    label = isBurst
      ? '⚡ АГРЕССИВНЫЕ ПОКУПКИ — лимитник съеден!'
      : '📈 Сильный Buy Flow'
  } else if (delta > 0.1 && pressure === 'BUYERS') {
    signal = 'BUY'
    color = 'rgba(34, 197, 94, 0.9)'
    label = 'Покупатели доминируют'
  } else if (delta < -0.2 && pressure === 'SELLERS' && consecutiveTicks >= 3) {
    signal = 'STRONG_SELL'
    color = 'rgba(255, 0, 60, 1)'
    label = isBurst
      ? '⚡ АГРЕССИВНЫЕ ПРОДАЖИ — лимитник съеден!'
      : '📉 Сильный Sell Flow'
  } else if (delta < -0.1 && pressure === 'SELLERS') {
    signal = 'SELL'
    color = 'rgba(239, 68, 68, 0.9)'
    label = 'Продавцы доминируют'
  }

  return {
    signal,
    imbalanceDelta: parseFloat(delta.toFixed(4)),
    pressure,
    consecutiveTicks,
    isBurst,
    color,
    label,
    lastUpdated: Date.now(),
  }
}
