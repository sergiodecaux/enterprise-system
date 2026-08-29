import { getSessionAtHour, SESSION_DEFINITIONS } from '../sessions/sessionMap'
import type { CoinGapStats } from './types'

const KEY = 'enterprise_radar141_stats'

type Store = Record<string, CoinGapStats & { sessionHits?: Record<string, number> }>

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Store
  } catch {
    return {}
  }
}

function save(store: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    /* ignore */
  }
}

export function emptyStats(): CoinGapStats {
  return {
    flights: 0,
    avgFlightPct: 0,
    false141Exits: 0,
    bestSession: null,
    lastUpdated: 0,
  }
}

export function readCoinStats(symbol: string): CoinGapStats {
  const row = load()[symbol]
  if (!row) return emptyStats()
  return {
    flights: row.flights ?? 0,
    avgFlightPct: row.avgFlightPct ?? 0,
    false141Exits: row.false141Exits ?? 0,
    bestSession: row.bestSession ?? null,
    lastUpdated: row.lastUpdated ?? 0,
  }
}

export function recordFlight(symbol: string, movePct: number) {
  const store = load()
  const prev = store[symbol] ?? { ...emptyStats(), sessionHits: {} }
  const n = prev.flights + 1
  const avg = (prev.avgFlightPct * prev.flights + Math.abs(movePct)) / n
  const session = SESSION_DEFINITIONS[getSessionAtHour(new Date().getUTCHours())].label
  const hits = { ...(prev.sessionHits ?? {}) }
  hits[session] = (hits[session] ?? 0) + 1
  let best: string | null = prev.bestSession
  let max = 0
  for (const [k, v] of Object.entries(hits)) {
    if (v > max) {
      max = v
      best = k
    }
  }
  store[symbol] = {
    flights: n,
    avgFlightPct: avg,
    false141Exits: prev.false141Exits,
    bestSession: best,
    lastUpdated: Date.now(),
    sessionHits: hits,
  }
  save(store)
}

export function recordFalse141Exit(symbol: string) {
  const store = load()
  const prev = store[symbol] ?? { ...emptyStats(), sessionHits: {} }
  store[symbol] = {
    ...prev,
    false141Exits: (prev.false141Exits ?? 0) + 1,
    lastUpdated: Date.now(),
  }
  save(store)
}
