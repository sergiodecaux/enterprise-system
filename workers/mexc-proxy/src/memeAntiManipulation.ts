/**
 * Confirmation gate for fading parabolic meme moves.
 * A single opposite 1m candle is a pullback, not a reversal.
 */

type Candle = [number, number, number, number, number, number]
type Side = 'LONG' | 'SHORT'

export interface MemeAntiManipulationResult {
  ok: boolean
  evidence: number
  required: number
  notes: string[]
}

function closed(candles: Candle[]): Candle[] {
  return candles.length >= 2 ? candles.slice(0, -1) : candles
}

function vwap(candles: Candle[]): number | null {
  let pv = 0
  let volume = 0
  for (const c of candles) {
    const v = Math.max(0, c[5])
    pv += ((c[2] + c[3] + c[4]) / 3) * v
    volume += v
  }
  return volume > 0 ? pv / volume : null
}

function count<T>(items: T[], predicate: (item: T) => boolean): number {
  return items.reduce((n, item) => n + (predicate(item) ? 1 : 0), 0)
}

export function assessMemeAntiManipulation(opts: {
  side: Side
  sessionChangePct: number
  candles: Candle[]
  bookImbalance: number | null
  persistentBook: 'ALIGNED' | 'AGAINST' | 'MIXED' | 'UNKNOWN'
  tapePattern: string
  oiChangePct?: number | null
  fundingPct?: number
}): MemeAntiManipulationResult {
  const fadingPump = opts.side === 'SHORT' && opts.sessionChangePct >= 6
  const fadingDump = opts.side === 'LONG' && opts.sessionChangePct <= -6
  if (!fadingPump && !fadingDump) {
    return { ok: true, evidence: 0, required: 0, notes: [] }
  }

  const c = closed(opts.candles).slice(-12)
  if (c.length < 8) {
    return {
      ok: false,
      evidence: 0,
      required: 4,
      notes: ['Анти-манипуляция: мало закрытых свечей для контртренда'],
    }
  }

  const last = c[c.length - 1]!
  const recent = c.slice(-5)
  const prior = c.slice(-10, -5)
  const localVwap = vwap(c.slice(-10))
  const evidence: string[] = []

  if (opts.side === 'SHORT') {
    const priorLow = Math.min(...prior.map((x) => x[3]))
    const recentHigh = Math.max(...recent.map((x) => x[2]))
    const priorHigh = Math.max(...prior.map((x) => x[2]))
    const red = count(recent, (x) => x[4] < x[1])
    const netDown = recent[recent.length - 1]![4] < recent[0]![1]

    if (last[4] < priorLow) evidence.push('CHoCH вниз')
    if (recentHigh < priorHigh && last[4] < last[1]) evidence.push('Lower High')
    if (localVwap != null && last[4] < localVwap) evidence.push('закреп ниже VWAP')
    if (red >= 3 && netDown) evidence.push('продажи держатся 3/5 свечей')
    if ((opts.bookImbalance ?? 0) <= -15) evidence.push('OBI за SHORT')
    if (opts.persistentBook === 'ALIGNED') evidence.push('стакан устойчиво за SHORT')
    if (
      opts.tapePattern === 'ENGULF_BEAR' ||
      opts.tapePattern === 'PINBAR_BEAR' ||
      opts.tapePattern === 'REJECT_HIGH'
    ) {
      evidence.push('сильная медвежья реакция')
    }
  } else {
    const priorHigh = Math.max(...prior.map((x) => x[2]))
    const recentLow = Math.min(...recent.map((x) => x[3]))
    const priorLow = Math.min(...prior.map((x) => x[3]))
    const green = count(recent, (x) => x[4] >= x[1])
    const netUp = recent[recent.length - 1]![4] > recent[0]![1]

    if (last[4] > priorHigh) evidence.push('CHoCH вверх')
    if (recentLow > priorLow && last[4] >= last[1]) evidence.push('Higher Low')
    if (localVwap != null && last[4] > localVwap) evidence.push('закреп выше VWAP')
    if (green >= 3 && netUp) evidence.push('покупки держатся 3/5 свечей')
    if ((opts.bookImbalance ?? 0) >= 15) evidence.push('OBI за LONG')
    if (opts.persistentBook === 'ALIGNED') evidence.push('стакан устойчиво за LONG')
    if (
      opts.tapePattern === 'ENGULF_BULL' ||
      opts.tapePattern === 'PINBAR_BULL' ||
      opts.tapePattern === 'REJECT_LOW'
    ) {
      evidence.push('сильная бычья реакция')
    }
  }

  const hasStructure = evidence.some(
    (x) =>
      x.startsWith('CHoCH') ||
      x === 'Lower High' ||
      x === 'Higher Low'
  )
  const bookSupports =
    opts.persistentBook === 'ALIGNED' ||
    (opts.side === 'SHORT'
      ? (opts.bookImbalance ?? 0) <= -15
      : (opts.bookImbalance ?? 0) >= 15)
  const squeezeRisk =
    (opts.side === 'SHORT' &&
      ((opts.oiChangePct ?? 0) >= 2 || (opts.fundingPct ?? 0) >= 0.03)) ||
    (opts.side === 'LONG' && (opts.oiChangePct ?? 0) >= 2)
  const required = squeezeRisk ? 4 : 3
  const ok = evidence.length >= required && hasStructure && bookSupports
  const direction = opts.side === 'SHORT' ? 'пампа' : 'дампа'

  return {
    ok,
    evidence: evidence.length,
    required,
    notes: [
      ok
        ? `Анти-манипуляция: разворот ${direction} подтверждён ${evidence.length}/${required}`
        : `Анти-манипуляция: это может быть откат внутри ${direction}, подтверждений ${evidence.length}/${required}`,
      ...(squeezeRisk
        ? [
            `Риск squeeze: OI ${opts.oiChangePct == null ? 'n/a' : `${opts.oiChangePct >= 0 ? '+' : ''}${opts.oiChangePct.toFixed(1)}%`} · funding ${(opts.fundingPct ?? 0).toFixed(3)}%`,
          ]
        : []),
      ...evidence.slice(0, 6),
    ],
  }
}
