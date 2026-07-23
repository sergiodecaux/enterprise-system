import type { PathPoint } from '../prediction/types'

export type SetupKind =
  | 'FORECAST_A'
  | 'FORECAST_B'
  | 'FORECAST_C'
  | 'MM_HUNT'
  | 'SURGICAL'
  | 'BOUNCE_SSL'
  | 'BOUNCE_BSL'
  | 'STOP_THEN_REVERSE'

export type SetupPreconditionStatus = 'PENDING' | 'MET' | 'FAILED'

export interface SetupPrecondition {
  id: string
  label: string
  status: SetupPreconditionStatus
}

export type ConditionalSetupStatus =
  | 'HYPOTHESIS'
  | 'ARMED'
  | 'READY'
  | 'INVALIDATED'
  | 'EXPIRED'

export interface ConditionalSetup {
  id: string
  kind: SetupKind
  side: 'LONG' | 'SHORT'
  title: string
  probability: number
  preconditions: SetupPrecondition[]
  entryZone: { top: number; bottom: number }
  limitEntry: number
  target: number
  invalidation: number
  triggerSummary: string
  reasoning: string[]
  chartPath?: PathPoint[]
  status: ConditionalSetupStatus
  /** Symbol for watch persistence */
  symbol?: string
  internalSymbol?: string
  createdAt: number
}

export interface WatchedSetup {
  watchId: string
  chatId: number
  symbol: string
  internalSymbol: string
  setup: ConditionalSetup
  createdAt: number
  expiresAt: number
  lastStatus: ConditionalSetupStatus
  readyNotified: boolean
  invalidatedNotified: boolean
  updatedAt: number
}
