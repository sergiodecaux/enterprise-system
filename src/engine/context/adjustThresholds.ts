import type {
  ContextThresholds,
  CrowdContext,
  FullMarketContext,
  WhaleContext,
} from './types'

export const BASE_THRESHOLDS: ContextThresholds = {
  requiredConfirmation: 'SOFT',
  reversalBias: 0,
  continuationBias: 0,
  minZoneStrength: 50,
}

/**
 * Context shifts caution and reversal/continuation weight.
 * It does not pick a side by itself.
 */
export function adjustThresholds(
  base: ContextThresholds,
  parts: {
    session: FullMarketContext['session']
    htf: FullMarketContext['htf']
    crowd: CrowdContext
    whales: WhaleContext
  }
): { thresholds: ContextThresholds; notes: string[] } {
  const t: ContextThresholds = { ...base }
  const notes: string[] = []
  const { session, htf, crowd, whales } = parts

  if (session.session === 'LOW_LIQUIDITY') {
    t.requiredConfirmation = 'HARD'
    notes.push('тонкая сессия — подтверждение жёсткое')
  }
  if (session.dayType === 'WEEKEND') {
    t.minZoneStrength += 10
    t.continuationBias -= 6
    notes.push('выходные — зона должна быть сильнее')
  }
  if (session.isFridayClose || session.isMondayOpen) {
    t.requiredConfirmation = 'HARD'
    notes.push(session.isFridayClose ? 'закрытие пятницы' : 'открытие понедельника')
  }
  if (session.isQuarterEnd) {
    t.minZoneStrength += 8
    notes.push('конец квартала')
  } else if (session.isMonthEnd) {
    t.minZoneStrength += 4
    notes.push('конец месяца')
  }

  if (crowd.known && crowd.longShortRatio > 2 && crowd.fundingTrend === 'RISING') {
    t.reversalBias += 15
    t.requiredConfirmation = 'HARD'
    notes.push('толпа в лонге и funding растёт — контр-сценарий легче')
  } else if (
    crowd.known &&
    crowd.longShortRatio > 0 &&
    crowd.longShortRatio < 0.5 &&
    crowd.fundingTrend === 'FALLING'
  ) {
    t.reversalBias += 15
    t.requiredConfirmation = 'HARD'
    notes.push('толпа в шорте и funding падает — контр-сценарий легче')
  }

  if (whales.hunt && whales.nearCluster) {
    t.reversalBias += 10
    notes.push('киты охотятся у кластера — сильнее разворот после свипа')
  }
  if (
    htf &&
    ((whales.drive === 'UP' && htf.dailyClose.bias === 'BULL') ||
      (whales.drive === 'DOWN' && htf.dailyClose.bias === 'BEAR'))
  ) {
    t.continuationBias += 10
    notes.push('drive китов совпал с закрытием дня')
  }

  if (htf?.closedNearHighOrLow === 'HIGH' && htf.dailyClose.bias === 'BULL') {
    t.continuationBias += 4
  }
  if (htf?.closedNearHighOrLow === 'LOW' && htf.dailyClose.bias === 'BEAR') {
    t.continuationBias += 4
  }

  return { thresholds: t, notes }
}
