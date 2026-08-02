/**
 * Client OI velocity tracker (holdVol from MEXC ticker).
 * Separate from meme fuelCache — used by Remizov sequence layer.
 */

interface OiPoint {
  oi: number
  price: number
  ts: number
}

const history = new Map<string, OiPoint[]>()
const MAX_POINTS = 48

export function recordOiSample(
  symbol: string,
  oi: number,
  price: number,
  ts = Date.now()
): void {
  if (!symbol || !(oi > 0) || !(price > 0)) return
  const list = history.get(symbol) ?? []
  const last = list[list.length - 1]
  // Throttle: skip if < 8s and tiny change
  if (last && ts - last.ts < 8_000 && Math.abs(oi - last.oi) / last.oi < 0.0005) {
    return
  }
  list.push({ oi, price, ts })
  while (list.length > MAX_POINTS) list.shift()
  history.set(symbol, list)
}

export interface OiSnapshot {
  oi: number
  /** % change over lookback */
  changePct: number
  /** Price % change over same window */
  priceChangePct: number
  /** OI↑ + price↑ or OI↓ + price↓ */
  confirmsMove: boolean
  /** Price↑ + OI↓ (distribution) or price↓ + OI↑ (trap) */
  diverges: boolean
  divergenceType: 'DISTRIBUTION' | 'SHORT_BUILD' | 'NONE'
  samples: number
}

export function getOiSnapshot(
  symbol: string,
  lookbackMs = 15 * 60_000,
  now = Date.now()
): OiSnapshot | null {
  const list = history.get(symbol)
  if (!list || list.length < 2) return null
  const recent = list[list.length - 1]!
  const older =
    [...list].reverse().find((s) => now - s.ts >= lookbackMs * 0.4) ?? list[0]!
  if (!older || older.oi <= 0) return null

  const changePct = ((recent.oi - older.oi) / older.oi) * 100
  const priceChangePct =
    ((recent.price - older.price) / older.price) * 100

  let divergenceType: OiSnapshot['divergenceType'] = 'NONE'
  if (priceChangePct > 0.15 && changePct < -0.8) divergenceType = 'DISTRIBUTION'
  else if (priceChangePct < -0.15 && changePct > 0.8) divergenceType = 'SHORT_BUILD'

  const confirmsMove =
    (priceChangePct > 0.12 && changePct > 0.35) ||
    (priceChangePct < -0.12 && changePct < -0.35)

  return {
    oi: recent.oi,
    changePct,
    priceChangePct,
    confirmsMove,
    diverges: divergenceType !== 'NONE',
    divergenceType,
    samples: list.length,
  }
}
