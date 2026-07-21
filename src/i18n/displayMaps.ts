import type {
  AssetType,
  MarketPhase,
  DominantForce,
  VolatilityLevel,
} from '../engine/composite'

export const assetTypeLabel: Record<AssetType, string> = {
  MEME: 'МЕМ',
  ALT: 'АЛЬТ',
  BLUE_CHIP: 'БЛЮ-ЧИП',
}

export const marketPhaseLabel: Record<MarketPhase, string> = {
  ACCUMULATION: 'Накопление',
  DISTRIBUTION: 'Распределение',
  UPTREND: 'Восходящий тренд',
  DOWNTREND: 'Нисходящий тренд',
  RANGING: 'Боковик',
}

export const dominantForceLabel: Record<DominantForce, string> = {
  STRONG_BUYERS: 'Сильные покупатели',
  BUYERS: 'Покупатели',
  NEUTRAL: 'Нейтрально',
  SELLERS: 'Продавцы',
  STRONG_SELLERS: 'Сильные продавцы',
}

export const volatilityLevelLabel: Record<VolatilityLevel, string> = {
  LOW: 'Низкая',
  MEDIUM: 'Средняя',
  HIGH: 'Высокая',
  EXTREME: 'Экстремальная',
}

export const confluenceCategoryLabel: Record<string, string> = {
  technical: 'Техника',
  orderFlow: 'Поток ордеров',
  sentiment: 'Настроение',
  timing: 'Тайминг',
}

export const spreadQualityLabel: Record<string, string> = {
  EXTREME: 'ЭКСТРЕМ',
  STRONG: 'СИЛЬНО',
  MODERATE: 'УМЕРЕННО',
  WEAK: 'СЛАБО',
}

export const confidenceQualityLabel: Record<string, string> = {
  ELITE: 'ЭЛИТА',
  STRONG: 'СИЛЬНЫЙ',
  WEAK: 'СЛАБЫЙ',
}

export const directionLabel = (dir: 'LONG' | 'SHORT' | null | undefined): string => {
  if (dir === 'LONG') return 'ЛОНГ'
  if (dir === 'SHORT') return 'ШОРТ'
  return '—'
}

export const gapDirectionLabel: Record<string, string> = {
  UP: 'ВВЕРХ',
  DOWN: 'ВНИЗ',
  NEUTRAL: '—',
}
