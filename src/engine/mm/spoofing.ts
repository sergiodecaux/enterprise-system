import type { TrackedWall, WallEvent } from '../types'

export interface SpoofAlert {
  detected: boolean
  side: 'BID' | 'ASK' | null
  price: number
  volumeUsdApprox: number
  lifetimeMs: number
  approachPct: number
  label: string
  emoji: string
  /** Confidence should not rise from this wall */
  ignoreForConfidence: boolean
}

const SPOOF_MAX_AGE_MS = 2_000
const APPROACH_PCT = 0.1
const MIN_WALL_USD = 500_000

/**
 * Спуфинг: крупная стена появилась и исчезла за ≤2с при подходе цены на 0.1%.
 * Вызывать когда стена пропала без EATEN (объём не съеден лентой).
 */
export function detectSpoofFromDisappear(params: {
  wall: TrackedWall
  disappearedAt: number
  midPrice: number
  /** Approx USD: price * volume (contracts may need multiplier — best-effort) */
  volumeUsd: number
}): SpoofAlert | null {
  const lifetimeMs = params.disappearedAt - params.wall.firstSeen
  if (lifetimeMs > SPOOF_MAX_AGE_MS) return null
  if (params.volumeUsd < MIN_WALL_USD) return null

  const approachPct =
    (Math.abs(params.midPrice - params.wall.price) / params.midPrice) * 100
  if (approachPct > APPROACH_PCT * 3) return null // too far — not approach spoof

  const nearApproach = approachPct <= APPROACH_PCT * 2

  if (!nearApproach && lifetimeMs > SPOOF_MAX_AGE_MS) return null

  return {
    detected: true,
    side: params.wall.side,
    price: params.wall.price,
    volumeUsdApprox: params.volumeUsd,
    lifetimeMs,
    approachPct,
    emoji: '👻',
    label: `SPOOFING: ${params.wall.side} wall $${(params.volumeUsd / 1000).toFixed(0)}k исчезла за ${(lifetimeMs / 1000).toFixed(1)}с`,
    ignoreForConfidence: true,
  }
}

/**
 * Стена «убегает» от цены (переставляется дальше) — ММ хочет движение в её сторону.
 */
export function detectFleeingWall(params: {
  previousPrice: number
  currentPrice: number
  midPrice: number
  side: 'BID' | 'ASK'
}): boolean {
  const { previousPrice, currentPrice, midPrice, side } = params
  if (side === 'ASK') {
    // Ask wall moves higher as price rises toward it
    return currentPrice > previousPrice && midPrice > previousPrice * 0.999
  }
  // Bid wall moves lower as price falls toward it
  return currentPrice < previousPrice && midPrice < previousPrice * 1.001
}

/**
 * Реальная стена ММ: живёт долго И объём снижается (absorption), не исчезает целиком.
 */
export function isRealMmWall(wall: TrackedWall, now = Date.now()): boolean {
  const age = now - wall.firstSeen
  if (age < 10_000) return false
  const eaten =
    wall.initialVolume > 0
      ? (wall.initialVolume - wall.currentVolume) / wall.initialVolume
      : 0
  return wall.isActive && eaten > 0.05 && eaten < 0.7
}

export function spoofEventsFromWallUpdate(
  newEvents: WallEvent[],
  midPrice: number | null
): SpoofAlert[] {
  if (midPrice == null || midPrice <= 0) return []
  const alerts: SpoofAlert[] = []

  for (const ev of newEvents) {
    if (ev.type !== 'SPOOFED') continue
    const volumeUsd = ev.wall.price * ev.wall.currentVolume
    const alert = detectSpoofFromDisappear({
      wall: ev.wall,
      disappearedAt: ev.timestamp,
      midPrice,
      volumeUsd,
    })
    if (alert) alerts.push(alert)
  }
  return alerts
}
