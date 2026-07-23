import type { WeightedObiResult } from './obi'
import type { EffortVsResultResult } from './effortVsResult'

export type TripleFilterStatus =
  | 'CONFIRMED'
  | 'MM_DISTRIBUTION'
  | 'INCOMPLETE'
  | 'NONE'

export interface TripleFilterInput {
  direction: 'LONG' | 'SHORT'
  /** Tape: buyers/sellers aggressive */
  aggressionAligned: boolean
  /** Book: near-touch OBI supports direction */
  obiAligned: boolean
  /** Price actually moving in our direction */
  priceResultOk: boolean
  /** Buyer aggression pct (for messaging) */
  buyerAggressionPct?: number
}

export interface TripleFilterResult {
  status: TripleFilterStatus
  passed: boolean
  label: string
  emoji: string
  reason: string
  /** Force score down when MM distribution */
  scoreOverride: number | null
}

/**
 * Triple Confirmation: Лента + Стакан + Результат цены.
 * Агрессия + OBI без роста цены = скрытое распределение ММ.
 */
export function evaluateTripleFilter(
  input: TripleFilterInput
): TripleFilterResult {
  const { aggressionAligned, obiAligned, priceResultOk, direction } = input

  if (aggressionAligned && obiAligned && priceResultOk) {
    return {
      status: 'CONFIRMED',
      passed: true,
      emoji: '🎯',
      label: 'TRIPLE CONFIRMED',
      reason: 'Агрессия + дисбаланс стакана + цена идёт в нашу сторону.',
      scoreOverride: null,
    }
  }

  if (aggressionAligned && obiAligned && !priceResultOk) {
    return {
      status: 'MM_DISTRIBUTION',
      passed: false,
      emoji: '⚠️',
      label: 'MM DISTRIBUTION',
      reason:
        direction === 'LONG'
          ? 'Сканер видит скрытые продажи ММ. Толпа бьётся о лимиты — сигнал аннулирован.'
          : 'Скрытые покупки ММ против шортов — сигнал аннулирован.',
      scoreOverride: 10,
    }
  }

  return {
    status: 'INCOMPLETE',
    passed: false,
    emoji: '⏳',
    label: 'TRIPLE INCOMPLETE',
    reason: 'Нет полного подтверждения (лента ∩ стакан ∩ цена).',
    scoreOverride: null,
  }
}

/** Merge effort trap + triple into one gate decision */
export function mergeMmGates(
  effort: EffortVsResultResult,
  triple: TripleFilterResult,
  obi: WeightedObiResult | null
): {
  blocked: boolean
  scoreOverride: number | null
  status: string
  recommendation: string
} {
  if (effort.detected && effort.scoreOverride != null) {
    return {
      blocked: true,
      scoreOverride: effort.scoreOverride,
      status: effort.label,
      recommendation: `${effort.emoji} ${effort.label}: ${effort.reason}`,
    }
  }
  if (triple.status === 'MM_DISTRIBUTION' && triple.scoreOverride != null) {
    return {
      blocked: true,
      scoreOverride: triple.scoreOverride,
      status: triple.label,
      recommendation: `${triple.emoji} ${triple.label}: ${triple.reason}`,
    }
  }
  if (triple.passed) {
    return {
      blocked: false,
      scoreOverride: null,
      status: triple.label,
      recommendation: `${triple.emoji} ${triple.reason}${obi ? ` | ${obi.label}` : ''}`,
    }
  }
  return {
    blocked: false,
    scoreOverride: null,
    status: '',
    recommendation: '',
  }
}
