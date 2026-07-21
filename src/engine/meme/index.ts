export { detectVolumeDeltaSpike, type VolumeSpikeResult } from './volumeSpike'
export { analyzeLiquidityGap, type LiquidityGapResult } from './liquidityGap'
export { detectMeanReversion, type MeanReversionResult } from './meanReversion'
export {
  analyzeSpreadPressure,
  isAggressionFading,
  type SpreadPressureResult,
} from './spreadPressure'
export {
  filterMemeTickers,
  isMemeTicker,
  prioritizeMemeBatch,
} from './memeFilter'
export { analyzeMemeMarketData, computeMemeHeatScore } from './analyzer'
export { buildMemeCoinSignal } from './memeSignalBuilder'
export { detectShortSqueeze, type SqueezeResult } from './squeeze'
export { detectMemeLifecycle, type LifecycleResult, type MemeLifecyclePhase } from './lifecycle'
export { detectBidVoid, type BidVoidResult } from './bidVoid'
export { detectFlatlineBreakout, type FlatlineResult } from './flatline'
export { detectToxicChop, type ToxicResult } from './toxic'
export { detectBacksideShort, type BacksideResult } from './backside'
export {
  detectIcebergAbsorption,
  type AbsorptionAlertResult,
} from './absorptionAlert'
export { detectCvdTrap, type CvdTrapResult } from './cvdTrap'
export {
  calculateVolatilityGauge,
  type VolatilityGaugeResult,
} from './volatility'

export const TOP_MEME_COUNT = 10

/** @deprecated Используй filterMemeTickers(fetchTickers()) — динамический список с биржи */
export const MEME_WATCHLIST = [
  'PEPE/USDT:USDT',
  'SHIB/USDT:USDT',
  'DOGE/USDT:USDT',
  'FLOKI/USDT:USDT',
  'BONK/USDT:USDT',
  'WIF/USDT:USDT',
  'MEME/USDT:USDT',
  'PEPE2/USDT:USDT',
  'BABYDOGE/USDT:USDT',
  'ELON/USDT:USDT',
] as const
