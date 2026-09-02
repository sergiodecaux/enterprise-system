import type { MexcTrade, OhlcvCandle } from '../../api/mexc'
import type { OrderBookSnapshot } from '../types'

/** Typical MEXC perp leverages. Mid-range (20–50–100) is the crowd. */
const LEVERAGES = [5, 10, 20, 25, 50, 75, 100, 125] as const
const LEV_WEIGHT: Record<(typeof LEVERAGES)[number], number> = {
  5: 0.55,
  10: 1.0,
  20: 1.25,
  25: 1.45,
  50: 1.7,
  75: 1.15,
  100: 1.35,
  125: 0.75,
}

const BIN_COUNT = 48

export interface LiqBin {
  price: number
  priceLow: number
  priceHigh: number
  /** Estimated long liquidations (forced sells, usually below price) */
  longLiq: number
  /** Estimated short liquidations (forced buys, usually above price) */
  shortLiq: number
  /** Where crowd opened longs (buy volume at this price) */
  longEntry: number
  /** Where crowd opened shorts (sell volume at this price) */
  shortEntry: number
  /** Tape: people actually bought here */
  buyVol: number
  /** Tape: people actually sold here */
  sellVol: number
  /** Resting bids — want to buy */
  bidSize: number
  /** Resting asks — want to sell */
  askSize: number
}

export interface EntryCluster {
  price: number
  side: 'LONG' | 'SHORT'
  score: number
}

export interface LiqHeatmapModel {
  bins: LiqBin[]
  currentPrice: number
  step: number
  maxLiq: number
  maxFlow: number
  maxBook: number
  maxLongEntry: number
  maxShortEntry: number
  nearestLongLiq: number | null
  nearestShortLiq: number | null
  longClusters: EntryCluster[]
  shortClusters: EntryCluster[]
  longBelow: number
  shortAbove: number
  buyTape: number
  sellTape: number
  label: string
}

function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0.0001
  const exp = Math.floor(Math.log10(raw))
  const mag = 10 ** exp
  const n = raw / mag
  const nice = n <= 1.5 ? 1 : n <= 3.5 ? 2 : n <= 7.5 ? 5 : 10
  return nice * mag
}

function binIndex(price: number, low: number, step: number, n: number): number {
  const i = Math.floor((price - low) / step)
  if (i < 0 || i >= n) return -1
  return i
}

function pickPeaks(
  bins: LiqBin[],
  key: 'longEntry' | 'shortEntry',
  max: number,
  side: 'LONG' | 'SHORT',
  limit = 3
): EntryCluster[] {
  if (!(max > 0)) return []
  const peaks: EntryCluster[] = []
  for (let i = 0; i < bins.length; i++) {
    const v = bins[i][key]
    if (v < max * 0.34) continue
    const left = i > 0 ? bins[i - 1][key] : 0
    const right = i < bins.length - 1 ? bins[i + 1][key] : 0
    if (v >= left && v >= right) {
      peaks.push({ price: bins[i].price, side, score: v / max })
    }
  }
  peaks.sort((a, b) => b.score - a.score)
  return peaks.slice(0, limit)
}

/**
 * Coinglass-style liquidation heatmap from candles (no exchange force-order feed).
 * Each candle's volume is treated as new positions; liq price ≈ entry × (1 ± 1/leverage).
 * Live tape + order book overlay “where people buy and sell right now”.
 */
