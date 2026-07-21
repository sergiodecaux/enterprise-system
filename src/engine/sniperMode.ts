import type { CoinSignal } from './types'

/**
 * Расширенный снайперский сигнал с калиброванным винрейтом и R:R
 */
export interface SniperSignal extends CoinSignal {
  /** Калиброванный винрейт (учитывает все фильтры, cap 90%) */
  calibratedWinRate: number
  /** Risk/Reward соотношение */
  riskReward: number
  /** Размер риска в % от входа */
  riskPercent: number
  /** Размер награды в % от входа */
  rewardPercent: number
  /** Точка входа (может быть surgical entry или текущая цена) */
  entryPrice: number
  /** Причины прохождения фильтров (для UI) */
  sniperReasons: string[]
  /** Количество активных фильтров силы */
  strengthFiltersActive: number
}

/**
 * Фильтр: проверяет проходит ли сигнал в Sniper Mode
 */
export function isSniperQuality(signal: CoinSignal): boolean {
  if (!signal.hasActiveSetup) return false
  if (signal.score < 7) return false
  if (signal.sl == null || signal.tp1 == null) return false

  let strengthFilters = 0
  if (signal.absorption?.detected) strengthFilters++
  if (signal.ltfChoCH?.detected) strengthFilters++
  if (signal.buyerAggression?.detected && signal.direction === 'LONG') {
    strengthFilters++
  }

  if (strengthFilters < 2) return false

  if (!signal.direction) return false
  const dailyDir = signal.dailyBias
  if (signal.direction === 'LONG' && dailyDir === 'BEARISH') return false
  if (signal.direction === 'SHORT' && dailyDir === 'BULLISH') return false

  if (signal.currentRSI !== null) {
    if (signal.direction === 'LONG' && signal.currentRSI >= 45) return false
    if (signal.direction === 'SHORT' && signal.currentRSI <= 55) return false
  }

  const entry = signal.ltfChoCH?.surgicalEntryPrice ?? signal.price
  const risk = Math.abs(entry - signal.sl)
  const reward = Math.abs(signal.tp1 - entry)
  if (risk === 0) return false
  const rr = reward / risk
  if (rr < 3) return false

  return true
}

function calculateCalibratedWinRate(signal: CoinSignal): number {
  let winRate = (signal.score / 10) * 100

  if (signal.ltfChoCH?.detected) {
    winRate += signal.ltfChoCH.surgicalEntryDetected ? 6 : 4
  }
  if (signal.absorption?.detected) {
    winRate += 5
  }
  if (signal.buyerAggression?.detected) {
    winRate += 3
  }
  if (signal.raid && signal.raid.type !== 'NONE' && signal.raid.isFresh) {
    winRate += 3
  }
  if (signal.ote?.priceInZone) {
    winRate += 2
  }
  if (signal.btcDivergence?.type === 'BULL_DIV' && signal.direction === 'LONG') {
    winRate += 2
  }
  if (signal.btcDivergence?.type === 'BEAR_DIV' && signal.direction === 'SHORT') {
    winRate += 2
  }

  return Math.min(Math.round(winRate), 90)
}

/**
 * Конвертирует обычный сигнал в снайперский (с расширенной информацией)
 */
export function toSniperSignal(signal: CoinSignal): SniperSignal {
  if (!signal.sl || !signal.tp1 || !signal.direction) {
    throw new Error('Cannot create SniperSignal: missing SL/TP/direction')
  }

  const entryPrice = signal.ltfChoCH?.surgicalEntryPrice ?? signal.price

  const risk = Math.abs(entryPrice - signal.sl)
  const reward = Math.abs(signal.tp1 - entryPrice)
  const riskReward = risk > 0 ? reward / risk : 0

  const riskPercent = (risk / entryPrice) * 100
  const rewardPercent = (reward / entryPrice) * 100

  const calibratedWinRate = calculateCalibratedWinRate(signal)

  const reasons: string[] = []
  let strengthFilters = 0

  if (signal.zones.length > 0) {
    const htfZones = signal.zones.filter(
      (z) => z.includes('OB') || z.includes('FVG') || z.includes('FIB')
    )
    if (htfZones.length > 0) {
      reasons.push(`HTF: ${htfZones.slice(0, 2).join(' + ')}`)
    }
  }

  if (signal.ltfChoCH?.detected) {
    strengthFilters++
    reasons.push(
      signal.ltfChoCH.surgicalEntryDetected
        ? '🎯 CHoCH + Surgical Entry'
        : '✅ CHoCH 1m'
    )
  }

  if (signal.absorption?.detected) {
    strengthFilters++
    reasons.push(
      `💎 Absorption ×${signal.absorption.volumeMultiplier.toFixed(1)}`
    )
  }

  if (signal.buyerAggression?.detected && signal.direction === 'LONG') {
    strengthFilters++
    reasons.push(
      `⚡ Buyer Aggression ×${signal.buyerAggression.buyToSellRatio.toFixed(1)}`
    )
  }

  if (signal.raid && signal.raid.type !== 'NONE' && signal.raid.isFresh) {
    reasons.push('🔄 Liquidity Sweep')
  }

  if (signal.ote?.priceInZone) {
    reasons.push('📍 OTE Zone')
  }

  if (signal.btcDivergence?.type === 'BULL_DIV' && signal.direction === 'LONG') {
    reasons.push('📈 BTC Bull Divergence')
  }
  if (signal.btcDivergence?.type === 'BEAR_DIV' && signal.direction === 'SHORT') {
    reasons.push('📉 BTC Bear Divergence')
  }

  return {
    ...signal,
    calibratedWinRate,
    riskReward,
    riskPercent,
    rewardPercent,
    entryPrice,
    sniperReasons: reasons,
    strengthFiltersActive: strengthFilters,
  }
}

/**
 * Фильтрует список сигналов → возвращает только снайперские
 */
export function getSniperSignals(signals: CoinSignal[]): SniperSignal[] {
  return signals
    .filter(isSniperQuality)
    .map(toSniperSignal)
    .sort((a, b) => {
      if (a.calibratedWinRate !== b.calibratedWinRate) {
        return b.calibratedWinRate - a.calibratedWinRate
      }
      return b.riskReward - a.riskReward
    })
}
