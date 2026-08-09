/**
 * Back-compat shim — HIT baseline lives in sigmaBaseline (HIT/DELTA/WALL).
 */
export {
  recordHitSample,
  seedHitBaselineFromCandles,
  getHitZScore,
  passesAnomalyGate,
  type HitZScore,
} from './sigmaBaseline'
