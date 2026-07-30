/**
 * Per-asset playbook: what to prioritize for BTC / ALT / MEME.
 */

import type { CoinSignal } from '../types'
import type { AssetType } from '../composite/assetClassifier'
import { classifyAsset } from '../composite/assetClassifier'
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

  if (assetType === 'BLUE_CHIP') {
    return {
      assetType,
      setupLabel: SETUP_LABELS[setupType],
      setupTag,
      tradeStyle: style,
      headline: 'Blue-chip · сессии, F&G, HTF зоны',
      focus: [
        'Daily / 4H структура и OTE',
        'Сессия (London/NY) + F&G',
        'BTC.D при смежных альтах в портфеле',
      ],
      avoid: [
        'Скальп против сильного HTF',
        'Вход без зоны на новостном шуме',
      ],
    }
  }

  return {
    assetType,
    setupLabel: SETUP_LABELS[setupType],
    setupTag,
    tradeStyle: style,
    headline: 'Alt playbook · зоны + RS vs BTC',
    focus: [
      'SSL/BSL / Fib реакция',
      'RS vs BTC (не лонг слабого альта)',
      'BTC.D ≥55% → резать размер LONG',
    ],
    avoid: [
      'Лонг при медвежьем BTC без дивергенции',
      'Игнор invalidation 1H',
    ],
  }
}
