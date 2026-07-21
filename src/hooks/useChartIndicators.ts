import { useMemo } from 'react'
import type { OhlcvCandle } from '../api/mexc'
import type { ChartIndicatorSettings } from '../engine/indicators/types'
import {
  calculateEmaSeries,
  calculateSmaSeries,
  calculateBollingerBands,
  calculateAtrSeries,
  calculateVwap,
  calculateVolumeSeries,
  calculateRsiSeries,
  calculateMacdSeries,
  calculateStochasticRsiSeries,
} from '../engine/indicators'

export function useChartIndicators(
  candles: OhlcvCandle[],
  settings: ChartIndicatorSettings
) {
  return useMemo(() => {
    if (candles.length === 0) {
      return {
        ema20: [],
        ema50: [],
        ema200: [],
        sma9: [],
        sma21: [],
        sma50: [],
        bollingerBands: [],
        vwap: [],
        rsi: [],
        macd: [],
        stochastic: [],
        atr: [],
        volume: [],
      }
    }

    return {
      ema20: settings.ema20 ? calculateEmaSeries(candles, 20) : [],
      ema50: settings.ema50 ? calculateEmaSeries(candles, 50) : [],
      ema200: settings.ema200 ? calculateEmaSeries(candles, 200) : [],
      sma9: settings.sma9 ? calculateSmaSeries(candles, 9) : [],
      sma21: settings.sma21 ? calculateSmaSeries(candles, 21) : [],
      sma50: settings.sma50 ? calculateSmaSeries(candles, 50) : [],
      bollingerBands: settings.bollingerBands ? calculateBollingerBands(candles) : [],
      vwap: settings.vwap ? calculateVwap(candles) : [],
      rsi: settings.rsi ? calculateRsiSeries(candles) : [],
      macd: settings.macd ? calculateMacdSeries(candles) : [],
      stochastic: settings.stochastic ? calculateStochasticRsiSeries(candles) : [],
      atr: settings.atr ? calculateAtrSeries(candles) : [],
      volume: settings.volume ? calculateVolumeSeries(candles) : [],
    }
  }, [candles, settings])
}
