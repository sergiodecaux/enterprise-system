import type { CoinSignal, TradeStyle } from './types'
import { getStyleProfile } from './strategies'
import { isSurgicalReady } from './surgical/surgicalEntry'

/**
 * Расширенный снайперский сигнал с калиброванным винрейтом и R:R
 */
export interface SniperSignal extends CoinSignal {
  /** Калиброванный Confidence Score (не historical WR; cap 95%) */
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
  /** Гарантированный tradeStyle */
  tradeStyle: TradeStyle
}

/**
 * Фильтр: проверяет проходит ли сигнал в Sniper Mode (с учётом стиля)
 */
export function isSniperQuality(signal: CoinSignal): boolean {
  if (!signal.hasActiveSetup) return false
  if (signal.score < 7) return false
  if (signal.sl == null || signal.tp1 == null) return false
  if (!signal.direction) return false

  const style: TradeStyle = signal.tradeStyle ?? 'INTRADAY'
  const profile = getStyleProfile(style)

  let strengthFilters = 0

  if (style === 'SCALP') {
    if (signal.absorption?.detected) strengthFilters++
    if (
      signal.raid &&
      signal.raid.type !== 'NONE' &&
      signal.raid.isFresh
    ) {
      strengthFilters++
    }
    if (signal.buyerAggression?.detected) strengthFilters++
    if (signal.cvdDivergence?.detected) strengthFilters++
    if (signal.liquidationContext?.swept) strengthFilters++
    if (signal.ltfChoCH?.detected) strengthFilters++
  } else if (style === 'SWING') {
    if (signal.ote?.priceInZone) strengthFilters++
    if (signal.mss?.detected) strengthFilters++
    if (signal.globalFib?.inReactionZone) strengthFilters++
    if (signal.globalFib?.activeLabel?.includes('141')) strengthFilters++
    if (signal.volumeProfile?.obPocConfluence) strengthFilters++
    if (signal.ltfChoCH?.detected) strengthFilters++
  } else {
    if (signal.absorption?.detected) strengthFilters++
    if (signal.ltfChoCH?.detected) strengthFilters++
    if (signal.buyerAggression?.detected && signal.direction === 'LONG') {
      strengthFilters++
    }
    if (signal.ote?.priceInZone) strengthFilters++
    if (signal.volumeProfile?.obPocConfluence) strengthFilters++
    if (signal.mss?.detected) strengthFilters++
  }

  if (strengthFilters < profile.minStrengthFilters) return false

  // Ювелирный вход: если есть surgical plan — только READY
  const surgical = signal.surgicalEntry
  if (surgical && surgical.status !== 'IDLE') {
    if (!isSurgicalReady(surgical)) return false
  }

  // Мемы: обязателен свежий Liquidity Raid (не входим на первом касании),
  // кроме элитных сетапов со своим триггером (squeeze / flatline / cvdTrap / backside)
  if (signal.memePulse) {
    const eliteMeme =
      !!signal.memePulse.squeeze?.setup ||
      !!signal.memePulse.squeeze?.inProgress ||
      !!signal.memePulse.flatline?.detected ||
      !!signal.memePulse.cvdTrap?.detected ||
      !!signal.memePulse.backside?.detected
    const hasFreshRaid =
      !!signal.raid &&
      signal.raid.type !== 'NONE' &&
      signal.raid.isFresh
    if (!eliteMeme && !hasFreshRaid) return false
  }

  const dailyDir = signal.dailyBias
  if (style === 'INTRADAY' || style === 'SWING') {
    if (signal.direction === 'LONG' && dailyDir === 'BEARISH') return false
    if (signal.direction === 'SHORT' && dailyDir === 'BULLISH') return false
  }

  if (signal.currentRSI !== null) {
    // Soft RSI — scalp/LTF can enter earlier than classic HTF rules
    const style = signal.tradeStyle ?? 'INTRADAY'
    if (style === 'SCALP') {
      if (signal.direction === 'LONG' && signal.currentRSI >= 62) return false
      if (signal.direction === 'SHORT' && signal.currentRSI <= 38) return false
    } else {
      if (signal.direction === 'LONG' && signal.currentRSI >= 52) return false
      if (signal.direction === 'SHORT' && signal.currentRSI <= 48) return false
    }
  }

  // Интрадей: gate ликвидаций должен быть открыт для элитных
  if (
    style === 'INTRADAY' &&
    signal.liquidationContext &&
    !signal.liquidationContext.gateOpen
  ) {
    return false
  }

  const entry = signal.ltfChoCH?.surgicalEntryPrice ?? signal.price
  const risk = Math.abs(entry - signal.sl)
  const reward = Math.abs(signal.tp1 - entry)
  if (risk === 0) return false
  const rr = reward / risk
  if (rr < profile.minRiskReward) return false

  return true
}