export function buildLiqHeatmap(input: {
  candles: OhlcvCandle[]
  currentPrice: number
  trades?: MexcTrade[]
  book?: OrderBookSnapshot | null
  openInterest?: number | null
}): LiqHeatmapModel | null {
  const { candles, trades, book, openInterest } = input
  const currentPrice = Number(input.currentPrice)
  if (!(currentPrice > 0) || candles.length < 8) return null

  let rangeHigh = -Infinity
  let rangeLow = Infinity
  const lookback = candles.slice(-Math.min(160, candles.length))
  for (const c of lookback) {
    if (c[2] > rangeHigh) rangeHigh = c[2]
    if (c[3] < rangeLow) rangeLow = c[3]
  }
  if (!Number.isFinite(rangeHigh) || rangeHigh <= rangeLow) return null

  const pad = (rangeHigh - rangeLow) * 0.18
  rangeHigh += pad
  rangeLow = Math.max(0, rangeLow - pad)

  const step = niceStep((rangeHigh - rangeLow) / BIN_COUNT)
  if (!(step > 0)) return null
  const low = Math.floor(rangeLow / step) * step
  const n = Math.max(16, Math.min(56, Math.ceil((rangeHigh - low) / step) + 1))

  const bins: LiqBin[] = Array.from({ length: n }, (_, i) => {
    const priceLow = low + i * step
    return {
      price: priceLow + step / 2,
      priceLow,
      priceHigh: priceLow + step,
      longLiq: 0,
      shortLiq: 0,
      longEntry: 0,
      shortEntry: 0,
      buyVol: 0,
      sellVol: 0,
      bidSize: 0,
      askSize: 0,
    }
  })

  const add = (
    price: number,
    amount: number,
    key:
      | 'longLiq'
      | 'shortLiq'
      | 'longEntry'
      | 'shortEntry'
      | 'buyVol'
      | 'sellVol'
      | 'bidSize'
      | 'askSize'
  ) => {
    const idx = binIndex(price, low, step, n)
    if (idx < 0 || !(amount > 0)) return
    bins[idx][key] += amount
  }

  const oiScale =
    openInterest != null && openInterest > 0
      ? Math.min(4, Math.log10(openInterest + 10) / 3)
      : 1

  const last = lookback.length - 1
  for (let i = 0; i < lookback.length; i++) {
    const [, open, high, lowPx, close, volume] = lookback[i]
    if (!(volume > 0)) continue
    const typical = (high + lowPx + close) / 3
    const recency = 0.28 + 0.72 * (i / Math.max(last, 1))
    const buyFrac = close >= open ? 0.74 : 0.26
    const volW = volume * recency
    const candleRange = high - lowPx

    if (candleRange <= 0) {
      add(typical, volW * buyFrac, 'longEntry')
      add(typical, volW * (1 - buyFrac), 'shortEntry')
    } else {
      for (let bi = 0; bi < n; bi++) {
        const overlap =
          Math.min(high, bins[bi].priceHigh) - Math.max(lowPx, bins[bi].priceLow)
        if (overlap <= 0) continue
        const share = overlap / candleRange
        bins[bi].longEntry += volW * buyFrac * share
        bins[bi].shortEntry += volW * (1 - buyFrac) * share
      }
    }

    for (const lev of LEVERAGES) {
      const mmr = 1 / lev
      const w = volW * LEV_WEIGHT[lev] * oiScale
      add(typical * (1 - mmr), w * buyFrac, 'longLiq')
      add(typical * (1 + mmr), w * (1 - buyFrac), 'shortLiq')
    }
  }

  if (trades) {
    for (const t of trades) {
      if (!(t.volume > 0) || !(t.price > 0)) continue
      add(t.price, t.volume, t.side === 'BUY' ? 'buyVol' : 'sellVol')
      add(t.price, t.volume * 1.35, t.side === 'BUY' ? 'longEntry' : 'shortEntry')
    }
  }

  if (book) {
    for (const lvl of book.bids) add(lvl.price, lvl.volume, 'bidSize')
    for (const lvl of book.asks) add(lvl.price, lvl.volume, 'askSize')
  }

  let maxLiq = 0
  let maxFlow = 0
  let maxBook = 0
  let maxLongEntry = 0
  let maxShortEntry = 0
  let longBelow = 0
  let shortAbove = 0
  let buyTape = 0
  let sellTape = 0
  let nearestLongLiq: number | null = null
  let nearestShortLiq: number | null = null
  let bestLong = 0
  let bestShort = 0

  for (const b of bins) {
    maxLiq = Math.max(maxLiq, b.longLiq, b.shortLiq)
    maxFlow = Math.max(maxFlow, b.buyVol, b.sellVol)
    maxBook = Math.max(maxBook, b.bidSize, b.askSize)
    maxLongEntry = Math.max(maxLongEntry, b.longEntry)
    maxShortEntry = Math.max(maxShortEntry, b.shortEntry)
    buyTape += b.buyVol
    sellTape += b.sellVol
    if (b.price < currentPrice) {
      longBelow += b.longLiq
      if (b.longLiq > bestLong) {
        bestLong = b.longLiq
        nearestLongLiq = b.price
      }
    } else {
      shortAbove += b.shortLiq
      if (b.shortLiq > bestShort) {
        bestShort = b.shortLiq
        nearestShortLiq = b.price
      }
    }
  }

  const longClusters = pickPeaks(bins, 'longEntry', maxLongEntry, 'LONG')
  const shortClusters = pickPeaks(bins, 'shortEntry', maxShortEntry, 'SHORT')

  const fmt = (p: number) =>
    p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(4) : p.toPrecision(4)

  const longPeak = longClusters[0]
  const shortPeak = shortClusters[0]
  let label = 'Где толпа брала лонги и шорты'
  if (longPeak && shortPeak) {
    label = `Лонги с ${fmt(longPeak.price)} · шорты с ${fmt(shortPeak.price)}`
  } else if (longPeak) {
    label = `Лонги набирали с ${fmt(longPeak.price)}`
  } else if (shortPeak) {
    label = `Шорты набирали с ${fmt(shortPeak.price)}`
  }

  return {
    bins,
    currentPrice,
    step,
    maxLiq,
    maxFlow,
    maxBook,
    maxLongEntry,
    maxShortEntry,
    nearestLongLiq,
    nearestShortLiq,
    longClusters,
    shortClusters,
    longBelow,
    shortAbove,
    buyTape,
    sellTape,
    label,
  }
}
