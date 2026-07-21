import type { MexcTrade } from '../../api/mexc'
import type { BuyerAggressionResult } from '../types'

/**
 * Анализирует ленту сделок и определяет агрессию покупателей.
 */
export function detectBuyerAggression(
  trades: MexcTrade[],
  windowSec = 20,
  buyToSellThreshold = 3.0
): BuyerAggressionResult {
  const empty: BuyerAggressionResult = {
    detected: false,
    buyVolume: 0,
    sellVolume: 0,
    buyToSellRatio: 0,
    threshold: buyToSellThreshold,
    largeBuyCount: 0,
    windowSec,
    scoreBoost: 0,
    label: '',
    color: 'NEUTRAL',
    updatedAt: Date.now(),
  }

  if (!trades || trades.length < 5) return empty

  const now = Date.now()
  const cutoff = now - windowSec * 1000

  const recentTrades = trades.filter((t) => t.timestamp >= cutoff)

  if (recentTrades.length < 3) return empty

  let buyVolume = 0
  let sellVolume = 0

  for (const trade of recentTrades) {
    if (trade.side === 'BUY') {
      buyVolume += trade.volume
    } else {
      sellVolume += trade.volume
    }
  }

  if (sellVolume === 0) {
    sellVolume = 0.0001
  }

  const buyToSellRatio = buyVolume / sellVolume

  const avgTradeVolume =
    recentTrades.reduce((sum, t) => sum + t.volume, 0) / recentTrades.length

  const largeBuyCount = recentTrades.filter(
    (t) => t.side === 'BUY' && t.volume > avgTradeVolume * 2
  ).length

  const detected = buyToSellRatio >= buyToSellThreshold

  let color: BuyerAggressionResult['color'] = 'NEUTRAL'
  if (buyToSellRatio >= buyToSellThreshold * 1.5) color = 'GREEN'
  else if (buyToSellRatio >= buyToSellThreshold) color = 'YELLOW'

  const label = detected
    ? `Агрессия покупателей ×${buyToSellRatio.toFixed(1)} | ${largeBuyCount} крупных покупок | ${windowSec}с`
    : `Покупка/Продажа: ${buyToSellRatio.toFixed(2)}x (порог ${buyToSellThreshold}x)`

  return {
    detected,
    buyVolume,
    sellVolume,
    buyToSellRatio,
    threshold: buyToSellThreshold,
    largeBuyCount,
    windowSec,
    scoreBoost: detected ? 2 : 0,
    label,
    color,
    updatedAt: Date.now(),
  }
}