function calculateCalibratedWinRate(signal: CoinSignal): number {
  // Prefer style-specific confidence (моментный Confidence Score)
  if (signal.styleConfidence != null && signal.styleConfidence > 0) {
    return Math.min(Math.round(signal.styleConfidence), 95)
  }

  let winRate = (signal.score / 10) * 100
  const style = signal.tradeStyle ?? 'INTRADAY'

  if (style === 'SCALP') {
    if (signal.raid && signal.raid.type !== 'NONE' && signal.raid.isFresh) {
      winRate += 6
    }
    if (signal.absorption?.detected) winRate += 5
    if (signal.buyerAggression?.detected) winRate += 4
    if (signal.cvdDivergence?.detected) winRate += 4
    if (signal.liquidationContext?.swept && signal.liquidationContext.fresh) {
      winRate += 8
    }
  } else if (style === 'SWING') {
    if (signal.globalFib?.inReactionZone) winRate += 6
    if (signal.globalFib?.activeLabel?.includes('141')) winRate += 4
    if (signal.ote?.priceInZone) winRate += 3
    if (signal.mss?.detected) winRate += 4
    if (signal.volumeProfile?.obPocConfluence) winRate += 3
  } else {
    if (signal.ltfChoCH?.detected) {
      winRate += signal.ltfChoCH.surgicalEntryDetected ? 6 : 4
    }
    if (signal.ote?.priceInZone) winRate += 3
    if (signal.volumeProfile?.obPocConfluence) winRate += 5
    if (signal.absorption?.detected) winRate += 3
    if (signal.liquidationContext?.swept) winRate += 4
  }

  if (signal.btcDivergence?.type === 'BULL_DIV' && signal.direction === 'LONG') {
    winRate += 2
  }
  if (signal.btcDivergence?.type === 'BEAR_DIV' && signal.direction === 'SHORT') {
    winRate += 2
  }

  return Math.min(Math.round(winRate), 95)
}

/**
 * Конвертирует обычный сигнал в снайперский (с расширенной информацией)
 */
export function toSniperSignal(signal: CoinSignal): SniperSignal {
  if (!signal.sl || !signal.tp1 || !signal.direction) {
    throw new Error('Cannot create SniperSignal: missing SL/TP/direction')
  }

  const tradeStyle: TradeStyle = signal.tradeStyle ?? 'INTRADAY'
  const entryPrice =
    isSurgicalReady(signal.surgicalEntry)
      ? signal.surgicalEntry!.limitEntry!
      : signal.ltfChoCH?.surgicalEntryPrice ?? signal.price

  const risk = Math.abs(entryPrice - signal.sl)
  const reward = Math.abs(signal.tp1 - entryPrice)
  const riskReward = risk > 0 ? reward / risk : 0

  const riskPercent = (risk / entryPrice) * 100
  const rewardPercent = (reward / entryPrice) * 100

  const calibratedWinRate = calculateCalibratedWinRate(signal)

  const reasons: string[] = []
  let strengthFilters = 0

  const profile = getStyleProfile(tradeStyle)
  reasons.push(`${profile.badge} [${profile.timeframeHint}]`)

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

  if (isSurgicalReady(signal.surgicalEntry)) {
    reasons.push(
      `🎯 Limit ${signal.surgicalEntry!.limitEntry!.toPrecision(6)} · ${signal.surgicalEntry!.confirmations.slice(0, 2).join('+')}`
    )
  } else if (
    signal.surgicalEntry &&
    signal.surgicalEntry.status !== 'IDLE'
  ) {
    reasons.push(`⏳ ${signal.surgicalEntry.status}`)
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
    if (tradeStyle === 'SCALP') strengthFilters++
  }

  if (signal.ote?.priceInZone) {
    reasons.push('📍 OTE Zone — набирай сеткой')
  }

  if (signal.volumeProfile?.obPocConfluence) {
    reasons.push(`📊 ${signal.volumeProfile.confluenceLabel}`)
    strengthFilters++
  }

  if (signal.liquidationContext?.swept) {
    reasons.push(`💥 ${signal.liquidationContext.label}`)
    strengthFilters++
  }

  if (signal.cvdDivergence?.detected) {
    reasons.push(`Δ ${signal.cvdDivergence.label}`)
  }

  if (signal.unrealisticTp && signal.ghostPathWarning) {
    reasons.push(`⚠️ TP скорректирован по ATR`)
  }

  if (signal.btcDivergence?.type === 'BULL_DIV' && signal.direction === 'LONG') {
    reasons.push('📈 BTC Bull Divergence')
  }
  if (signal.btcDivergence?.type === 'BEAR_DIV' && signal.direction === 'SHORT') {
    reasons.push('📉 BTC Bear Divergence')
  }

  return {
    ...signal,
    tradeStyle,
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
export function getSniperSignals(
  signals: CoinSignal[],
  styleFilter: 'ALL' | TradeStyle = 'ALL'
): SniperSignal[] {
  return signals
    .filter(isSniperQuality)
    .map(toSniperSignal)
    .filter((s) => styleFilter === 'ALL' || s.tradeStyle === styleFilter)
    .sort((a, b) => {
      if (a.calibratedWinRate !== b.calibratedWinRate) {
        return b.calibratedWinRate - a.calibratedWinRate
      }
      return b.riskReward - a.riskReward
    })
}
