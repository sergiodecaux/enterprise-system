import type { CoinSignal } from '../types'
import type { StyleClassification, TradeStyle } from './types'
import { SCALP_PROFILE } from './scalp'
import { INTRADAY_PROFILE, isKillzoneActive } from './intraday'
import { SWING_PROFILE } from './swing'

/**
 * Классифицирует сетап как SCALP / INTRADAY / SWING по доминирующим триггерам.
 * Скальп: свежий sweep + tape/absorption + микро-структура.
 * Интрадей: HTF bias + killzone + OB/OTE.
 * Свинг: daily/global Fib 141 + структурный стоп + HTF alignment.
 */
export function classifyTradeStyle(signal: CoinSignal): StyleClassification {
  let scalpPts = 0
  let intraPts = 0
  let swingPts = 0
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
    swingPts += 2
    reasons.push('Daily bias aligned → INTRADAY/SWING')
  }

  if (
    (signal.direction === 'LONG' && signal.coinTrend === 'BULLISH') ||
    (signal.direction === 'SHORT' && signal.coinTrend === 'BEARISH')
  ) {
    intraPts += 2
    swingPts += 2
    reasons.push('HTF trend aligned')
  }

  if (signal.ote?.priceInZone) {
    intraPts += 2
    swingPts += 1
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

  // Global Fib 141 / reaction → SWING magnet
  const fib = signal.globalFib
  if (fib?.entryBias === signal.direction) {
    if (fib.in141 || fib.near141 || fib.inReactionZone) {
      swingPts += 4
      reasons.push(`Fib 141 зона → SWING ${fib.entryBias}`)
    } else if (fib.price141 != null) {
      swingPts += 1
      reasons.push(`Fib 141 watch @ ${fib.price141.toPrecision(5)}`)
    }
  }

  // Микро-стоп → скальп; широкий → свинг
  if (signal.sl != null && signal.price > 0) {
    const stopPct = (Math.abs(signal.price - signal.sl) / signal.price) * 100
    if (stopPct <= 0.9) {
      scalpPts += 2
      reasons.push(`Micro SL ${stopPct.toFixed(2)}% → SCALP`)
    } else if (stopPct >= 2.5) {
      swingPts += 2
      reasons.push(`Wide SL ${stopPct.toFixed(2)}% → SWING`)
    } else if (stopPct >= 1.2) {
      intraPts += 1
      reasons.push(`Structural SL ${stopPct.toFixed(2)}% → INTRADAY`)
    }
  }

  const ranked: Array<{ style: TradeStyle; pts: number }> = [
    { style: 'SCALP' as const, pts: scalpPts },
    { style: 'INTRADAY' as const, pts: intraPts },
    { style: 'SWING' as const, pts: swingPts },
  ].sort((a, b) => b.pts - a.pts)

  const style: TradeStyle =
    ranked[0].pts > 0 ? ranked[0].style : 'INTRADAY'

  const total = scalpPts + intraPts + swingPts || 1
  const confidence = Math.round((Math.max(scalpPts, intraPts, swingPts) / total) * 100)

  if (reasons.length === 0) {
    reasons.push(
      style === 'SCALP'
        ? 'Default scalp profile (order-flow weighted)'
        : style === 'SWING'
          ? 'Default swing profile (HTF structure)'
          : 'Default intraday profile (structure weighted)'
    )
  }

  return { style, confidence, reasons }
}

export function getStyleProfile(style: TradeStyle) {
  if (style === 'SCALP') return SCALP_PROFILE
  if (style === 'SWING') return SWING_PROFILE
  return INTRADAY_PROFILE
}
