import type { Time } from 'lightweight-charts'
import type { OhlcvCandle } from '../../api/mexc'
import type { LiquidityZone, PriceLevel } from '../indicators/types'
import { findOrderBlocks, findFvg, detectMarketStructure } from '../smc'
import {
  calculateVolumeProfile,
  volumeProfileToZones,
} from '../volumeProfile'

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function medianIntervalMs(candles: OhlcvCandle[]): number {
  if (candles.length < 3) return 0
  const steps: number[] = []
  for (let i = Math.max(1, candles.length - 12); i < candles.length; i++) {
    const d = candles[i][0] - candles[i - 1][0]
    if (d > 0) steps.push(d)
  }
  if (!steps.length) return 0
  steps.sort((a, b) => a - b)
  return steps[Math.floor(steps.length / 2)]
}

/** POC of the traded volume that sits inside a zone. */
function pocInRange(
  candles: OhlcvCandle[],
  bottom: number,
  top: number
): number | null {
  if (!(top > bottom)) return null
  const profile = calculateVolumeProfile(candles.slice(-200), 80, true)
  if (!profile) return null
  const inside = profile.bins.filter(
    (b) => b.priceMid >= bottom && b.priceMid <= top
  )
  if (!inside.length) return null
  inside.sort((a, b) => b.volume - a.volume)
  return inside[0].priceMid
}

/**
 * A zone is mitigated when a full close goes through its far edge. A wick
 * through the level is a sweep, not mitigation.
 */
function zoneState(
  candles: OhlcvCandle[],
  startIndex: number,
  side: LiquidityZone['side'],
  top: number,
  bottom: number
): { mitigated: boolean; endTime: Time } {
  const fallback = (candles[candles.length - 1][0] / 1000) as Time
  if (side === 'NEUTRAL') return { mitigated: false, endTime: fallback }

  for (let i = startIndex + 1; i < candles.length; i++) {
    const close = candles[i][4]
    if (side === 'BULLISH' && close < bottom) {
      return { mitigated: true, endTime: (candles[i][0] / 1000) as Time }
    }
    if (side === 'BEARISH' && close > top) {
      return { mitigated: true, endTime: (candles[i][0] / 1000) as Time }
    }
  }
  return { mitigated: false, endTime: fallback }
}

function averageRange(candles: OhlcvCandle[], lookback = 20): number {
  const slice = candles.slice(-lookback)
  if (!slice.length) return 0
  return slice.reduce((s, c) => s + Math.max(0, c[2] - c[3]), 0) / slice.length
}

function averageVolume(candles: OhlcvCandle[], lookback = 20): number {
  const slice = candles.slice(-lookback)
  if (!slice.length) return 0
  return slice.reduce((s, c) => s + Math.max(0, c[5]), 0) / slice.length
}

export function calculateOrderBlockZones(candles: OhlcvCandle[]): LiquidityZone[] {
  if (candles.length < 20) return []

  const structure = detectMarketStructure(candles)
  const orderBlocks = findOrderBlocks(candles, structure, 10)
  const avgVol = averageVolume(candles) || 1

  return orderBlocks
    .filter((ob) => candles.length - 1 - ob.index <= 240)
    .map((ob) => {
      const startCandle = candles[ob.index]
      const top = Math.max(ob.top, ob.bottom)
      const bottom = Math.min(ob.top, ob.bottom)
      const state = zoneState(candles, ob.index, ob.type, top, bottom)
      const volumeRatio = (ob.volume || startCandle[5] || 0) / avgVol
      const strength = clamp(
        Math.round(3.5 + (ob.strength || 4) * 0.55 + volumeRatio * 1.6),
        4,
        10
      )

      return {
        id: `ob_${ob.type}_${ob.index}`,
        type: 'ORDER_BLOCK' as const,
        side: ob.type,
        top,
        bottom,
        startTime: (startCandle[0] / 1000) as Time,
        endTime: state.endTime,
        strength,
        strengthTier:
          strength >= 8 ? ('STRONG' as const) : strength >= 6 ? ('MEDIUM' as const) : ('WEAK' as const),
        mitigated: state.mitigated,
        poc: pocInRange(candles, bottom, top) ?? (top + bottom) / 2,
        invalidation: ob.type === 'BULLISH' ? bottom : top,
        label: `OB ${ob.type} ${strength}/10`,
      }
    })
}

