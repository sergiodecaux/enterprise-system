import type { MarketFrame } from './types'

const MAX_FRAMES = 160
const buses = new Map<string, MarketFrame[]>()

/**
 * Ring buffer of frames per symbol — the Remizov "film strip".
 * Pure memory; not persisted (process lives in the open session).
 */
export function pushFrames(symbol: string, frames: MarketFrame[]): void {
  if (!symbol || !frames.length) return
  const prev = buses.get(symbol) ?? []
  const next = prev.concat(frames)
  buses.set(
    symbol,
    next.length > MAX_FRAMES ? next.slice(next.length - MAX_FRAMES) : next
  )
}

export function getFrames(
  symbol: string,
  windowMs = 5 * 60_000,
  now = Date.now()
): MarketFrame[] {
  const all = buses.get(symbol) ?? []
  const cut = now - windowMs
  return all.filter((f) => f.at >= cut)
}

export function clearFrames(symbol: string): void {
  buses.delete(symbol)
}

export function frameCount(symbol: string): number {
  return buses.get(symbol)?.length ?? 0
}
