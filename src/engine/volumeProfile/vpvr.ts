import type { OhlcvCandle } from '../../api/mexc'
import type { Time } from 'lightweight-charts'
import type { LiquidityZone } from '../indicators/types'

export interface VolumeBin {
  priceLow: number
  priceHigh: number
  priceMid: number
  volume: number
  buyVolume: number
  sellVolume: number
}

export interface VolumeProfileResult {
  bins: VolumeBin[]
  /** Point of Control — цена с макс. объёмом */
  poc: number
  /** Value Area High (70% объёма) */
  vah: number
  /** Value Area Low */
  val: number
  totalVolume: number
  valueAreaVolume: number
  /** Order Block пересекается с POC в пределах tolPct */
  obPocConfluence: boolean
  confluenceLabel: string
  scoreBoost: number
}

const DEFAULT_BINS = 48
const VALUE_AREA_PCT = 0.7

/**
 * Настоящий VPVR: объём распределяется по ценовым бинам внутри диапазона свечи.
 * Не путать с «свечой с max volume» — это был фейковый POC.
 */
export function calculateVolumeProfile(
  candles: OhlcvCandle[],
  binCount = DEFAULT_BINS,
  sessionOnly = false
): VolumeProfileResult | null {
  if (candles.length < 5) return null

  let source = candles
  if (sessionOnly && candles.length > 24) {
    // последние ~6–8 часов на 15m ≈ 24–32 свечи; на 1h ≈ 6–8
    source = candles.slice(-Math.min(48, candles.length))
  }

  let rangeHigh = -Infinity
  let rangeLow = Infinity
  for (const c of source) {
    if (c[2] > rangeHigh) rangeHigh = c[2]
    if (c[3] < rangeLow) rangeLow = c[3]
  }

  if (!Number.isFinite(rangeHigh) || !Number.isFinite(rangeLow) || rangeHigh <= rangeLow) {
    return null
  }

  const step = (rangeHigh - rangeLow) / binCount
  if (step <= 0) return null

  const bins: VolumeBin[] = Array.from({ length: binCount }, (_, i) => {
    const priceLow = rangeLow + i * step
    const priceHigh = priceLow + step
    return {
      priceLow,
      priceHigh,
      priceMid: (priceLow + priceHigh) / 2,
      volume: 0,
      buyVolume: 0,
      sellVolume: 0,
    }
  })

  let totalVolume = 0

  for (const candle of source) {
    const [, open, high, low, close, volume] = candle
    if (volume <= 0 || high <= low) continue

    const isBuy = close >= open
    const candleRange = high - low

    for (let i = 0; i < binCount; i++) {
      const bin = bins[i]
      const overlapLow = Math.max(low, bin.priceLow)
      const overlapHigh = Math.min(high, bin.priceHigh)
      if (overlapHigh <= overlapLow) continue

      const share = (overlapHigh - overlapLow) / candleRange
      const v = volume * share
      bin.volume += v
      if (isBuy) bin.buyVolume += v
      else bin.sellVolume += v
      totalVolume += v
    }
  }

  if (totalVolume <= 0) return null

  let pocIdx = 0
  for (let i = 1; i < bins.length; i++) {
    if (bins[i].volume > bins[pocIdx].volume) pocIdx = i
  }
  const poc = bins[pocIdx].priceMid

  // Value Area: расширяем от POC пока не наберём 70%
  let vaLowIdx = pocIdx
  let vaHighIdx = pocIdx
  let accumulated = bins[pocIdx].volume
  const target = totalVolume * VALUE_AREA_PCT

  while (accumulated < target && (vaLowIdx > 0 || vaHighIdx < bins.length - 1)) {
    const below = vaLowIdx > 0 ? bins[vaLowIdx - 1].volume : -1
    const above = vaHighIdx < bins.length - 1 ? bins[vaHighIdx + 1].volume : -1
    if (above >= below && vaHighIdx < bins.length - 1) {
      vaHighIdx++
      accumulated += bins[vaHighIdx].volume
    } else if (vaLowIdx > 0) {
      vaLowIdx--
      accumulated += bins[vaLowIdx].volume
    } else if (vaHighIdx < bins.length - 1) {
      vaHighIdx++
      accumulated += bins[vaHighIdx].volume
    } else {
      break
    }
  }

  const val = bins[vaLowIdx].priceLow
  const vah = bins[vaHighIdx].priceHigh

  return {
    bins,
    poc,
    vah,
    val,
    totalVolume,
    valueAreaVolume: accumulated,
    obPocConfluence: false,
    confluenceLabel: '',
    scoreBoost: 0,
  }
}

/** Буст если Order Block совпадает с дневным/сессионным POC */
export function applyObPocConfluence(
  profile: VolumeProfileResult,
  obTop: number | null,
  obBottom: number | null,
  tolPct = 0.15
): VolumeProfileResult {
  if (obTop == null || obBottom == null || profile.poc <= 0) {
    return profile
  }

  const mid = (obTop + obBottom) / 2
  const tol = profile.poc * (tolPct / 100)
  const pocInOb = profile.poc >= obBottom - tol && profile.poc <= obTop + tol
  const midNearPoc = Math.abs(mid - profile.poc) <= tol * 3

  if (!pocInOb && !midNearPoc) {
    return { ...profile, obPocConfluence: false, confluenceLabel: '', scoreBoost: 0 }
  }

  return {
    ...profile,
    obPocConfluence: true,
    confluenceLabel: `OB ∩ POC @ ${profile.poc.toFixed(4)}`,
    scoreBoost: 1.5,
  }
}

/** Зоны для ChartOverlay из VPVR */
export function volumeProfileToZones(
  profile: VolumeProfileResult,
  startMs: number,
  endMs: number
): LiquidityZone[] {
  const startTime = (startMs / 1000) as Time
  const endTime = (endMs / 1000) as Time
  const pocTol = Math.abs(profile.vah - profile.val) * 0.02 || profile.poc * 0.0005

  return [
    {
      id: 'vpvr_poc',
      type: 'POC',
      side: 'NEUTRAL',
      top: profile.poc + pocTol,
      bottom: profile.poc - pocTol,
      startTime,
      endTime,
      strength: 10,
      label: `POC $${profile.poc.toFixed(4)}`,
    },
    {
      id: 'vpvr_va',
      type: 'VALUE_AREA',
      side: 'NEUTRAL',
      top: profile.vah,
      bottom: profile.val,
      startTime,
      endTime,
      strength: 7,
      label: `VA ${profile.val.toFixed(2)}–${profile.vah.toFixed(2)}`,
    },
  ]
}
