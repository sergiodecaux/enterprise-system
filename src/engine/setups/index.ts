export type {
  SetupKind,
  SetupPrecondition,
  SetupPreconditionStatus,
  ConditionalSetup,
  ConditionalSetupStatus,
  WatchedSetup,
  TradeTargetLadder,
  TradeMagnet,
  TradeMagnetKind,
  TradeGlobalView,
  SetupTradeStyle,
} from './types'

export { buildConditionalSetups } from './buildConditionalSetups'
export type { BuildConditionalSetupsInput } from './buildConditionalSetups'

export {
  evaluateSetupReadiness,
  type SetupEvalCandles,
} from './evaluateSetupReadiness'
