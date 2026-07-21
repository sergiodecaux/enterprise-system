import type {
  CoinSignal,
  MemeSignal,
  OrderBookMetrics,
  BuyerAggressionResult,
  WhaleWatcherState,
  SessionDNA,
  PO3Analysis,
} from '../types'
import {
  classifyAsset,
  detectMarketPhase,
  detectDominantForce,
  detectVolatilityLevel,
  type AssetType,
  type MarketPhase,
  type DominantForce,
  type VolatilityLevel,
} from './assetClassifier'

export type {
  AssetType,
  MarketPhase,
  DominantForce,
  VolatilityLevel,
} from './assetClassifier'

export interface ConfluenceBreakdown {
  technical: { score: number; factors: string[] }
  orderFlow: { score: number; factors: string[] }
  sentiment: { score: number; factors: string[] }
  timing: { score: number; factors: string[] }
}

export interface TacticalAdvice {
  primary: string
  reasoning: string[]
  warnings: string[]
  optimal: {
    entry: string
    stop: string
    targets: string
    timeframe: string
  }
}

export interface MemeContext {
  heatScore: number
  volumeMultiplier: number
  spreadQuality: string
  recommendation: string
  expectedMoveRange: string
}

export interface AltContext {
  structureQuality: string
  confluenceZones: number
  sessionAlignment: string
  expectedMoveRange: string
}

export interface CompositeAnalysis {
  symbol: string
  assetType: AssetType
  overallScore: number
  marketPhase: MarketPhase
  dominantForce: DominantForce
  volatilityLevel: VolatilityLevel
  confluenceBreakdown: ConfluenceBreakdown
  tacticalAdvice: TacticalAdvice
  memeContext?: MemeContext
  altContext?: AltContext
  computedAt: number
}

export function buildCompositeAnalysis(
  signal: CoinSignal,
  memeSignal?: MemeSignal,
  orderBookMetrics?: OrderBookMetrics | null,
  buyerAggression?: BuyerAggressionResult | null,
  whaleWatcher?: WhaleWatcherState | null,
  sessionDNA?: SessionDNA | null,
  po3?: PO3Analysis | null
): CompositeAnalysis {
  const resolvedMeme = memeSignal ?? signal.memePulse ?? undefined
  const spreadPressure = resolvedMeme?.spreadPressure

  const assetType = classifyAsset(
    signal.internalSymbol,
    signal.priceChange24h,
    spreadPressure,
    { hasMemePulse: !!resolvedMeme }
  )

  const marketPhase = detectMarketPhase(signal.coinTrend ?? 'RANGING')

  const dominantForce = detectDominantForce(
    spreadPressure,
    buyerAggression ?? signal.buyerAggression,
    orderBookMetrics?.imbalance
  )

  const volatilityLevel = detectVolatilityLevel(signal.priceChange24h, assetType)

  const confluenceBreakdown = buildConfluenceBreakdown(
    signal,
    resolvedMeme,
    orderBookMetrics,
    buyerAggression,
    whaleWatcher,
    sessionDNA,
    po3
  )

  const overallScore = Math.round(
    confluenceBreakdown.technical.score * 0.35 +
      confluenceBreakdown.orderFlow.score * 0.3 +
      confluenceBreakdown.sentiment.score * 0.15 +
      confluenceBreakdown.timing.score * 0.2
  )

  const tacticalAdvice = buildTacticalAdvice(
    assetType,
    signal,
    resolvedMeme,
    marketPhase,
    dominantForce,
    volatilityLevel,
    confluenceBreakdown,
    sessionDNA,
    po3
  )

  const memeContext: MemeContext | undefined =
    assetType === 'MEME' && resolvedMeme
      ? {
          heatScore: resolvedMeme.heatScore,
          volumeMultiplier: resolvedMeme.volumeSpike.volumeMultiplier,
          spreadQuality: resolvedMeme.spreadPressure.quality,
          recommendation: resolvedMeme.recommendation,
          expectedMoveRange: getExpectedMoveRange('MEME', volatilityLevel),
        }
      : undefined

  const altContext: AltContext | undefined =
    assetType === 'ALT' || assetType === 'BLUE_CHIP'
      ? {
          structureQuality: signal.hasActiveSetup
            ? 'Сильное совпадение HTF + LTF'
            : 'Частичная структура',
          confluenceZones: signal.zones.length,
          sessionAlignment: sessionDNA?.keyInsight ?? 'Неизвестно',
          expectedMoveRange: getExpectedMoveRange(assetType, volatilityLevel),
        }
      : undefined

  return {
    symbol: signal.internalSymbol,
    assetType,
    overallScore,
    marketPhase,
    dominantForce,
    volatilityLevel,
    confluenceBreakdown,
    tacticalAdvice,
    memeContext,
    altContext,
    computedAt: Date.now(),
  }
}

