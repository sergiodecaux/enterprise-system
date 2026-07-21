import type { OhlcvCandle } from '../../api/mexc'

/**
 * CVD (Cumulative Volume Delta) proxy из OHLCV:
 * бычья свеча → +volume, медвежья → −volume.
 * Для точной ленты нужен trade feed; proxy достаточен для дивергенции на LTF.
 */
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
}

export function computeCvdSeries(candles: OhlcvCandle[]): CvdPoint[] {
  let cvd = 0
  const points: CvdPoint[] = []

  for (let i = 0; i < candles.length; i++) {
    const [, open, , , close, volume] = candles[i]
    const delta = close >= open ? volume : -volume
    cvd += delta
    points.push({ index: i, cvd, price: close })
  }

  return points
}

/**
 * Бычья дивергенция: цена обновила low, CVD выше предыдущего low-CVD (продавцы истощены).
 * Медвежья: цена обновила high, CVD ниже предыдущего high-CVD.
 */
export function detectCvdDivergence(
  candles: OhlcvCandle[],
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

  // Bullish: lower low in price, higher low in CVD
  if (priceLow < prevPriceLow && cvdAtPriceLow.cvd > prevCvdAtLow.cvd) {
    return {
      detected: true,
      type: 'BULLISH',
      priceExtreme: priceLow,
      cvdExtreme: cvdAtPriceLow.cvd,
      lookback,
      scoreBoost: 1.2,
      label: `CVD Bull Div: price LL, delta ↑ @ ${last.price.toFixed(4)}`,
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
      scoreBoost: 1.2,
      label: `CVD Bear Div: price HH, delta ↓ @ ${last.price.toFixed(4)}`,
    }
  }

  return empty
}
