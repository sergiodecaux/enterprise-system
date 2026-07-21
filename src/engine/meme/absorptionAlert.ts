import type { OhlcvCandle, MexcTrade } from '../../api/mexc'

export interface AbsorptionAlertResult {
  detected: boolean
  type: 'DISTRIBUTION' | 'ACCUMULATION' | 'NONE'
  buyVolumeUsd: number
  candleIsDoji: boolean
  upperWickRatio: number
  scoreBoost: number
  longBlocked: boolean
  label: string
  emoji: string
  alert: string | null
}

/**
 * Iceberg / Absorption: огромные market buys, цена стоит / доджи с верхней тенью.
 */
export function detectIcebergAbsorption(
  trades: MexcTrade[],
  ohlcv1m: OhlcvCandle[],
  windowSec = 90
): AbsorptionAlertResult {
  const empty: AbsorptionAlertResult = {
    detected: false,
    type: 'NONE',
    buyVolumeUsd: 0,
    candleIsDoji: false,
    upperWickRatio: 0,
    scoreBoost: 0,
    longBlocked: false,
    label: '',
    emoji: '',
    alert: null,
  }

  if (!trades.length || ohlcv1m.length < 3) return empty

  const now = trades[0].timestamp
  const window = trades.filter((t) => now - t.timestamp <= windowSec * 1000)
  let buyUsd = 0
  let sellUsd = 0
  for (const t of window) {
    const usd = t.price * t.volume
    if (t.side === 'BUY') buyUsd += usd
    else sellUsd += usd
  }

  const last = ohlcv1m[ohlcv1m.length - 1]
  const [, open, high, low, close] = last
  const range = high - low
  if (range <= 0) return empty

  const body = Math.abs(close - open)
  const upperWick = high - Math.max(open, close)
  const upperWickRatio = upperWick / range
  const bodyRatio = body / range
  const isDoji = bodyRatio < 0.25
  const priceStuck =
    Math.abs((close - open) / open) * 100 < 0.8

  // Distribution: huge buys, price not rising, upper wick
  if (
    buyUsd >= 80_000 &&
    buyUsd > sellUsd * 2 &&
    (isDoji || (priceStuck && upperWickRatio > 0.4))
  ) {
    return {
      detected: true,
      type: 'DISTRIBUTION',
      buyVolumeUsd: buyUsd,
      candleIsDoji: isDoji,
      upperWickRatio,
      scoreBoost: 0,
      longBlocked: true,
      emoji: '🛑',
      label: `ABSORPTION DETECTED — DISTRIBUTION | buys $${(buyUsd / 1000).toFixed(0)}k`,
      alert:
        '🛑 ABSORPTION DETECTED. DISTRIBUTION PHASE. Не лонгуй — об тебя закрывают позиции!',
    }
  }

  // Accumulation trap: huge sells, price holds (CVD trap long)
  if (
    sellUsd >= 80_000 &&
    sellUsd > buyUsd * 2 &&
    priceStuck &&
    upperWickRatio < 0.35
  ) {
    return {
      detected: true,
      type: 'ACCUMULATION',
      buyVolumeUsd: buyUsd,
      candleIsDoji: isDoji,
      upperWickRatio,
      scoreBoost: 30,
      longBlocked: false,
      emoji: '🎯',
      label: `ABSORPTION LONG — ММ скупает шорты | sells $${(sellUsd / 1000).toFixed(0)}k`,
      alert:
        '🎯 ABSORPTION LONG: ритейл шортит в таз ММ. Жди выстрел вверх.',
    }
  }

  return {
    ...empty,
    buyVolumeUsd: buyUsd,
    candleIsDoji: isDoji,
    upperWickRatio,
  }
}
