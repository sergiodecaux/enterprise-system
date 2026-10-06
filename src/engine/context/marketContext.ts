import type { OhlcvCandle } from '../../api/mexc'
import type { MmIntentSnapshot } from '../types'
import { buildSessionContext } from '../sessions/sessionQuality'
import { adjustThresholds, BASE_THRESHOLDS } from './adjustThresholds'
import { buildHtfCloseContext } from './htfClose'
import {
  EMPTY_CROWD,
  type CrowdContext,
  type FullMarketContext,
  type WhaleContext,
} from './types'

export function whaleContextFrom(
  mm: MmIntentSnapshot | null | undefined,
  price: number
): WhaleContext {
  const micro = mm?.hunt.microTarget ?? null
  const nearCluster =
    micro != null && price > 0 && Math.abs(micro - price) / price <= 0.012
  const hunt = Boolean(
    mm &&
      (mm.hunt.microIsStopHunt || (mm.confidence >= 55 && micro != null))
  )
  return {
    drive: mm?.drive ?? 'NEUTRAL',
    hunt,
    nearCluster,
    preferredSide: mm?.preferredSide ?? null,
  }
}

export function buildFullMarketContext(input: {
  now?: number
  candles1d?: OhlcvCandle[]
  price?: number
  mm?: MmIntentSnapshot | null
  crowd?: CrowdContext | null
}): FullMarketContext {
  const now = input.now ?? Date.now()
  const session = buildSessionContext(now)
  const htf = buildHtfCloseContext(input.candles1d, now)
  const crowd = input.crowd ?? EMPTY_CROWD
  const whales = whaleContextFrom(input.mm, input.price ?? 0)
  const { thresholds, notes } = adjustThresholds(BASE_THRESHOLDS, {
    session,
    htf,
    crowd,
    whales,
  })
  return { session, htf, crowd, whales, thresholds, notes }
}
