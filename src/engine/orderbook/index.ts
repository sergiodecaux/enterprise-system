export { calculateOrderBookMetrics, detectWalls, detectImbalance } from './analyzer'
export {
  createHistory,
  addSnapshot,
  calculateImbalanceStats,
  getChartData,
} from './history'
export {
  createWallTracker,
  updateWalls,
  getRecentEvents,
} from './wallTracker'
export {
  createHeatmap,
  updateHeatmap,
  getHeatIntensity,
  getTopLevels,
  suggestPriceStep,
} from './heatmap'
export { calculateWallBoost, calculateWhaleBoost } from './scoreBooster'
export type { ScoreBoost } from './scoreBooster'
export {
  detectWhaleOrders,
  buildWhaleAlerts,
  updateWhaleWatcher,
  formatWhaleVolume,
  WHALE_THRESHOLD_USD,
  WHALE_ZONE_MAX_PCT,
  WHALE_ALERT_TTL_MS,
} from './whaleDetector'
export { createHeatmap3D, addSnapshot3D } from './heatmap3d'
export type { Heatmap3DState, Heatmap3DPoint } from './heatmap3d'

// Re-export MM orderbook helpers
export {
  calculateWeightedObi,
  detectPriceProdding,
  densityFromWalls,
  detectIcebergOrder,
  levelVolumeNear,
} from '../mm'
