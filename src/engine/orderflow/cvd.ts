import type { OhlcvCandle } from '../../api/mexc'

/**
 * CVD (Cumulative Volume Delta).
 *
 * Priority:
 *  1. True taker decomposition when the candle carries taker-buy volume
 *     (field 7 in an extended OHLCV tuple): delta = 2 * takerBuy - volume.
 *  2. OHLCV volume-distribution approximation (close location + wick
 *     rejection), never the naive `close >= open` sign.
 *
 * Without a raw aggTrade feed no OHLCV formula can recover the exact delta,
 * but the distribution model below is materially closer to auction physics
 * than OBV-style candle colouring.
 */
export type CvdCandle = OhlcvCandle | [...OhlcvCandle, number?]

export interface CvdPoint {
  index: number
  cvd: number
  price: number
}

export interface CvdDivergenceResult {
  detected: boolean
  type: 'BULLISH' | 'BEARISH' | 'NONE'
  /** Цена сделала новый low/high, а CVD — нет */
  priceExtreme: number | null
  cvdExtreme: number | null
  lookback: number
  scoreBoost: number
  label: string
  /** True when the candle carried real taker-buy volume */
  takerBased?: boolean
}

function takerBuyVolume(candle: CvdCandle): number | null {
  const raw = (candle as readonly unknown[])[6]
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null
  return raw
}

/**
 * Synthetic per-candle delta from OHLCV (volume distribution model).
 * closeLocation: where the auction closed inside the range.
 * wickDelta: lower wick = sellers absorbed (positive), upper wick = buyers
 * absorbed (negative).
 */
export function estimateCandleDelta(candle: CvdCandle): number {
  const [, open, high, low, close, volume] = candle
  const totalRange = high - low
  if (!(volume > 0) || totalRange <= 0) return 0

  const closeLocation = ((close - low) - (high - close)) / totalRange
  const upperWick = high - Math.max(open, close)
  const lowerWick = Math.min(open, close) - low
  const wickDelta = (lowerWick - upperWick) / totalRange

  const syntheticRatio = closeLocation * 0.65 + wickDelta * 0.35
  return volume * Math.max(-1, Math.min(1, syntheticRatio))
}

export function computeCvdSeries(candles: CvdCandle[]): CvdPoint[] {
  let cvd = 0
  const points: CvdPoint[] = []

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]
    const takerBuy = takerBuyVolume(candle)
    const delta =
      takerBuy != null
        ? 2 * takerBuy - candle[5]
        : estimateCandleDelta(candle)
    cvd += delta
    points.push({ index: i, cvd, price: candle[4] })
  }

  return points
}

/**
 * Бычья дивергенция: цена обновила low, CVD выше предыдущего low-CVD
 * (продавцы истощены). Медвежья: цена обновила high, CVD ниже high-CVD.
 */
export function detectCvdDivergence(
  candles: CvdCandle[],
  lookback = 20
): CvdDivergenceResult {
  const empty: CvdDivergenceResult = {
    detected: false,
    type: 'NONE',
    priceExtreme: null,
    cvdExtreme: null,
    lookback,
    scoreBoost: 0,
    label: '',
  }

  if (candles.length < lookback + 5) return empty

  const series = computeCvdSeries(candles)
  const window = series.slice(-lookback)
  const prev = series.slice(-(lookback * 2), -lookback)
  if (prev.length < 5) return empty

  const last = window[window.length - 1]
  const priceLow = Math.min(...window.map((p) => candles[p.index][3]))
  const priceHigh = Math.max(...window.map((p) => candles[p.index][2]))
  const prevPriceLow = Math.min(...prev.map((p) => candles[p.index][3]))
  const prevPriceHigh = Math.max(...prev.map((p) => candles[p.index][2]))

  const cvdAtPriceLow = window.reduce((best, p) =>
    candles[p.index][3] <= candles[best.index][3] ? p : best
  )
  const cvdAtPriceHigh = window.reduce((best, p) =>
    candles[p.index][2] >= candles[best.index][2] ? p : best
  )
  const prevCvdAtLow = prev.reduce((best, p) =>
    candles[p.index][3] <= candles[best.index][3] ? p : best
  )
  const prevCvdAtHigh = prev.reduce((best, p) =>
    candles[p.index][2] >= candles[best.index][2] ? p : best
  )

  const takerBased = candles.some((c) => takerBuyVolume(c) != null)
  const labelSuffix = takerBased ? 'taker' : 'OHLCV-dist'
  const boost = takerBased ? 1.2 : 0.8

  // Bullish: lower low in price, higher low in CVD
  if (priceLow < prevPriceLow && cvdAtPriceLow.cvd > prevCvdAtLow.cvd) {
    return {
      detected: true,
      type: 'BULLISH',
      priceExtreme: priceLow,
      cvdExtreme: cvdAtPriceLow.cvd,
      lookback,
      scoreBoost: boost,
      label: `CVD Bull Div (${labelSuffix}): price LL, delta ↑ @ ${last.price.toFixed(4)}`,
      takerBased,
    }
  }

  // Bearish: higher high in price, lower high in CVD
  if (priceHigh > prevPriceHigh && cvdAtPriceHigh.cvd < prevCvdAtHigh.cvd) {
    return {
      detected: true,
      type: 'BEARISH',
      priceExtreme: priceHigh,
      cvdExtreme: cvdAtPriceHigh.cvd,
      lookback,
      scoreBoost: boost,
      label: `CVD Bear Div (${labelSuffix}): price HH, delta ↓ @ ${last.price.toFixed(4)}`,
      takerBased,
    }
  }

  return empty
}
