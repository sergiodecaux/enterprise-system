/**
 * In-memory fuel cache: OI history + bid density snapshots for meme scanner.
 */
interface OiSnapshot {
  oi: number
  ts: number
}

interface BidDensitySnapshot {
  density: number
  ts: number
}

const oiHistory = new Map<string, OiSnapshot[]>()
const bidHistory = new Map<string, BidDensitySnapshot[]>()

const MAX_POINTS = 40
const HOUR_MS = 60 * 60 * 1000

export function recordOpenInterest(symbol: string, oi: number): void {
  if (!Number.isFinite(oi) || oi <= 0) return
  const list = oiHistory.get(symbol) ?? []
  list.push({ oi, ts: Date.now() })
  while (list.length > MAX_POINTS) list.shift()
  oiHistory.set(symbol, list)
}

export function getOiGrowthPct(symbol: string, lookbackMs = 15 * 60 * 1000): number {
  const list = oiHistory.get(symbol)
  if (!list || list.length < 2) return 0
  const now = Date.now()
  const recent = list[list.length - 1]
  const older = [...list].reverse().find((s) => now - s.ts >= lookbackMs * 0.5) ?? list[0]
  if (!older || older.oi <= 0) return 0
  return ((recent.oi - older.oi) / older.oi) * 100
}

export function recordBidDensity(symbol: string, density: number): void {
  if (!Number.isFinite(density) || density < 0) return
  const list = bidHistory.get(symbol) ?? []
  list.push({ density, ts: Date.now() })
  while (list.length > MAX_POINTS) list.shift()
  bidHistory.set(symbol, list)
}

export function getBidDensityHourAgo(symbol: string): number | null {
  const list = bidHistory.get(symbol)
  if (!list || list.length < 2) return null
  const target = Date.now() - HOUR_MS
  let best: BidDensitySnapshot | null = null
  let bestDist = Infinity
  for (const s of list) {
    const d = Math.abs(s.ts - target)
    if (d < bestDist) {
      bestDist = d
      best = s
    }
  }
  // Нужна точка хотя бы 20+ минут назад
  if (!best || Date.now() - best.ts < 20 * 60 * 1000) return null
  return best.density
}
