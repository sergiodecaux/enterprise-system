/**
 * First-class idea status: ALIVE / WATCH / DEAD.
 */

import type { CoinSignal } from '../types'
import { evaluateReadyGate } from './readyGate'

export type IdeaLife = 'ALIVE' | 'WATCH' | 'DEAD'

export interface IdeaStatus {
  life: IdeaLife
  label: string
  reason: string
  invalidationPrice: number | null
  invalidationMessage: string | null
}

export function evaluateIdeaStatus(signal: CoinSignal): IdeaStatus {
  const surg = signal.surgicalEntry?.status
  const invPrice =
    signal.surgicalEntry?.invalidation ??
    signal.invalidationPrice ??
    signal.sl ??
    null
  const invMsg =
    signal.invalidationMessage ??
    (invPrice != null ? `Слом за ${invPrice}` : null)

  if (surg === 'INVALIDATED' || surg === 'MISSED') {
    return {
      life: 'DEAD',
      label: 'Идея мертва',
      reason: surg === 'MISSED' ? 'Вход пропущен' : 'Surgical INVALIDATED',
      invalidationPrice: invPrice,
      invalidationMessage: invMsg,
    }
  }

  if (signal.scoreCard?.grade === 'SKIP' && !signal.hasActiveSetup) {
    return {
      life: 'DEAD',
      label: 'Идея мертва',
      reason: 'ScoreCard SKIP',
      invalidationPrice: invPrice,
      invalidationMessage:
        signal.scoreCard.missingFactors.slice(0, 2).join(' · ') || invMsg,
    }
  }

  const gate = evaluateReadyGate(signal)
  if (gate.ready || surg === 'READY' || signal.hasActiveSetup) {
    return {
      life: 'ALIVE',
      label: 'Идея жива',
      reason: gate.ready ? gate.summary : 'Активный сетап / Surgical READY',
      invalidationPrice: invPrice,
      invalidationMessage: invMsg,
    }
  }

  if (
    surg === 'WAITING_SWEEP' ||
    surg === 'WAITING_CONFIRM' ||
    gate.passCount >= 1
  ) {
    return {
      life: 'WATCH',
      label: 'Под вопросом',
      reason: gate.summary,
      invalidationPrice: invPrice,
      invalidationMessage: invMsg,
    }
  }

  return {
    life: 'WATCH',
    label: 'Под вопросом',
    reason: 'Условий мало — следить за зоной',
    invalidationPrice: invPrice,
    invalidationMessage: invMsg,
  }
}
