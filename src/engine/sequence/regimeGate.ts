import type { MarketRegime } from '../regime/marketRegime'
import type { SequenceKind } from './types'

/**
 * Regime is the first frame: which sequences are allowed to fire as primary.
 */
export function isSequenceAllowedInRegime(
  kind: SequenceKind,
  regime: MarketRegime
): boolean {
  if (kind === 'WALL_ABSORPTION_EXHAUSTION') {
    if (regime === 'VOLATILE_CHOP') return false
    if (regime === 'TRENDING_STRONG') return false
    return true // RANGING, TRENDING_WEAK
  }
  if (kind === 'CVD_DIVERGENCE_LIMIT') {
    // Mean-revert / exhaustion — weak in strong trend
    if (regime === 'TRENDING_STRONG') return false
    if (regime === 'VOLATILE_CHOP') return false
    return true
  }
  if (kind === 'WALL_RELEASE') {
    // Breakout — works in trend; risky in chop
    if (regime === 'VOLATILE_CHOP') return false
    return true
  }
  if (kind === 'OI_DELTA_CONFIRM') {
    if (regime === 'VOLATILE_CHOP') return false
    if (regime === 'RANGING') return false // continuation needs trend
    return true
  }
  return false
}

export function regimeConfidenceMul(
  kind: SequenceKind,
  regime: MarketRegime
): number {
  if (!isSequenceAllowedInRegime(kind, regime)) return 0.35
  if (kind === 'WALL_ABSORPTION_EXHAUSTION') {
    if (regime === 'RANGING') return 1
    if (regime === 'TRENDING_WEAK') return 0.85
  }
  if (kind === 'CVD_DIVERGENCE_LIMIT') {
    if (regime === 'RANGING') return 1
    if (regime === 'TRENDING_WEAK') return 0.9
  }
  if (kind === 'WALL_RELEASE') {
    if (regime === 'TRENDING_STRONG') return 1
    if (regime === 'TRENDING_WEAK') return 0.92
    if (regime === 'RANGING') return 0.75
  }
  if (kind === 'OI_DELTA_CONFIRM') {
    if (regime === 'TRENDING_STRONG') return 1
    if (regime === 'TRENDING_WEAK') return 0.9
  }
  return 0.7
}

/**
 * Filter live setups by regime — trend algos off in chop, fade algos off in strong trend.
 */
export function setupFitsRegime(
  kind: 'BOUNCE' | 'BREAK' | 'CONTINUATION' | 'REVERSAL' | 'WAIT',
  regime: MarketRegime
): boolean {
  if (kind === 'WAIT') return true
  if (regime === 'VOLATILE_CHOP') {
    return kind === 'BOUNCE'
  }
  if (regime === 'TRENDING_STRONG') {
    return kind === 'CONTINUATION' || kind === 'BREAK' || kind === 'BOUNCE'
  }
  if (regime === 'RANGING') {
    return kind === 'BOUNCE' || kind === 'REVERSAL' || kind === 'BREAK'
  }
  return true
}