function buildConfluenceBreakdown(
  signal: CoinSignal,
  memeSignal?: MemeSignal,
  orderBookMetrics?: OrderBookMetrics | null,
  buyerAggression?: BuyerAggressionResult | null,
  whaleWatcher?: WhaleWatcherState | null,
  sessionDNA?: SessionDNA | null,
  po3?: PO3Analysis | null
): ConfluenceBreakdown {
  const technicalFactors: string[] = []
  let technicalScore = (signal.score / 10) * 100

  if (signal.score >= 7) {
    technicalFactors.push(`Сильный SMC (${signal.score}/10)`)
  }

  if (signal.mss?.detected) technicalFactors.push('MSS обнаружен')
  if (signal.ltfChoCH?.detected) {
    technicalFactors.push(
      signal.ltfChoCH.surgicalEntryDetected ? 'CHoCH + точный вход' : 'CHoCH'
    )
  }
  if (signal.raid && signal.raid.type !== 'NONE') {
    technicalFactors.push('Рейд ликвидности')
  }
  if (signal.ote?.priceInZone) technicalFactors.push('Зона OTE')
  if (signal.absorption?.detected) technicalFactors.push('Поглощение (VSA)')

  if (signal.btcDivergence?.type === 'BULL_DIV' && signal.direction === 'LONG') {
    technicalFactors.push('Бычья дивергенция BTC')
    technicalScore += 5
  }
  if (signal.btcDivergence?.type === 'BEAR_DIV' && signal.direction === 'SHORT') {
    technicalFactors.push('Медвежья дивергенция BTC')
    technicalScore += 5
  }

  technicalScore = Math.min(technicalScore, 100)

  const orderFlowFactors: string[] = []
  let orderFlowScore = 0

  if (memeSignal && memeSignal.spreadPressure.pressure !== 'NEUTRAL') {
    const quality = memeSignal.spreadPressure.quality
    if (quality === 'EXTREME') {
      orderFlowScore += 35
      orderFlowFactors.push(`Давление спреда: ${quality}`)
    } else if (quality === 'STRONG') {
      orderFlowScore += 25
      orderFlowFactors.push(`Давление спреда: ${quality}`)
    } else {
      orderFlowScore += 15
      orderFlowFactors.push(`Давление спреда: ${quality}`)
    }
  }

  if (buyerAggression?.detected) {
    orderFlowScore += 20
    orderFlowFactors.push(
      `Агрессия покупателей ×${buyerAggression.buyToSellRatio.toFixed(1)}`
    )
  }

  if (orderBookMetrics) {
    const imb = Math.abs(orderBookMetrics.imbalance)
    if (imb > 50) {
      orderFlowScore += 25
      orderFlowFactors.push(`Дисбаланс стакана ${imb.toFixed(0)}%`)
    } else if (imb > 20) {
      orderFlowScore += 15
      orderFlowFactors.push('Умеренный дисбаланс')
    }
  }

  if (whaleWatcher?.scoreBoost && whaleWatcher.scoreBoost > 0) {
    orderFlowScore += 20
    orderFlowFactors.push(
      whaleWatcher.strongestSupport
        ? 'Поддержка китов'
        : whaleWatcher.strongestResistance
          ? 'Сопротивление китов'
          : 'Активность китов'
    )
  }

  orderFlowScore = Math.min(orderFlowScore, 100)

  const sentimentFactors: string[] = []
  let sentimentScore = 50

  if (signal.dailyBias === 'BULLISH' && signal.direction === 'LONG') {
    sentimentScore += 25
    sentimentFactors.push('Дневной уклон совпадает')
  } else if (signal.dailyBias === 'BEARISH' && signal.direction === 'SHORT') {
    sentimentScore += 25
    sentimentFactors.push('Дневной уклон совпадает')
  } else if (
    (signal.dailyBias === 'BULLISH' && signal.direction === 'SHORT') ||
    (signal.dailyBias === 'BEARISH' && signal.direction === 'LONG')
  ) {
    sentimentScore -= 30
    sentimentFactors.push('Дневной уклон ПРОТИВ')
  }

  if (po3?.currentPhase === 'DISTRIBUTION' && signal.direction === 'SHORT') {
    sentimentScore += 15
    sentimentFactors.push('PO3: фаза распределения')
  } else if (po3?.currentPhase === 'ACCUMULATION' && signal.direction === 'LONG') {
    sentimentScore += 15
    sentimentFactors.push('PO3: фаза накопления')
  }

  sentimentScore = Math.max(0, Math.min(sentimentScore, 100))

  const timingFactors: string[] = []
  let timingScore = 50

  if (sessionDNA?.personality) {
    timingScore += 20
    timingFactors.push(`ДНК сессии: ${sessionDNA.personalityLabel}`)
  }

  if (po3?.manipulationDetected && po3.returnIntoBox) {
    timingScore += 20
    timingFactors.push('PO3: манипуляция + возврат')
  }

  if (signal.dailyConfidence && signal.dailyConfidence >= 80) {
    timingScore += 10
    timingFactors.push(`Дневная уверенность ${signal.dailyConfidence}%`)
  }

  timingScore = Math.max(0, Math.min(timingScore, 100))

  return {
    technical: {
      score: Math.round(technicalScore),
      factors: technicalFactors,
    },
    orderFlow: {
      score: Math.round(orderFlowScore),
      factors: orderFlowFactors,
    },
    sentiment: {
      score: Math.round(sentimentScore),
      factors: sentimentFactors,
    },
    timing: {
      score: Math.round(timingScore),
      factors: timingFactors,
    },
  }
}

