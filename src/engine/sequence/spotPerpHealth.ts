/**
 * Spot vs Perpetual delta health.
 * Spot-led moves = real demand; perp-led / divergent = "dirty" fuel.
 */

import type { MexcTrade } from '../../api/mexc'
import type { MarketFrame } from './types'

export type SpotPerpStatus =
  | 'ALIGNED'
  | 'SPOT_LED'
  | 'PERP_LED'
  | 'DIVERGED'
  | 'UNKNOWN'

export interface SpotPerpHealth {
  status: SpotPerpStatus
  /** Multiply sequence confidence */
  confidenceMul: number
  spotDeltaUsd: number
  perpDeltaUsd: number
  label: string
  tip: string
}

export function deltaFromTrades(
  trades: MexcTrade[] | null | undefined,
  windowMs = 5 * 60_000,
  now = Date.now()
): number {
  if (!trades?.length) return 0
  const cut = now - windowMs
  let buy = 0
  let sell = 0
  for (const t of trades) {
    if (t.timestamp < cut) continue
    const usd = t.price * t.volume
    if (t.side === 'BUY') buy += usd
    else sell += usd
  }
  return buy - sell
}

/**
 * Compare spot tape delta vs perp tape delta.
 * Spot leading in same direction → strongest; opposite signs → dirty.
 */
export function computeSpotPerpHealth(
  perpDeltaUsd: number,
  spotDeltaUsd: number | null | undefined
): SpotPerpHealth {
  if (spotDeltaUsd == null || !Number.isFinite(spotDeltaUsd)) {
    return {
      status: 'UNKNOWN',
      confidenceMul: 1,
      spotDeltaUsd: 0,
      perpDeltaUsd,
      label: 'Спот …',
      tip: 'Нет данных спота — здоровье движения неизвестно',
    }
  }

  const spot = spotDeltaUsd
  const perp = perpDeltaUsd
  const absS = Math.abs(spot)
  const absP = Math.abs(perp)
  const minMeaningful = 8_000

  if (absS < minMeaningful && absP < minMeaningful) {
    return {
      status: 'ALIGNED',
      confidenceMul: 1,
      spotDeltaUsd: spot,
      perpDeltaUsd: perp,
      label: 'Спот=Перп',
      tip: 'Обе дельты тихие',
    }
  }

  const sameSign =
    (spot >= 0 && perp >= 0) || (spot < 0 && perp < 0) || absS < minMeaningful * 0.5

  if (!sameSign && absS >= minMeaningful && absP >= minMeaningful) {
    return {
      status: 'DIVERGED',
      confidenceMul: 0.68,
      spotDeltaUsd: spot,
      perpDeltaUsd: perp,
      label: 'Грязный ход',
      tip: 'Спот и перпы в разные стороны — рост/падение неустойчивы',
    }
  }

  // Spot leads (same direction, spot magnitude larger)
  if (sameSign && absS >= absP * 1.15 && absS >= minMeaningful) {
    return {
      status: 'SPOT_LED',
      confidenceMul: 1.1,
      spotDeltaUsd: spot,
      perpDeltaUsd: perp,
      label: 'Спот ведёт',
      tip: 'Реальные покупки/продажи на споте тянут перпы — сильное топливо',
    }
  }

  // Perp leads (leverage speculation)
  if (sameSign && absP >= absS * 1.35 && absP >= minMeaningful) {
    return {
      status: 'PERP_LED',
      confidenceMul: 0.78,
      spotDeltaUsd: spot,
      perpDeltaUsd: perp,
      label: 'Перпы ведут',
      tip: 'Ход на плечах без спота — снижаем уверенность',
    }
  }

  return {
    status: 'ALIGNED',
    confidenceMul: 1.02,
    spotDeltaUsd: spot,
    perpDeltaUsd: perp,
    label: 'Спот≈Перп',
    tip: 'Дельты согласованы',
  }
}

export function spotPerpToFrame(
  health: SpotPerpHealth,
  now = Date.now()
): MarketFrame {
  return {
    at: now,
    kind: 'SPOT_PERP',
    side:
      health.spotDeltaUsd > 0
        ? 'BUY'
        : health.spotDeltaUsd < 0
          ? 'SELL'
          : 'FLAT',
    volumeUsd: Math.abs(health.spotDeltaUsd),
    strength: Math.min(1, Math.abs(1 - health.confidenceMul)),
    label: health.status,
    meta: {
      perpDelta: health.perpDeltaUsd,
      mul: health.confidenceMul,
    },
  }
}

/** In-memory last spot trades delta per symbol (set by UI ingest). */
const spotDeltaCache = new Map<
  string,
  { delta: number; at: number }
>()

export function setSpotDeltaCache(
  symbol: string,
  delta: number,
  now = Date.now()
): void {
  spotDeltaCache.set(symbol, { delta, at: now })
}

export function getSpotDeltaCache(
  symbol: string,
  maxAgeMs = 90_000,
  now = Date.now()
): number | null {
  const row = spotDeltaCache.get(symbol)
  if (!row) return null
  if (now - row.at > maxAgeMs) return null
  return row.delta
}

export function getCachedSpotPerpHealth(
  symbol: string,
  perpDeltaUsd: number,
  now = Date.now()
): SpotPerpHealth {
  return computeSpotPerpHealth(perpDeltaUsd, getSpotDeltaCache(symbol, 90_000, now))
}
