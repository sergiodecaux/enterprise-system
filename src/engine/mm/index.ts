/**
 * Market Maker X-Ray: Effort vs Result, OBI, Spoof, Iceberg, Prodding, Triple Filter, BTC dump, Meme BE.
 */
export {
  detectEffortVsResult,
  priceChangePctOver,
  aggressionPctFromVolumes,
  aggressionPctFromRatio,
  type EffortVsResultInput,
  type EffortVsResultResult,
  type EffortTrapStatus,
} from './effortVsResult'

export {
  evaluateMemeBreakeven,
  enforceMemeTp1Floor,
  type MemeBreakevenInput,
  type MemeBreakevenResult,
} from './breakeven'

export {
  calculateWeightedObi,
  obiSupportsDirection,
  type WeightedObiLevel,
  type WeightedObiResult,
} from './obi'

export {
  detectSpoofFromDisappear,
  detectFleeingWall,
  isRealMmWall,
  spoofEventsFromWallUpdate,
  type SpoofAlert,
} from './spoofing'

export {
  detectIcebergOrder,
  levelVolumeNear,
  type IcebergResult,
} from './iceberg'

export {
  detectPriceProdding,
  densityFromWalls,
  type DensitySnapshot,
  type PriceProddingResult,
} from './priceProdding'

export {
  evaluateTripleFilter,
  mergeMmGates,
  type TripleFilterInput,
  type TripleFilterResult,
  type TripleFilterStatus,
} from './tripleFilter'

export {
  detectBtcDump,
  applyBtcDumpPenalty,
  type BtcDumpResult,
} from './btcDump'

export {
  computeMmIntent,
  buildLiquidityHuntPath,
  type MmIntentResult,
  type MmIntentInput,
  type MmDriveDirection,
  type LiquidityHuntLeg,
} from './mmIntent'