function buildTacticalAdvice(
  assetType: AssetType,
  signal: CoinSignal,
  memeSignal?: MemeSignal,
  marketPhase?: MarketPhase,
  dominantForce?: DominantForce,
  volatilityLevel?: VolatilityLevel,
  confluence?: ConfluenceBreakdown,
  sessionDNA?: SessionDNA | null,
  po3?: PO3Analysis | null
): TacticalAdvice {
  const advice: TacticalAdvice = {
    primary: '',
    reasoning: [],
    warnings: [],
    optimal: {
      entry: '',
      stop: '',
      targets: '',
      timeframe: '',
    },
  }

  if (assetType === 'MEME' && memeSignal) {
    if (memeSignal.recommendation === 'QUICK_ENTRY') {
      if (memeSignal.volumeSpike.detected && memeSignal.volumeSpike.priceChangePct > 0) {
        advice.primary = `БЫСТРЫЙ ЛОНГ на всплеске объёма ×${memeSignal.volumeSpike.volumeMultiplier.toFixed(1)}`
      } else if (
        memeSignal.volumeSpike.detected &&
        memeSignal.volumeSpike.priceChangePct < 0
      ) {
        advice.primary = 'БЫСТРЫЙ ШОРТ на дампе'
      } else if (memeSignal.spreadPressure.pressure === 'BUYERS') {
        advice.primary = `ЛОНГ на давлении покупателей (${memeSignal.spreadPressure.quality})`
      } else if (memeSignal.spreadPressure.pressure === 'SELLERS') {
        advice.primary = `ШОРТ на давлении продавцов (${memeSignal.spreadPressure.quality})`
      } else {
        advice.primary = `Скальп ${signal.direction === 'LONG' ? 'ЛОНГ' : signal.direction === 'SHORT' ? 'ШОРТ' : 'НЕЙТРАЛЬНО'} (нагрев ${memeSignal.heatScore}/100)`
      }
    } else if (memeSignal.recommendation === 'MONITOR') {
      advice.primary = 'Ждать более чёткого импульса / давления'
    } else {
      advice.primary = 'Без входа — недостаточный нагрев'
    }

    if (memeSignal.volumeSpike.detected) {
      advice.reasoning.push(`Всплеск объёма: ${memeSignal.volumeSpike.label}`)
    }
    if (memeSignal.liquidityGap.detected) {
      advice.reasoning.push(
        `Гэп ликвидности ${memeSignal.liquidityGap.direction}: ${memeSignal.liquidityGap.label}`
      )
    }
    if (memeSignal.spreadPressure.pressure !== 'NEUTRAL') {
      advice.reasoning.push(`Давление спреда: ${memeSignal.spreadPressure.label}`)
    }
    if (memeSignal.meanReversion.detected) {
      advice.reasoning.push(`Возврат к среднему: ${memeSignal.meanReversion.label}`)
    }

    advice.optimal.entry = 'Рыночный ордер (немедленно, не лимитки)'
    advice.optimal.stop = '0.5-1% микро-стоп (строго)'
    advice.optimal.targets = '2-5% быстрая фиксация'
    advice.optimal.timeframe = '1-5 минут (скальп)'

    advice.warnings.push('⚡ Экстремальная волатильность — разворот за секунды')
    advice.warnings.push('🚫 Без колебаний при срабатывании стопа')
    advice.warnings.push('⏰ Избегать низкой ликвидности (ночь в Азии, выходные)')
    if (memeSignal.spreadPressure.pressure !== 'NEUTRAL') {
      advice.warnings.push(
        `Следить за угасанием давления — выход при смене на ${memeSignal.spreadPressure.pressure === 'BUYERS' ? 'продавцов' : 'покупателей'}`
      )
    }
  } else if (assetType === 'ALT') {
    if (signal.hasActiveSetup && signal.score >= 7) {
      const entry = signal.ltfChoCH?.surgicalEntryDetected
        ? 'точный вход'
        : signal.ote?.priceInZone
          ? 'зона OTE'
          : 'зона confluence'
      advice.primary = `${signal.direction === 'LONG' ? 'ЛОНГ' : 'ШОРТ'} сетап на ${entry} (оценка ${signal.score}/10)`
    } else if (signal.score >= 5) {
      advice.primary = `Мониторинг подтверждения структуры (оценка ${signal.score}/10)`
    } else {
      advice.primary = 'Ждать — недостаточный confluence'
    }

    if (signal.zones.length > 0) {
      advice.reasoning.push(`Зоны confluence: ${signal.zones.slice(0, 3).join(', ')}`)
    }
    if (signal.ltfChoCH?.detected) {
      advice.reasoning.push(
        signal.ltfChoCH.surgicalEntryDetected
          ? 'LTF CHoCH + точный вход подтверждён'
          : 'LTF CHoCH обнаружен'
      )
    }
    if (signal.absorption?.detected) {
      advice.reasoning.push('Свеча поглощения — останавливающий объём')
    }
    if (confluence && confluence.technical.score >= 70) {
      advice.reasoning.push(
        `Сильный технический confluence (${confluence.technical.score}/100)`
      )
    }
    if (sessionDNA) {
      advice.reasoning.push(`ДНК сессии: ${sessionDNA.keyInsight}`)
    }

    advice.optimal.entry = signal.ltfChoCH?.surgicalEntryDetected
      ? 'Лимитный ордер на цену точного входа'
      : 'Лимитный ордер в зоне confluence'
    advice.optimal.stop = 'Структурный (за swing low/high)'
    advice.optimal.targets = 'TP1: закрыть 50% | TP2: раннер до дневного уровня'
    advice.optimal.timeframe = '4-12 часов (интрадей)'

    advice.warnings.push('⏳ Ждать подтверждения структуры — без FOMO')
    if (signal.dailyBias === 'BEARISH' && signal.direction === 'LONG') {
      advice.warnings.push('⚠️ Против дневного уклона — уменьшить размер')
    }
    if (signal.dailyBias === 'BULLISH' && signal.direction === 'SHORT') {
      advice.warnings.push('⚠️ Против дневного уклона — уменьшить размер')
    }
    if (po3?.currentPhase === 'MANIPULATION') {
      advice.warnings.push('🎯 PO3 фаза манипуляции — ожидать ложных пробоев')
    }
    if (volatilityLevel === 'LOW') {
      advice.warnings.push('📉 Низкая волатильность — цели могут достигаться дольше')
    }
  } else if (assetType === 'BLUE_CHIP') {
    if (signal.hasActiveSetup && signal.score >= 7) {
      advice.primary = `Свинг ${signal.direction === 'LONG' ? 'ЛОНГ' : 'ШОРТ'} на HTF зоне (оценка ${signal.score}/10)`
    } else {
      advice.primary = 'Ждать подтверждения HTF структуры / дневного уклона'
    }

    if (signal.dailyBias === 'BULLISH' && signal.direction === 'LONG') {
      advice.reasoning.push('Дневной уклон совпадает — БЫЧИЙ')
    } else if (signal.dailyBias === 'BEARISH' && signal.direction === 'SHORT') {
      advice.reasoning.push('Дневной уклон совпадает — МЕДВЕЖИЙ')
    }
    if (signal.btcTrend === signal.coinTrend) {
      advice.reasoning.push('Корреляция с BTC совпадает')
    }
    if (po3?.asiaBox) {
      advice.reasoning.push(`PO3: ${po3.currentPhase} · ${po3.tradingAdvice}`)
    }
    if (confluence && confluence.timing.score >= 70) {
      advice.reasoning.push(`Тайминг confluence ${confluence.timing.score}/100`)
    }

    advice.optimal.entry = 'Лимит на HTF зоне (daily OB/FVG)'
    advice.optimal.stop = 'За дневными уровнями (PDH/PDL)'
    advice.optimal.targets = 'Свинг-цели (недельные уровни, пулы ликвидности)'
    advice.optimal.timeframe = '1-3 дня (свинг)'

    advice.warnings.push('📅 Учитывать макро-календарь (NFP, FOMC, CPI)')
    advice.warnings.push('🐋 Следить за активностью китов на уровнях входа')
    if (dominantForce === 'NEUTRAL') {
      advice.warnings.push('⚖️ Нейтральный поток ордеров — ждать направленного давления')
    }
    if (marketPhase === 'RANGING') {
      advice.warnings.push('📊 Боковой рынок — уже стопы, меньше цели')
    }
  }

  return advice
}

function getExpectedMoveRange(
  assetType: AssetType,
  volatilityLevel: VolatilityLevel
): string {
  if (assetType === 'MEME') {
    switch (volatilityLevel) {
      case 'EXTREME':
        return '5-20% за 1-5 минут'
      case 'HIGH':
        return '3-10% за 5-15 минут'
      case 'MEDIUM':
        return '2-5% за 15-30 минут'
      default:
        return '1-3% за 30-60 минут'
    }
  }

  if (assetType === 'ALT') {
    switch (volatilityLevel) {
      case 'EXTREME':
        return '8-15% за 2-6 часов'
      case 'HIGH':
        return '5-10% за 4-12 часов'
      case 'MEDIUM':
        return '3-6% за 6-24 часа'
      default:
        return '1-3% за 12-48 часов'
    }
  }

  switch (volatilityLevel) {
    case 'EXTREME':
      return '5-10% за 1-3 дня'
    case 'HIGH':
      return '3-7% за 2-5 дней'
    case 'MEDIUM':
      return '2-4% за 3-7 дней'
    default:
      return '1-2% за 5-10 дней'
  }
}
