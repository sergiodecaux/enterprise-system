/**
 * Per-asset playbook: what to prioritize for BTC / ALT / MEME.
 */

import type { CoinSignal } from '../types'
import type { AssetType } from '../composite/assetClassifier'
import { classifyAsset, getAssetBase } from '../composite/assetClassifier'
import { classifySmcSetup, SETUP_LABELS } from '../journal/classify'

export interface PlaybookInfo {
  assetType: AssetType
  setupLabel: string
  setupTag: string
  tradeStyle: string | null
  focus: string[]
  avoid: string[]
  headline: string
}

export function buildPlaybook(signal: CoinSignal): PlaybookInfo {
  const assetType = classifyAsset(
    signal.internalSymbol,
    signal.priceChange24h,
    signal.memePulse?.spreadPressure,
    { hasMemePulse: !!signal.memePulse }
  )
  const { setupType, setupTag } = classifySmcSetup(signal)
  const style = signal.tradeStyle ?? null

  if (assetType === 'COMMODITY') {
    return {
      assetType,
      setupLabel: SETUP_LABELS[setupType],
      setupTag,
      tradeStyle: style,
      headline: 'Сырьё · принятие стоимости, не охота за фитилём',
      focus: [
        'Неделя и день задают край',
        '4ч — место в ноге, 15м — закреп',
        'Стоп от ATR дня, не от 1% за зону',
      ],
      avoid: [
        'Читать фитиль как снятие ликвидности',
        'Тащить на золото, серебро и нефть логику BTC.D',
      ],
    }
  }

  if (assetType === 'MEME') {
    return {
      assetType,
      setupLabel: SETUP_LABELS[setupType],
      setupTag,
      tradeStyle: style,
      headline: 'Meme playbook · стакан и лента важнее Fib',
      focus: [
        'Thin book / spread / OBI',
        'Absorption / CVD trap / squeeze',
        'Не догонять mid-impulse',
      ],
      avoid: [
        'Слепой лонг на широком спреде',
        'Игнор BTC dump на альтах-мемах',
      ],
    }
  }

  const base = getAssetBase(signal.internalSymbol)
  if (base === 'BTC' || base === 'XBT') {
    return {
      assetType,
      setupLabel: SETUP_LABELS[setupType],
      setupTag,
      tradeStyle: style,
      headline: 'Биткоин · неделя называет пул, 15м подтверждает возврат',
      focus: [
        'Неделя и день задают сторону и неснятый пул',
        '4ч — место в ноге, 15м — закреп или возврат после снятия',
        'Открытый интерес подтверждает охоту, не заменяет уровень',
      ],
      avoid: [
        'Переворачивать день одной 15м',
        'Лонг в премиуме ноги без возврата в дисконт',
      ],
    }
  }

  if (assetType === 'BLUE_CHIP') {
    return {
      assetType,
      setupLabel: SETUP_LABELS[setupType],
      setupTag,
      tradeStyle: style,
      headline: 'Крупная крипта · сторона биткоина, потом свой пул',
      focus: [
        'Неделя и день задают сторону, 4ч — место в ноге',
        '15м входит только закрепом или возвратом после снятия',
        'Середина диапазона не вход. BTC.D — топливо, не уровень',
      ],
      avoid: [
        'Лонг против медвежьего дня биткоина',
        'Читать фитиль как готовый сетап',
      ],
    }
  }

  return {
    assetType,
    setupLabel: SETUP_LABELS[setupType],
    setupTag,
    tradeStyle: style,
    headline: 'Альт · свой каскад только если биткоин его пускает',
    focus: [
      'Сначала сторона биткоина, потом свой неснятый пул',
      'Вход из дисконта или премиума ноги, не из середины',
      'BTC.D и TOTAL3 говорят, есть ли топливо, и не заменяют уровень',
    ],
    avoid: [
      'Лонг слабого альта при медвежьем дне биткоина',
      'Переворот направления по 15м против недели и дня',
    ],
  }
}
