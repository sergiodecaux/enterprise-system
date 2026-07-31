/**
 * VANE MACRO — catch real directional moves (1.5–3.8%), not zone-wait noise.
 *
 * Thesis:
 *   Enter WITH HTF when impulse has started at a strong zone.
 *   Target the body of the move (ATR-scaled 1.5–3.8%), not 0.5% chips.
 *   Silence FAR/WAIT emits — only actionable MACRO (or rare MICRO).
 *
 * Speed: qualify after HTF bias + 1m impulse; fail closed on FLAT / weak book.
 */

import type { Side, ZoneGrade } from './types'

export const MACRO_MIN_SCORE = 62
export const MACRO_MIN_RR = 1.55
export const MACRO_RISK_PCT = 0.85
export const MACRO_TP_MIN_PCT = 1.5
export const MACRO_TP_MAX_PCT = 3.8
export const MACRO_SL_MIN_PCT = 0.65
export const MACRO_SL_MAX_PCT = 1.15
export const MACRO_TP1_PCT = 0.9
/** Impulse started (3m) — not late chase */
export const MACRO_IMPULSE_MIN = 0.55
export const MACRO_IMPULSE_MAX = 2.2
export const MACRO_DIR_CONF_MIN = 55
export const MACRO_ZONE_STRENGTH = 6
/** BE / trail — paper */
export const MACRO_BE_MFE_PCT = 0.55
export const MACRO_BE_R = 0.45
export const MACRO_TRAIL_PCT = 0.008
export const MACRO_TRAIL_AFTER_TP1 = 0.0055

export interface MacroQualifyInput {
  phase: 'FAR' | 'APPROACH' | 'TOUCH'
  earlyFavorPct: number
  bookGrade: ZoneGrade
  absorption: boolean
  cvdConfirm: boolean
  greenDeltaWeak: boolean
  aligns: boolean
  conflicts: boolean
  zoneStrength: number
  zoneTouches: number
  candle1mWithUs: boolean
  directionConfidence: number
  /** Prefer HTF SSL/BSL over 15m internals */
  isInternal: boolean
  /** |24h %| — real movers preferred */
  chg24Abs: number
}

export interface MacroQualifyResult {
  ok: boolean
  reason: string
  tags: string[]
}

/**
 * Strict MACRO gate — fail closed. Only emit VANE_MACRO_* when ok.
 */
export function qualifyMacro(input: MacroQualifyInput): MacroQualifyResult {
  const tags: string[] = []

  if (input.phase === 'FAR') {
    return { ok: false, reason: 'far_zone', tags }
  }
  tags.push(input.phase)

  if (!input.aligns || input.conflicts) {
    return { ok: false, reason: 'htf_not_with', tags }
  }
  if (input.directionConfidence < MACRO_DIR_CONF_MIN) {
    return { ok: false, reason: 'dir_conf_low', tags }
  }
  if (input.zoneStrength < MACRO_ZONE_STRENGTH) {
    return { ok: false, reason: 'zone_weak', tags }
  }
  if (input.isInternal && input.zoneStrength < MACRO_ZONE_STRENGTH + 1) {
    return { ok: false, reason: 'internal_weak', tags }
  }
  if (input.greenDeltaWeak) {
    return { ok: false, reason: 'tape_against', tags }
  }
  if (input.bookGrade === 'WEAK') {
    return { ok: false, reason: 'book_weak', tags }
  }

  const bookOk =
    input.bookGrade === 'STRONG' ||
    (input.absorption && input.cvdConfirm) ||
    (input.bookGrade === 'NEUTRAL' &&
      input.absorption &&
      input.phase === 'TOUCH')
  if (!bookOk) {
    return { ok: false, reason: 'no_book_confirm', tags }
  }
  if (input.bookGrade === 'STRONG') tags.push('BOOK_STRONG')
  if (input.absorption) tags.push('ABS')
  if (input.cvdConfirm) tags.push('CVD')

  if (
    input.earlyFavorPct < MACRO_IMPULSE_MIN ||
    input.earlyFavorPct > MACRO_IMPULSE_MAX
  ) {
    return {
      ok: false,
      reason:
        input.earlyFavorPct < MACRO_IMPULSE_MIN
          ? 'impulse_too_early'
          : 'impulse_extended',
      tags,
    }
  }
  tags.push(`IMP+${input.earlyFavorPct.toFixed(2)}`)

  if (!input.candle1mWithUs) {
    return { ok: false, reason: '1m_against', tags }
  }
  tags.push('1M_WITH')

  if (input.chg24Abs >= 3) tags.push('HOT24')
  if (input.zoneTouches >= 2) tags.push('MULTI_TOUCH')
  if (!input.isInternal) tags.push('HTF_ZONE')

  return { ok: true, reason: 'macro_ok', tags }
}

export function isMacroSetup(setup: string | null | undefined): boolean {
  return Boolean(setup && setup.startsWith('VANE_MACRO_'))
}
