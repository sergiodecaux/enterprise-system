import type { Time } from 'lightweight-charts'

// ============================================================================
// Indicator Series Types
// ============================================================================

export interface IndicatorPoint {
  time: Time
  value: number
}

export interface BollingerBandsPoint {
  time: Time
  upper: number
  middle: number
  lower: number
}

export interface MACDPoint {
  time: Time
  macd: number
  signal: number
  histogram: number
}

export interface VolumePoint {
  time: Time
  value: number
  color?: string
}

// ============================================================================
// Liquidity Zone Types
// ============================================================================

export interface LiquidityZone {
  id: string
  type: 'ORDER_BLOCK' | 'FVG' | 'FIBONACCI' | 'POC' | 'VALUE_AREA' | 'DAILY' | 'OTE'
  side: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  top: number
  bottom: number
  startTime: Time
  endTime?: Time
  strength?: number
  label?: string
}

// ============================================================================
// Price Level Types
// ============================================================================

export interface PriceLevel {
  id: string
  type: 'SL' | 'TP1' | 'TP2' | 'TP_DAILY' | 'FIB_618' | 'FIB_786' | 'FIB_OTE' | 'DAILY_HIGH' | 'DAILY_LOW' | 'DAILY_CLOSE' | 'INVALIDATION'
  price: number
  label: string
  color: string
  lineStyle?: 0 | 1 | 2 | 3 | 4
}

// ============================================================================
// Chart Preferences
// ============================================================================

export interface ChartIndicatorSettings {
  ema20: boolean
  ema50: boolean
  ema200: boolean
  sma9: boolean
  sma21: boolean
  sma50: boolean
  bollingerBands: boolean
  vwap: boolean
  rsi: boolean
  macd: boolean
  stochastic: boolean
  atr: boolean
  volume: boolean
}

export interface ChartZoneSettings {
  orderBlocks: boolean
  fvg: boolean
  fibonacci: boolean
  poc: boolean
  valueArea: boolean
  dailyLevels: boolean
}

export interface ChartPreferences {
  indicators: ChartIndicatorSettings
  zones: ChartZoneSettings
  opacity: number
  showLabels: boolean
}

export const DEFAULT_CHART_PREFERENCES: ChartPreferences = {
  indicators: {
    ema20: true,
    ema50: false,
    ema200: false,
    sma9: false,
    sma21: false,
    sma50: false,
    bollingerBands: false,
    vwap: false,
    rsi: false,
    macd: false,
    stochastic: false,
    atr: false,
    volume: true,
  },
  zones: {
    orderBlocks: true,
    fvg: false,
    fibonacci: true,
    poc: false,
    valueArea: false,
    dailyLevels: false,
  },
  opacity: 18,
  showLabels: false,
}