export function calculateFvgZones(candles: OhlcvCandle[]): LiquidityZone[] {
  if (candles.length < 5) return []

  const fvgList = findFvg(candles, 10)
  const avgVol = averageVolume(candles) || 1
  const avgRange = averageRange(candles) || 1

  return fvgList
    .filter((fvg) => candles.length - 1 - fvg.index <= 240)
    .map((fvg) => {
      const startCandle = candles[fvg.index]
      const top = Math.max(fvg.top, fvg.bottom)
      const bottom = Math.min(fvg.top, fvg.bottom)
      const state = zoneState(candles, fvg.index, fvg.type, top, bottom)
      const ce = (top + bottom) / 2
      const height = Math.max(0, top - bottom)
      const displacement = avgRange > 0 ? height / avgRange : 0
      const volumeRatio = (startCandle[5] || 0) / avgVol
      const strength = clamp(
        Math.round(4 + volumeRatio * 1.5 + displacement * 2),
        4,
        10
      )

      return {
        id: `fvg_${fvg.type}_${fvg.index}`,
        type: 'FVG' as const,
        side: fvg.type,
        top,
        bottom,
        startTime: (startCandle[0] / 1000) as Time,
        endTime: state.endTime,
        strength,
        strengthTier:
          strength >= 8 ? ('STRONG' as const) : strength >= 6 ? ('MEDIUM' as const) : ('WEAK' as const),
        // Fully mitigated gaps are filtered by findFvg; keep the flag for
        // zones rebuilt from older snapshots.
        mitigated: state.mitigated,
        // FVG consequent encroachment = 50% fill, the standard limit anchor.
        ce,
        poc: ce,
        invalidation: fvg.type === 'BULLISH' ? bottom : top,
        label: `FVG ${fvg.type} ${strength}/10`,
      }
    })
}

export function calculatePocLevel(candles: OhlcvCandle[]): LiquidityZone | null {
  const profile = calculateVolumeProfile(candles, 48, true)
  if (!profile) return null

  const zones = volumeProfileToZones(
    profile,
    candles[0][0],
    candles[candles.length - 1][0]
  )
  return zones.find((z) => z.type === 'POC') ?? null
}

export function calculateValueArea(candles: OhlcvCandle[]): LiquidityZone | null {
  const profile = calculateVolumeProfile(candles, 48, true)
  if (!profile) return null

  const zones = volumeProfileToZones(
    profile,
    candles[0][0],
    candles[candles.length - 1][0]
  )
  return zones.find((z) => z.type === 'VALUE_AREA') ?? null
}

/**
 * Previous completed daily candle high/low/close.
 * The caller can pass any chart timeframe, so validate the spacing instead of
 * painting intraday candles as PDH/PDL.
 */
export function calculateDailyPriceLevels(candles: OhlcvCandle[]): PriceLevel[] {
  if (candles.length < 2) return []
  const interval = medianIntervalMs(candles)
  // Daily candles are ~24h apart; tolerate weekend gaps but not 1h/4h data.
  if (interval < 20 * 60 * 60 * 1000) return []

  const prev = candles[candles.length - 2]
  const high = prev[2]
  const low = prev[3]
  const close = prev[4]

  return [
    {
      id: 'daily_high',
      type: 'DAILY_HIGH',
      price: high,
      label: 'PDH',
      color: 'rgba(226, 232, 240, 0.55)',
      lineStyle: 2,
    },
    {
      id: 'daily_low',
      type: 'DAILY_LOW',
      price: low,
      label: 'PDL',
      color: 'rgba(226, 232, 240, 0.55)',
      lineStyle: 2,
    },
    {
      id: 'daily_close',
      type: 'DAILY_CLOSE',
      price: close,
      label: 'PDC',
      color: 'rgba(148, 163, 184, 0.5)',
      lineStyle: 1,
    },
  ]
}
