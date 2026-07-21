import type { OhlcvCandle } from '../../api/mexc'

export interface VolatilityGaugeResult {
  /** 0–100 спидометр */
  gauge: number
  lastCandleMovePct: number
  zone: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED'
  label: string
}

/**
 * Volatility Gauge: % движения последней 1m свечи → стрелка спидометра.
 * 5%+ за 1m = красная зона.
 */
export function calculateVolatilityGauge(
  ohlcv1m: OhlcvCandle[]
): VolatilityGaugeResult {
  if (ohlcv1m.length < 2) {
    return {
      gauge: 0,
      lastCandleMovePct: 0,
      zone: 'GREEN',
      label: 'Нет данных',
    }
  }

  const last = ohlcv1m[ohlcv1m.length - 1]
  const movePct = Math.abs((last[2] - last[3]) / last[4]) * 100

  // Map 0–5%+ → 0–100
  const gauge = Math.min(100, Math.round((movePct / 5) * 100))

  let zone: VolatilityGaugeResult['zone'] = 'GREEN'
  if (movePct >= 5) zone = 'RED'
  else if (movePct >= 3) zone = 'ORANGE'
  else if (movePct >= 1.5) zone = 'YELLOW'

  return {
    gauge,
    lastCandleMovePct: movePct,
    zone,
    label:
      zone === 'RED'
        ? `🚨 VOL ${movePct.toFixed(1)}%/1m — безумный риск`
        : zone === 'ORANGE'
          ? `🔥 VOL ${movePct.toFixed(1)}%/1m`
          : zone === 'YELLOW'
            ? `⚡ VOL ${movePct.toFixed(1)}%/1m`
            : `VOL ${movePct.toFixed(1)}%/1m`,
  }
}
