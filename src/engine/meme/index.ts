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
