/**
 * VANE MICRO — high-WR micro-scalp for large notional / small % moves.
 *
 * Thesis (MEXC maker ≈ free):
 *   TP 0.45–0.70% · SL ≤0.45% · need WR ≥65% to compound safely.
 *
 * Edge sources (journal + causality):
 *   1. WITH HTF only — never counter / flip for MICRO
 *   2. Enter AFTER impulse start (0.35–0.85%/3m), not before and not late chase
 *   3. Only at TOUCH / tight APPROACH of HTF zone + supportive book
 *   4. Early BE + partial TP1 — protect R so one LOSS ≠ three WINs
 *
 * Non-goals: meme impulse, FAR wait sizing, S/R flip, wide 1.5%+ TP.
 */

import type { Side, ZoneGrade } from './types'

export const MICRO_MIN_SCORE = 58
export const MICRO_MIN_RR = 1.15
/** Equity risk per MICRO trade — size comes from this, not from “big depo feeling” */
export const MICRO_RISK_PCT = 0.35
export const MICRO_TP_MIN_PCT = 0.45
export const MICRO_TP_MAX_PCT = 0.7
export const MICRO_SL_MIN_PCT = 0.32
export const MICRO_SL_MAX_PCT = 0.45
export const MICRO_TP1_PCT = 0.4
/** Impulse band: started, not exhausted */
export const MICRO_IMPULSE_MIN = 0.35
export const MICRO_IMPULSE_MAX = 0.85
/** BE / trail — paper layer */
export const MICRO_BE_MFE_PCT = 0.28
export const MICRO_BE_R = 0.35
export const MICRO_TRAIL_PCT = 0.0035
export const MICRO_TRAIL_AFTER_TP1 = 0.0028

export interface MicroQualifyInput {
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
  /** Last 1m candle body in trade direction (close vs open) */
  candle1mWithUs: boolean
  directionConfidence: number
}

export interface MicroQualifyResult {
  ok: boolean
  reason: string
  tags: string[]
}

/**
 * Strict gate — fail closed. Only emit VANE_MICRO_* when ok.
 */
export function qualifyMicro(input: MicroQualifyInput): MicroQualifyResult {
  const tags: string[] = []

  if (input.phase === 'FAR') {
    return { ok: false, reason: 'far_zone', tags }
  }
  if (input.phase === 'APPROACH') {
    // Only very tight approach — otherwise WAIT, not MICRO size
    tags.push('APPROACH')
  } else {
    tags.push('TOUCH')
  }

  if (!input.aligns || input.conflicts) {
    return { ok: false, reason: 'htf_not_with', tags }
  }
  if (input.directionConfidence < 48) {
    return { ok: false, reason: 'dir_conf_low', tags }
  }
  if (input.zoneStrength < 5) {
    return { ok: false, reason: 'zone_weak', tags }
  }
  if (input.greenDeltaWeak) {
    return { ok: false, reason: 'tape_against', tags }
  }
  if (input.bookGrade === 'WEAK') {
    return { ok: false, reason: 'book_weak', tags }
  }

  const bookOk =
    input.bookGrade === 'STRONG' ||
    input.absorption ||
    input.cvdConfirm
  if (!bookOk) {
    return { ok: false, reason: 'no_book_confirm', tags }
  }
  if (input.bookGrade === 'STRONG') tags.push('BOOK_STRONG')
  if (input.absorption) tags.push('ABS')
  if (input.cvdConfirm) tags.push('CVD')

  if (
    input.earlyFavorPct < MICRO_IMPULSE_MIN ||
    input.earlyFavorPct > MICRO_IMPULSE_MAX
  ) {
    return {
      ok: false,
      reason:
        input.earlyFavorPct < MICRO_IMPULSE_MIN
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

  if (input.zoneTouches >= 2) tags.push('MULTI_TOUCH')

  return { ok: true, reason: 'micro_ok', tags }
}

export function isMicroSetup(setup: string | null | undefined): boolean {
  return Boolean(setup && setup.startsWith('VANE_MICRO_'))
}

export function candle1mWithSide(
  candles1m: Array<[number, number, number, number, number, number]>,
  side: Side
): boolean {
  if (candles1m.length < 2) return false
  // Prefer last closed bar ([-2]); fallback last
  const bar = candles1m[candles1m.length - 2] ?? candles1m[candles1m.length - 1]!
  const open = bar[1]
  const close = bar[4]
  if (!(open > 0) || !(close > 0)) return false
  return side === 'LONG' ? close >= open : close <= open
}
