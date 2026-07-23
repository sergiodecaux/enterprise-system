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
  summarizeMemeUniverse,
  MIN_VOLUME_USD,
  MAX_MEME_PRICE,
  MIN_OPEN_INTEREST,
} from './memeFilter'
export type { MemeUniverseStats, MemeRejectReason } from './memeFilter'
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

export const TOP_MEME_COUNT = 40

/** Сколько монет deep-scan'ить за один цикл (round-robin по всей вселенной) */
export const MEME_BATCH_SIZE = 18

/** Сигналы старше этого TTL выкидываем из радара */
export const MEME_SIGNAL_TTL_MS = 12 * 60 * 1000
