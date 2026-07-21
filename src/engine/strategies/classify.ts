import type { CoinSignal } from '../types'
import type { StyleClassification, TradeStyle } from './types'
import { SCALP_PROFILE } from './scalp'
import { INTRADAY_PROFILE, isKillzoneActive } from './intraday'

/**
 * Классифицирует сетап как SCALP или INTRADAY по доминирующим триггерам.
 * Скальп: свежий sweep + tape/absorption + микро-структура.
 * Интрадей: HTF bias + killzone + OB/OTE.
 */
export function classifyTradeStyle(signal: CoinSignal): StyleClassification {
  let scalpPts = 0
  let intraPts = 0
  const reasons: string[] = []

  const freshRaid =
    signal.raid != null && signal.raid.type !== 'NONE' && signal.raid.isFresh
  if (freshRaid) {
    scalpPts += 3
    reasons.push('Fresh liquidity sweep → SCALP')
  }

  if (signal.absorption?.detected) {
    scalpPts += 2
    reasons.push('Absorption → SCALP')
  }

  if (signal.buyerAggression?.detected) {
    scalpPts += 2
    reasons.push('Tape aggression → SCALP')
  }

  if (signal.ltfChoCH?.detected && signal.ltfChoCH.candlesAgo <= 5) {
    scalpPts += 1
    intraPts += 1
  }

  if (signal.liquidationContext?.swept && signal.liquidationContext.fresh) {
    scalpPts += 2
    intraPts += 1
    reasons.push('Liq cluster swept')
  }

  const dailyAligned =
    (signal.direction === 'LONG' && signal.dailyBias === 'BULLISH') ||
    (signal.direction === 'SHORT' && signal.dailyBias === 'BEARISH')
  if (dailyAligned) {
    intraPts += 3
    reasons.push('Daily bias aligned → INTRADAY')
  }

  if (
    (signal.direction === 'LONG' && signal.coinTrend === 'BULLISH') ||
    (signal.direction === 'SHORT' && signal.coinTrend === 'BEARISH')
  ) {
    intraPts += 2
    reasons.push('HTF trend aligned → INTRADAY')
  }

  if (signal.ote?.priceInZone) {
    intraPts += 2
    reasons.push('Price in OTE → INTRADAY')
  }

  const hasObZone = signal.zones.some(
    (z) => z.includes('OB') || z.includes('ORDER_BLOCK')
  )
  if (hasObZone) {
    intraPts += 1
  }

  if (signal.volumeProfile?.obPocConfluence) {
    intraPts += 2
    reasons.push('OB ∩ POC confluence → INTRADAY')
  }

  const kz = isKillzoneActive()
  if (kz.active) {
    intraPts += 1
    reasons.push(`Killzone: ${kz.label}`)
  }

  // Микро-стоп → скальп
  if (signal.sl != null && signal.price > 0) {
    const stopPct = (Math.abs(signal.price - signal.sl) / signal.price) * 100
    if (stopPct <= 0.9) {
      scalpPts += 2
      reasons.push(`Micro SL ${stopPct.toFixed(2)}% → SCALP`)
    } else if (stopPct >= 1.2) {
      intraPts += 1
      reasons.push(`Structural SL ${stopPct.toFixed(2)}% → INTRADAY`)
    }
  }

  const style: TradeStyle =
    scalpPts > intraPts ? 'SCALP' : scalpPts < intraPts ? 'INTRADAY' : 'INTRADAY'

  const total = scalpPts + intraPts || 1
  const confidence = Math.round(
    (Math.max(scalpPts, intraPts) / total) * 100
  )

  if (reasons.length === 0) {
    reasons.push(
      style === 'SCALP'
        ? 'Default scalp profile (order-flow weighted)'
        : 'Default intraday profile (structure weighted)'
    )
  }

  return { style, confidence, reasons }
}

export function getStyleProfile(style: TradeStyle) {
  return style === 'SCALP' ? SCALP_PROFILE : INTRADAY_PROFILE
}
