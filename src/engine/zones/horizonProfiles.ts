/**
 * SCALP / INTRA / SWING profiles for chart zone & probable-trade discovery.
 */

import type { SetupTradeStyle } from '../setups/types'
import type { ForecastHorizon } from '../prediction/macroOutlook'

export interface HorizonProfile {
  style: SetupTradeStyle
  tag: '#SCALP' | '#INTRA' | '#SWING'
  label: string
  /** Max |distancePct| of zone from price */
  maxDistPct: number
  /** Prefer zones at least this far (SWING skips micro noise) */
  minDistPct: number
  /** Widen invalidation slightly for higher TF */
  riskPad: number
  /** Multiply structural target distance */
  tpMult: number
  /** Path time scale vs base bounce path */
  pathScale: number
  /** Win% nudge (HTF needs more confluence but higher R) */
  winAdj: number
  /** Ladder R multiples hint */
  rMultiples: [number, number, number]
}

export const HORIZON_PROFILES: Record<SetupTradeStyle, HorizonProfile> = {
  SCALP: {
    style: 'SCALP',
    tag: '#SCALP',
    label: 'Скальп',
    maxDistPct: 1.8,
    minDistPct: 0,
    riskPad: 1,
    tpMult: 1,
    pathScale: 0.55,
    winAdj: 0,
    rMultiples: [1, 1.6, 2.2],
  },
  INTRADAY: {
    style: 'INTRADAY',
    tag: '#INTRA',
    label: 'Интрадей',
    maxDistPct: 4.2,
    minDistPct: 0.15,
    riskPad: 1.12,
    tpMult: 1.45,
    pathScale: 1.6,
    winAdj: 2,
    rMultiples: [1.2, 2.2, 3.2],
  },
  SWING: {
    style: 'SWING',
    tag: '#SWING',
    label: 'Свинг',
    maxDistPct: 10,
    minDistPct: 0.6,
    riskPad: 1.35,
    tpMult: 2.1,
    pathScale: 3.5,
    winAdj: 3,
    rMultiples: [1.5, 3, 4.5],
  },
}

/** Map chart forecast toggle → setup style */
export function horizonToStyle(h: ForecastHorizon): SetupTradeStyle {
  if (h === 'SCALP') return 'SCALP'
  if (h === 'SWING' || h === 'MACRO') return 'SWING'
  return 'INTRADAY'
}

export function styleLabel(style: SetupTradeStyle | undefined): string {
  if (style === 'SCALP') return 'SCALP'
  if (style === 'SWING') return 'SWING'
  if (style === 'INTRADAY') return 'INTRA'
  return '—'
}
