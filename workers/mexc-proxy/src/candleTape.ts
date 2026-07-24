/**
 * Lightweight candle / tape reads for emit gates.
 * Not a full TA library — pinbar, engulf, rejection, late-impulse.
 */

type Candle = [number, number, number, number, number, number]
type Side = 'LONG' | 'SHORT'

export interface CandleTape {
  ok: boolean
  pattern: string
  note: string
  /** True if move already extended — do not chase */
  late: boolean
  scoreAdj: number
}

function body(c: Candle): number {
  return Math.abs(c[4] - c[1])
}

function range(c: Candle): number {
  return Math.max(c[2] - c[3], 1e-12)
}

function isBull(c: Candle): boolean {
  return c[4] >= c[1]
}

function isBear(c: Candle): boolean {
  return c[4] < c[1]
}

/** Last closed candle (exclude forming) */
function closed(candles: Candle[]): Candle[] {
  return candles.length >= 2 ? candles.slice(0, -1) : candles
}

/**
 * Detect if impulse already ran away — chase risk.
 * LONG late: last 4 closed bars net ≥ thr% up with little pullback.
 */
export function isImpulseLate(
  candles: Candle[],
  side: Side,
  thrPct = 2.2
): boolean {
  const c = closed(candles)
  if (c.length < 6) return false
  const slice = c.slice(-5)
  const a = slice[0]![4]
  const b = slice[slice.length - 1]![4]
  if (!(a > 0)) return false
  const move = ((b - a) / a) * 100
  if (side === 'LONG') {
    if (move < thrPct) return false
    // No meaningful dip in the run
    const lows = slice.map((x) => x[3])
    const minLow = Math.min(...lows)
    const retrace = ((b - minLow) / b) * 100
    return retrace < thrPct * 0.35
  }
  if (move > -thrPct) return false
  const highs = slice.map((x) => x[2])
  const maxHigh = Math.max(...highs)
  const retrace = ((maxHigh - b) / b) * 100
  return retrace < thrPct * 0.35
}

/**
 * Read last 1–3 closed candles for side confirmation.
 */
export function readCandleTape(
  candles: Candle[],
  side: Side
): CandleTape {
  const c = closed(candles)
  if (c.length < 3) {
    return {
      ok: true,
      pattern: 'NONE',
      note: 'свечей мало',
      late: false,
      scoreAdj: 0,
    }
  }

  const late = isImpulseLate(candles, side, side === 'LONG' ? 2.4 : 2.4)
  if (late) {
    return {
      ok: false,
      pattern: 'LATE_IMPULSE',
      note:
        side === 'LONG'
          ? 'поздно: импульс вверх уже прошёл — не догонять'
          : 'поздно: импульс вниз уже прошёл — не догонять',
      late: true,
      scoreAdj: -12,
    }
  }

  const cur = c[c.length - 1]!
  const prev = c[c.length - 2]!
  const r = range(cur)
  const b = body(cur)
  const upper = (cur[2] - Math.max(cur[1], cur[4])) / r
  const lower = (Math.min(cur[1], cur[4]) - cur[3]) / r

  // Bullish pinbar / hammer
  if (side === 'LONG' && lower >= 0.55 && b / r <= 0.35 && upper <= 0.25) {
    return {
      ok: true,
      pattern: 'PINBAR_BULL',
      note: 'пинбар/молот — откуп снизу',
      late: false,
      scoreAdj: 5,
    }
  }
  // Bearish pinbar / shooting star
  if (side === 'SHORT' && upper >= 0.55 && b / r <= 0.35 && lower <= 0.25) {
    return {
      ok: true,
      pattern: 'PINBAR_BEAR',
      note: 'пинбар/падающая звезда — предложение сверху',
      late: false,
      scoreAdj: 5,
    }
  }

  // Engulfing
  if (
    side === 'LONG' &&
    isBear(prev) &&
    isBull(cur) &&
    cur[4] >= prev[1] &&
    cur[1] <= prev[4] &&
    body(cur) > body(prev) * 0.9
  ) {
    return {
      ok: true,
      pattern: 'ENGULF_BULL',
      note: 'бычье поглощение',
      late: false,
      scoreAdj: 6,
    }
  }
  if (
    side === 'SHORT' &&
    isBull(prev) &&
    isBear(cur) &&
    cur[4] <= prev[1] &&
    cur[1] >= prev[4] &&
    body(cur) > body(prev) * 0.9
  ) {
    return {
      ok: true,
      pattern: 'ENGULF_BEAR',
      note: 'медвежье поглощение',
      late: false,
      scoreAdj: 6,
    }
  }

  // Rejection wick at high/low of last 3
  if (side === 'LONG' && lower >= 0.4 && isBull(cur)) {
    return {
      ok: true,
      pattern: 'REJECT_LOW',
      note: 'отбой от лоя · закрытие выше',
      late: false,
      scoreAdj: 3,
    }
  }
  if (side === 'SHORT' && upper >= 0.4 && isBear(cur)) {
    return {
      ok: true,
      pattern: 'REJECT_HIGH',
      note: 'отбой от хая · закрытие ниже',
      late: false,
      scoreAdj: 3,
    }
  }

  // Soft: close color aligns
  if (side === 'LONG' && isBull(cur)) {
    return {
      ok: true,
      pattern: 'CLOSE_BULL',
      note: 'последняя свеча зелёная',
      late: false,
      scoreAdj: 1,
    }
  }
  if (side === 'SHORT' && isBear(cur)) {
    return {
      ok: true,
      pattern: 'CLOSE_BEAR',
      note: 'последняя свеча красная',
      late: false,
      scoreAdj: 1,
    }
  }

  // Against close — weak veto for sniper, soft for meme
  if (side === 'LONG' && isBear(cur) && upper >= 0.35) {
    return {
      ok: false,
      pattern: 'AGAINST_BEAR',
      note: 'свеча против лонга (медвежий отбой)',
      late: false,
      scoreAdj: -6,
    }
  }
  if (side === 'SHORT' && isBull(cur) && lower >= 0.35) {
    return {
      ok: false,
      pattern: 'AGAINST_BULL',
      note: 'свеча против шорта (бычий отбой)',
      late: false,
      scoreAdj: -6,
    }
  }

  return {
    ok: true,
    pattern: 'NEUTRAL',
    note: 'свечной фон нейтрален',
    late: false,
    scoreAdj: 0,
  }
}
