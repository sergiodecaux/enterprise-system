import type { LiquidityMap, SessionDNA } from '../types'
import type { TradeSide } from '../smc'
import { getSessionAtHour } from './sessionMap'
import type { SessionName } from './types'
import type { MmIntentResult } from '../mm/mmIntent'

export interface SessionFlipResult {
  /** Reordered sides to try first */
  tryOrder: TradeSide[]
  longAllowedExtra: boolean
  shortAllowedExtra: boolean
  reason: string
  session: SessionName
  flipped: boolean
}

/**
 * Сессии часто разворачивают локальный поток против дневного bias:
 * Asia range → London raid → NY continuation/reversal.
 * Даже при HTF вверх в NY/Overlap часто лучший сетап — SHORT в BSL.
 */
export function resolveSessionFlip(params: {
  dailyLongOk: boolean
  dailyShortOk: boolean
  coinTrend: 'BULLISH' | 'BEARISH' | 'RANGING' | null
  liquidityMap?: LiquidityMap | null
  sessionDna?: SessionDNA | null
  mmIntent?: MmIntentResult | null
  utcHour?: number
}): SessionFlipResult {
  const hour = params.utcHour ?? new Date().getUTCHours()
  const session = getSessionAtHour(hour)
  const bsl = params.liquidityMap?.nearestBSL
  const ssl = params.liquidityMap?.nearestSSL
  const dna = params.sessionDna
  const mm = params.mmIntent

  let tryOrder: TradeSide[] = ['LONG', 'SHORT']
  let longAllowedExtra = false
  let shortAllowedExtra = false
  let reason = ''
  let flipped = false

  const personality = dna?.personality ?? 'UNKNOWN'
  const dominant = dna?.dominantSession

  // Default: prefer MM preferred side / nearer liquidity hunt
  if (mm?.preferredSide === 'SHORT') {
    tryOrder = ['SHORT', 'LONG']
    reason = `MM intent: ${mm.label}`
  } else if (mm?.preferredSide === 'LONG') {
    tryOrder = ['LONG', 'SHORT']
    reason = `MM intent: ${mm.label}`
  }

  // London / Overlap: often raid opposite of Asia range
  if (session === 'LONDON' || session === 'OVERLAP') {
    if (bsl?.isActive && bsl.distancePct < 1.2 && (params.coinTrend === 'BULLISH' || params.dailyLongOk)) {
      // Price looking up into BSL — best tactical is often SHORT into liquidity
      tryOrder = ['SHORT', 'LONG']
      shortAllowedExtra = true
      flipped = true
      reason = `${session}: цена смотрит в BSL (+${bsl.distancePct.toFixed(2)}%) — приоритет SHORT (охота стопов)`
    } else if (ssl?.isActive && ssl.distancePct < 1.2 && (params.coinTrend === 'BEARISH' || params.dailyShortOk)) {
      tryOrder = ['LONG', 'SHORT']
      longAllowedExtra = true
      flipped = true
      reason = `${session}: цена смотрит в SSL (−${ssl.distancePct.toFixed(2)}%) — приоритет LONG`
    }
  }

  // New York: reversals / continuation — DNA personality matters
  if (session === 'NEW_YORK') {
    if (personality === 'NY_REVERSAL' || dominant === 'NEW_YORK') {
      if (params.coinTrend === 'BULLISH' || params.dailyLongOk) {
        tryOrder = ['SHORT', 'LONG']
        shortAllowedExtra = true
        flipped = true
        reason = `NY DNA (${personality}): разворотный характер — ищем SHORT`
      } else if (params.coinTrend === 'BEARISH' || params.dailyShortOk) {
        tryOrder = ['LONG', 'SHORT']
        longAllowedExtra = true
        flipped = true
        reason = `NY DNA (${personality}): разворотный характер — ищем LONG`
      }
    }
    if (
      mm?.preferredSide === 'SHORT' &&
      bsl?.isActive &&
      bsl.distancePct < 1.5
    ) {
      tryOrder = ['SHORT', 'LONG']
      shortAllowedExtra = true
      flipped = true
      reason = `NY + MM hunt: sweep BSL → SHORT к SSL`
    }
  }

  // Asia: mean-reversion / range edges
  if (session === 'ASIA') {
    if (bsl?.isActive && bsl.distancePct < 0.8) {
      tryOrder = ['SHORT', 'LONG']
      shortAllowedExtra = true
      reason = reason || 'Asia: у верхней границы range → SHORT'
    } else if (ssl?.isActive && ssl.distancePct < 0.8) {
      tryOrder = ['LONG', 'SHORT']
      longAllowedExtra = true
      reason = reason || 'Asia: у нижней границы range → LONG'
    }
  }

  return {
    tryOrder,
    longAllowedExtra,
    shortAllowedExtra,
    reason,
    session,
    flipped,
  }
}
