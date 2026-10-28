import type { MexcTrade } from '../../api/mexc'
import type { BuyerAggressionResult } from '../types'

export interface AggressionOptions {
  /** Minimum total notional in the window, USD */
  minVolumeUsd?: number
  /** Price move over the same window, % (signed) */
  priceMovePct?: number | null
  /** Optional 1h quote volume for adaptive floor (0.5% of hourly) */
  avgHourlyVolumeUsd?: number | null
}

/**
 * Анализ ленты сделок: агрессия покупателей + absorption trap.
 *
 * High buy/sell ratio is only bullish when price actually progresses.
 * Huge buying into a flat/falling price is an iceberg/absorption sell signal,
 * not a long trigger. Volume is measured in USD, and a silent thin tape can
 * never produce a 500,000× ratio from a 0.0001 denominator.
 */
export function detectBuyerAggression(
  trades: MexcTrade[],
  windowSec = 20,
  buyToSellThreshold = 3.0,
  opts: AggressionOptions = {}
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
    absorption: false,
    volumeUsd: 0,
    priceMovePct: null,
  }

  if (!trades || trades.length < 5) return empty

  const now = Date.now()
  const cutoff = now - windowSec * 1000
  const recentTrades = trades.filter((t) => t.timestamp >= cutoff)
  if (recentTrades.length < 3) return empty

  let buyVolume = 0
  let sellVolume = 0
  let buyVolumeUsd = 0
  let sellVolumeUsd = 0

  for (const trade of recentTrades) {
    const notional = trade.price > 0 ? trade.price * trade.volume : 0
    if (trade.side === 'BUY') {
      buyVolume += trade.volume
      buyVolumeUsd += notional
    } else {
      sellVolume += trade.volume
      sellVolumeUsd += notional
    }
  }

  const totalVolumeUsd = buyVolumeUsd + sellVolumeUsd
  const hourlyFloor =
    opts.avgHourlyVolumeUsd != null && opts.avgHourlyVolumeUsd > 0
      ? opts.avgHourlyVolumeUsd * 0.005
      : 0
  const minVolumeUsd = Math.max(opts.minVolumeUsd ?? 25_000, hourlyFloor)
  if (totalVolumeUsd < minVolumeUsd) {
    return {
      ...empty,
      buyVolume,
      sellVolume,
      buyToSellRatio: sellVolumeUsd > 0 ? buyVolumeUsd / sellVolumeUsd : 0,
      volumeUsd: totalVolumeUsd,
      label: `Объём ленты $${(totalVolumeUsd / 1000).toFixed(1)}k < $${(minVolumeUsd / 1000).toFixed(0)}k — сигнал не считается`,
    }
  }

  const buyToSellRatio =
    sellVolumeUsd > 0 ? buyVolumeUsd / sellVolumeUsd : buyVolumeUsd > 0 ? 99 : 1

  const avgTradeVolume =
    recentTrades.reduce((sum, t) => sum + t.volume, 0) / recentTrades.length

  const largeBuyCount = recentTrades.filter(
    (t) => t.side === 'BUY' && t.volume > avgTradeVolume * 2
  ).length

  const priceMovePct =
    opts.priceMovePct != null && Number.isFinite(opts.priceMovePct)
      ? opts.priceMovePct
      : null

  // Buying aggressively but price cannot progress = hidden seller absorbing.
  const absorption =
    buyToSellRatio >= buyToSellThreshold &&
    priceMovePct != null &&
    priceMovePct < 0.03

  const detected = buyToSellRatio >= buyToSellThreshold && !absorption

  let color: BuyerAggressionResult['color'] = 'NEUTRAL'
  if (absorption) color = 'YELLOW'
  else if (buyToSellRatio >= buyToSellThreshold * 1.5) color = 'GREEN'
  else if (buyToSellRatio >= buyToSellThreshold) color = 'YELLOW'

  const label = absorption
    ? `АБСОРБЦИЯ: покупки ×${buyToSellRatio.toFixed(1)}, цена ${priceMovePct?.toFixed(2) ?? '0.00'}% — скрытый продавец`
    : detected
      ? `Агрессия покупателей ×${buyToSellRatio.toFixed(1)} | ${largeBuyCount} крупных | $${(totalVolumeUsd / 1000).toFixed(0)}k / ${windowSec}с`
      : `Покупка/Продажа: ${buyToSellRatio.toFixed(2)}x (порог ${buyToSellThreshold}x)`

  return {
    detected,
    buyVolume,
    sellVolume,
    buyToSellRatio,
    threshold: buyToSellThreshold,
    largeBuyCount,
    windowSec,
    // Absorption is a warning, never a +2 long boost.
    scoreBoost: detected ? 2 : 0,
    label,
    color,
    updatedAt: Date.now(),
    absorption,
    volumeUsd: totalVolumeUsd,
    priceMovePct,
  }
}
