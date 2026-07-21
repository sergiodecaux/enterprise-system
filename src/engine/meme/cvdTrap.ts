import type { OhlcvCandle } from '../../api/mexc'
import { detectCvdDivergence, computeCvdSeries } from '../orderflow/cvd'

export interface CvdTrapResult {
  detected: boolean
  type: 'ABSORPTION_LONG' | 'NONE'
  priceRangePct: number
  cvdSlope: number
  scoreBoost: number
  label: string
  emoji: string
  alert: string | null
}

/**
 * CVD Trap: цена в узком боковике на хаях, CVD жёстко падает → ММ скупает шорты.
 */
export function detectCvdTrap(ohlcv1m: OhlcvCandle[]): CvdTrapResult {
  const empty: CvdTrapResult = {
    detected: false,
    type: 'NONE',
    priceRangePct: 0,
    cvdSlope: 0,
    scoreBoost: 0,
    label: '',
    emoji: '',
    alert: null,
  }

  if (ohlcv1m.length < 25) return empty

  const window = ohlcv1m.slice(-15)
  const high = Math.max(...window.map((c) => c[2]))
  const low = Math.min(...window.map((c) => c[3]))
  const mid = (high + low) / 2
  const rangePct = mid > 0 ? ((high - low) / mid) * 100 : 100

  // Near local highs of larger window
  const wider = ohlcv1m.slice(-60)
  const widerHigh = Math.max(...wider.map((c) => c[2]))
  const nearHigh = high >= widerHigh * 0.98

  const series = computeCvdSeries(window)
  if (series.length < 5) return empty
  const first = series[0].cvd
  const last = series[series.length - 1].cvd
  const cvdSlope = last - first

  const div = detectCvdDivergence(ohlcv1m, 20)

  if (nearHigh && rangePct <= 2.5 && cvdSlope < 0) {
    const absDrop = Math.abs(cvdSlope)
    const significant =
      absDrop > series.reduce((s, p) => s + Math.abs(p.cvd), 0) * 0.02 ||
      div.type === 'BULLISH'

    if (significant || Math.abs(cvdSlope) > 0) {
      // Need meaningful sell pressure vs flat price
      const sellHeavy = cvdSlope < 0 && rangePct <= 2.5
      if (sellHeavy) {
        return {
          detected: true,
          type: 'ABSORPTION_LONG',
          priceRangePct: rangePct,
          cvdSlope,
          scoreBoost: 28,
          emoji: '🎯',
          label: `CVD TRAP LONG | range ${rangePct.toFixed(1)}% CVD ↓`,
          alert:
            '🎯 ABSORPTION LONG (CVD Trap): шорты впитываются. Вероятность выстрела вверх высока.',
        }
      }
    }
  }

  return { ...empty, priceRangePct: rangePct, cvdSlope }
}
