import type { OhlcvCandle } from '../../api/mexc'
import { HORIZONS } from './config'
import type { EventSide, HorizonOutcome, OutcomeKind } from './types'

function classify(
  side: EventSide,
  target: number | null,
  invalidation: number,
  bars: OhlcvCandle[]
): { result: OutcomeKind; barsToTarget: number | null } {
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i]!
    const invalidated = side === 'UP' ? c[4] < invalidation : c[4] > invalidation
    const hit =
      target != null && target > 0 && (side === 'UP' ? c[2] >= target : c[3] <= target)
    if (invalidated) return { result: 'invalidated', barsToTarget: null }
    if (hit) return { result: 'hit', barsToTarget: i + 1 }
  }
  return { result: 'undecided', barsToTarget: null }
}

function excursion(
  side: EventSide,
  entry: number,
  atr: number,
  bars: OhlcvCandle[]
): { mfeAtr: number; maeAtr: number } {
  if (!(atr > 0) || !bars.length) return { mfeAtr: 0, maeAtr: 0 }
  let fav = 0
  let adv = 0
  for (const c of bars) {
    if (side === 'UP') {
      fav = Math.max(fav, c[2] - entry)
      adv = Math.max(adv, entry - c[3])
    } else {
      fav = Math.max(fav, entry - c[3])
      adv = Math.max(adv, c[2] - entry)
    }
  }
  return { mfeAtr: fav / atr, maeAtr: adv / atr }
}

/** Future bars are strictly after the bar that revealed the event. */
export function labelOutcome(input: {
  side: EventSide
  entry: number
  target: number | null
  invalidation: number
  atr: number
  future: OhlcvCandle[]
}): HorizonOutcome[] {
  return HORIZONS.map((horizon) => {
    const bars = input.future.slice(0, horizon)
    const { result, barsToTarget } = classify(
      input.side,
      input.target,
      input.invalidation,
      bars
    )
    const { mfeAtr, maeAtr } = excursion(input.side, input.entry, input.atr, bars)
    return { horizon, result, mfeAtr, maeAtr, barsToTarget }
  })
}

export function resolvedBefore(
  side: EventSide,
  target: number | null,
  invalidation: number,
  bars: OhlcvCandle[]
): boolean {
  return classify(side, target, invalidation, bars).result !== 'undecided'
}
