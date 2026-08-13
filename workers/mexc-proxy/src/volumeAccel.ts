/**
 * Volume acceleration — enter before price moves, not after 24h pumps.
 * vol_15m / vol_prev_15m with flat chg15m = MM loading before the move.
 */

export type Candle = [number, number, number, number, number, number]

export interface VolumeAcceleration {
  vol_15m: number
  vol_prev_15m: number
  acceleration: number
  chg15mPct: number
  /** accel ≥ 2.5 and chg15m in [-3, +3] */
  preMove: boolean
}

const ACCEL_MIN = 2.5
const CHG15_ABS_MAX = 3

/** Sum quote-ish volume (candle vol field) over closed bars. */
function sumVol(candles: Candle[], from: number, to: number): number {
  let s = 0
  for (let i = from; i < to; i++) {
    const v = candles[i]?.[5]
    if (v != null && v > 0) s += v
  }
  return s
}

/**
 * Needs ≥31 closed 1m bars (15+15 + forming).
 * Uses closed candles only (drops last forming bar).
 */
export function measureVolumeAcceleration(
  candles1m: Candle[],
  opts?: { accelMin?: number; chgAbsMax?: number }
): VolumeAcceleration | null {
  const accelMin = opts?.accelMin ?? ACCEL_MIN
  const chgAbsMax = opts?.chgAbsMax ?? CHG15_ABS_MAX
  const closed = candles1m.length >= 2 ? candles1m.slice(0, -1) : candles1m
  if (closed.length < 30) return null

  const recent = closed.slice(-15)
  const prev = closed.slice(-30, -15)
  const vol_15m = sumVol(recent, 0, recent.length)
  const vol_prev_15m = sumVol(prev, 0, prev.length)
  if (!(vol_prev_15m > 0)) {
    return {
      vol_15m,
      vol_prev_15m,
      acceleration: 0,
      chg15mPct: 0,
      preMove: false,
    }
  }
  const acceleration = vol_15m / vol_prev_15m
  const open15 = recent[0]![1]
  const close15 = recent[recent.length - 1]![4]
  const chg15mPct =
    open15 > 0 ? ((close15 - open15) / open15) * 100 : 0
  const preMove =
    acceleration >= accelMin && Math.abs(chg15mPct) <= chgAbsMax

  return {
    vol_15m,
    vol_prev_15m,
    acceleration: Number(acceleration.toFixed(3)),
    chg15mPct: Number(chg15mPct.toFixed(3)),
    preMove,
  }
}

/** Soft rank boost for scan ordering (higher = scan first). */
export function volAccelRankScore(va: VolumeAcceleration | null): number {
  if (!va) return 0
  if (va.preMove) return 100 + Math.min(va.acceleration, 8) * 10
  if (va.acceleration >= 1.8 && Math.abs(va.chg15mPct) <= 5) {
    return 40 + va.acceleration * 8
  }
  return Math.min(30, va.acceleration * 5)
}
