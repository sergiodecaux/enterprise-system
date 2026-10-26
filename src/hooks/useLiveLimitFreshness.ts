import { useEffect, useMemo, useState } from 'react'
import type { LiveLimitTrade } from '../engine/sniper/liveLimits'

const STORAGE_KEY = 'enterprise_live_limits_seen'
const TTL_MS = 24 * 60 * 60 * 1000

/** «NEW» badge window for a freshly discovered limit plan */
export const LIVE_LIMIT_NEW_BADGE_MS = 20 * 60 * 1000

type SeenMap = Record<string, number>

export interface LiveLimitFreshness {
  firstSeenAt: number
  isNew: boolean
}

function loadSeen(): SeenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as SeenMap
    if (!parsed || typeof parsed !== 'object') return {}
    const now = Date.now()
    const next: SeenMap = {}
    for (const [key, at] of Object.entries(parsed)) {
      if (typeof at === 'number' && now - at < TTL_MS) next[key] = at
    }
    return next
  } catch {
    return {}
  }
}

function persistSeen(map: SeenMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* quota / private mode */
  }
}

/**
 * Persisted first-seen timestamps for live limit plans.
 * Ids are stable across ticker ticks, so a plan keeps its NEW badge
 * for 20 minutes and does not re-appear as new after a scan refresh.
 */
export function useLiveLimitFreshness(
  trades: LiveLimitTrade[]
): Record<string, LiveLimitFreshness> {
  const [seen, setSeen] = useState<SeenMap>(() => loadSeen())

  useEffect(() => {
    if (!trades.length) return
    const now = Date.now()
    let changed = false
    const next: SeenMap = { ...seen }

    for (const trade of trades) {
      if (next[trade.id] == null) {
        next[trade.id] = now
        changed = true
      }
    }

    for (const [key, at] of Object.entries(next)) {
      if (now - at >= TTL_MS) {
        delete next[key]
        changed = true
      }
    }

    if (changed) {
      persistSeen(next)
      setSeen(next)
    }
  }, [trades, seen])

  return useMemo(() => {
    const now = Date.now()
    const out: Record<string, LiveLimitFreshness> = {}
    for (const trade of trades) {
      const firstSeenAt = seen[trade.id] ?? now
      out[trade.id] = {
        firstSeenAt,
        isNew: now - firstSeenAt < LIVE_LIMIT_NEW_BADGE_MS,
      }
    }
    return out
  }, [trades, seen])
}
