import type { OrderBookWall } from '../types'

export interface DensitySnapshot {
  timestamp: number
  midPrice: number
  /** Nearest significant bid wall price */
  bidDensityPrice: number | null
  /** Nearest significant ask wall price */
  askDensityPrice: number | null
  bidVolume: number
  askVolume: number
}

export interface PriceProddingResult {
  detected: boolean
  direction: 'UP' | 'DOWN' | 'NONE'
  /** Density still chasing price */
  chasing: boolean
  /** Distance of support/resistance density from mid (%) */
  distancePct: number
  label: string
  emoji: string
  /** Exit when density flips/disappears */
  exitSignal: boolean
}

const CHASE_DISTANCE_PCT = 0.2
const CHASE_WINDOW_MS = 10_000
const MIN_SAMPLES = 2

/**
 * Поджатие (Price Prodding): плотность Bids преследует растущую цену
 * на дистанции ~0.2% каждые ~10с → ММ гонит цену вверх.
 */
export function detectPriceProdding(
  history: DensitySnapshot[],
  now = Date.now()
): PriceProddingResult {
  const empty: PriceProddingResult = {
    detected: false,
    direction: 'NONE',
    chasing: false,
    distancePct: 0,
    label: '',
    emoji: '',
    exitSignal: false,
  }

  const recent = history.filter((h) => now - h.timestamp <= CHASE_WINDOW_MS * 3)
  if (recent.length < MIN_SAMPLES) return empty

  const last = recent[recent.length - 1]
  const prev = recent[0]
  if (!last.bidDensityPrice && !last.askDensityPrice) {
    return {
      ...empty,
      exitSignal: recent.some((h) => h.bidDensityPrice != null),
      label: 'Плотность исчезла — выход',
      emoji: '🚪',
    }
  }

  const priceUp = last.midPrice > prev.midPrice * 1.001
  const priceDown = last.midPrice < prev.midPrice * 0.999

  if (
    priceUp &&
    last.bidDensityPrice != null &&
    prev.bidDensityPrice != null
  ) {
    const dist =
      ((last.midPrice - last.bidDensityPrice) / last.midPrice) * 100
    const bidFollowed = last.bidDensityPrice > prev.bidDensityPrice
    const distOk = dist > 0 && dist <= CHASE_DISTANCE_PCT * 2

    if (bidFollowed && distOk) {
      return {
        detected: true,
        direction: 'UP',
        chasing: true,
        distancePct: dist,
        emoji: '👆',
        label: `PRICE PRODDING UP: Bid-плотность преследует цену (${dist.toFixed(2)}%)`,
        exitSignal: false,
      }
    }
  }

  if (
    priceDown &&
    last.askDensityPrice != null &&
    prev.askDensityPrice != null
  ) {
    const dist =
      ((last.askDensityPrice - last.midPrice) / last.midPrice) * 100
    const askFollowed = last.askDensityPrice < prev.askDensityPrice
    const distOk = dist > 0 && dist <= CHASE_DISTANCE_PCT * 2

    if (askFollowed && distOk) {
      return {
        detected: true,
        direction: 'DOWN',
        chasing: true,
        distancePct: dist,
        emoji: '👇',
        label: `PRICE PRODDING DOWN: Ask-плотность преследует цену (${dist.toFixed(2)}%)`,
        exitSignal: false,
      }
    }
  }

  // Density flipped against previous chase
  const hadUpChase = recent.some(
    (h, i) =>
      i > 0 &&
      h.bidDensityPrice != null &&
      recent[i - 1].bidDensityPrice != null &&
      h.midPrice > recent[i - 1].midPrice
  )
  if (hadUpChase && (last.bidDensityPrice == null || last.askVolume > last.bidVolume * 2)) {
    return {
      detected: false,
      direction: 'NONE',
      chasing: false,
      distancePct: 0,
      emoji: '🚪',
      label: 'Prodding сломан — плотность перевернулась на селл',
      exitSignal: true,
    }
  }

  return empty
}

export function densityFromWalls(
  midPrice: number,
  walls: OrderBookWall[],
  timestamp = Date.now()
): DensitySnapshot {
  const bids = walls.filter((w) => w.side === 'BID').sort((a, b) => b.price - a.price)
  const asks = walls.filter((w) => w.side === 'ASK').sort((a, b) => a.price - b.price)
  const bid = bids[0]
  const ask = asks[0]
  return {
    timestamp,
    midPrice,
    bidDensityPrice: bid?.price ?? null,
    askDensityPrice: ask?.price ?? null,
    bidVolume: bid?.volume ?? 0,
    askVolume: ask?.volume ?? 0,
  }
}
