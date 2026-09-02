/**
 * MM trap thesis: where the crowd hangs, what the last closes actually did,
 * and whether the “BOS up” is a trade or a stop-hunt.
 *
 * Trade = swept liquidity + close reclaimed the level.
 * Forecast = first assume they will take the nearer crowd, then reverse.
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { LiqHeatmapModel } from '../derivatives/liqHeatmap'
import type { Fib141Reaction, TfStructure } from './structureRead'

export type CloseQuality =
  | 'DISPLACEMENT_UP'
  | 'DISPLACEMENT_DOWN'
  | 'REJECT_HIGH'
  | 'REJECT_LOW'
  | 'INDECISION'
  | 'NORMAL'

export type TrapPhase =
  | 'HUNTING'
  | 'SWEPT'
  | 'TRAP'
  | 'TRADE_READY'
  | 'NEUTRAL'

export interface MmTrapThesis {
  phase: TrapPhase
  /** Side MM is likely trapping / feeding */
  trapSide: 'LONG' | 'SHORT' | null
  /** Only set when a reclaim is actually in place */
  tradeSide: 'LONG' | 'SHORT' | null
  /** Direction of the current hunt (path), not a trade */
  huntSide: 'LONG' | 'SHORT' | null
  swept: { price: number; kind: 'SSL' | 'BSL'; barsAgo: number } | null
  reclaimLevel: number | null
  weaknessLevel: number | null
  crowdLongs: number | null
  crowdShorts: number | null
  closeQuality: CloseQuality
  summary: string
  forecast: string
  factors: string[]
}

function fmt(p: number): string {
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}

function pct(a: number, b: number): number {
  if (!(b > 0)) return 99
  return (Math.abs(a - b) / b) * 100
}

export function readCloseQuality(c: OhlcvCandle | undefined): CloseQuality {
  if (!c) return 'INDECISION'
  const [, o, h, l, close] = c
  const range = h - l
  if (!(range > 0)) return 'INDECISION'
  const body = Math.abs(close - o)
  const bodyPct = body / range
  const wickUp = h - Math.max(close, o)
  const wickDn = Math.min(close, o) - l
  const closePos = (close - l) / range
  if (wickUp / range >= 0.42 && closePos <= 0.48) return 'REJECT_HIGH'
  if (wickDn / range >= 0.42 && closePos >= 0.52) return 'REJECT_LOW'
  if (bodyPct >= 0.6 && close > o && closePos >= 0.68) return 'DISPLACEMENT_UP'
  if (bodyPct >= 0.6 && close < o && closePos <= 0.32) return 'DISPLACEMENT_DOWN'
  if (bodyPct < 0.22) return 'INDECISION'
  return 'NORMAL'
}

function nearestBelow(price: number, xs: number[]): number | null {
  const below = xs.filter((p) => p < price && pct(p, price) <= 3.5)
  if (!below.length) return null
  return below.reduce((a, b) => (price - a < price - b ? a : b))
}

function nearestAbove(price: number, xs: number[]): number | null {
  const above = xs.filter((p) => p > price && pct(p, price) <= 3.5)
  if (!above.length) return null
  return above.reduce((a, b) => (a - price < b - price ? a : b))
}

function lastSweepFrom(tf: TfStructure | null, candles: OhlcvCandle[]): MmTrapThesis['swept'] {
  if (!tf) return null
  const last = candles[candles.length - 1]
  const atrPad = last ? Math.max(last[2] - last[3], last[4] * 0.0015) : 0

  if (tf.lastSweep) {
    const kind: 'SSL' | 'BSL' = tf.lastSweep.side === 'DOWN' ? 'SSL' : 'BSL'
    const barsAgo = Math.max(0, candles.length - 1 - tf.lastSweep.index)
    if (barsAgo <= 12) {
      return { price: tf.lastSweep.price, kind, barsAgo }
    }
  }

  const q = readCloseQuality(last)
  if (q === 'REJECT_LOW' && tf.lastSwingLow && last) {
    if (last[3] <= tf.lastSwingLow.price + atrPad * 0.2) {
      return { price: tf.lastSwingLow.price, kind: 'SSL', barsAgo: 0 }
    }
  }
  if (q === 'REJECT_HIGH' && tf.lastSwingHigh && last) {
    if (last[2] >= tf.lastSwingHigh.price - atrPad * 0.2) {
      return { price: tf.lastSwingHigh.price, kind: 'BSL', barsAgo: 0 }
    }
  }
  return null
}

function htfFightsLong(h4: TfStructure | null, d1: TfStructure | null): boolean {
  const h4Down = h4?.trend === 'BEARISH' || h4?.lastChoch?.side === 'DOWN'
  const dDown = d1?.trend === 'BEARISH'
  return Boolean(h4Down || dDown)
}

function htfFightsShort(h4: TfStructure | null, d1: TfStructure | null): boolean {
  const h4Up = h4?.trend === 'BULLISH' || h4?.lastChoch?.side === 'UP'
  const dUp = d1?.trend === 'BULLISH'
  return Boolean(h4Up || dUp)
}

export function buildMmTrapThesis(input: {
  price: number
  candles1h?: OhlcvCandle[]
  h1: TfStructure | null
  h4: TfStructure | null
  d1: TfStructure | null
  fib?: Fib141Reaction | null
  liq?: LiqHeatmapModel | null
}): MmTrapThesis {
  const { price, h1, h4, d1, liq } = input
  const candles = input.candles1h ?? []
  const last = candles[candles.length - 1]
  const closeQuality = readCloseQuality(last)
  const factors: string[] = []
  if (input.fib?.state === 'INSIDE' && (h1?.inPremium || d1?.inPremium)) {
    factors.push('цена в 141 в премиуме — типичная зона развода лонгов')
  }
  if (input.fib?.state === 'INSIDE' && (h1?.inDiscount || d1?.inDiscount)) {
    factors.push('цена в 141 в дисконте — зона охоты на шорты или лонг с закрепа')
  }

  const crowdLongs = nearestBelow(price, [
    ...(liq?.longClusters.map((c) => c.price) ?? []),
    ...(liq?.nearestLongLiq != null ? [liq.nearestLongLiq] : []),
    ...(h1?.lastSwingLow ? [h1.lastSwingLow.price] : []),
  ])
  const crowdShorts = nearestAbove(price, [
    ...(liq?.shortClusters.map((c) => c.price) ?? []),
    ...(liq?.nearestShortLiq != null ? [liq.nearestShortLiq] : []),
    ...(h1?.lastSwingHigh ? [h1.lastSwingHigh.price] : []),
  ])

  const swept = lastSweepFrom(h1, candles)
  const bosUp = h1?.lastBos?.side === 'UP' && h1.lastBos.held
  const bosDown = h1?.lastBos?.side === 'DOWN' && h1.lastBos.held
  const premium = Boolean(h1?.inPremium || d1?.inPremium)
  const discount = Boolean(h1?.inDiscount || d1?.inDiscount)
  const closeIsRealUp = closeQuality === 'DISPLACEMENT_UP'
  const closeIsRealDown = closeQuality === 'DISPLACEMENT_DOWN'
  const closeIsFake =
    closeQuality === 'REJECT_HIGH' ||
    closeQuality === 'REJECT_LOW' ||
    closeQuality === 'INDECISION'

  if (crowdLongs != null) {
    factors.push(`лонги висят ~${fmt(crowdLongs)}`)
  }
  if (crowdShorts != null) {
    factors.push(`шорты висят ~${fmt(crowdShorts)}`)
  }
  if (closeQuality === 'REJECT_HIGH') factors.push('час закрылся фитилём сверху — хаи не приняли')
  else if (closeQuality === 'REJECT_LOW') factors.push('час закрылся фитилём снизу — лои сняли и вернули')
  else if (closeQuality === 'DISPLACEMENT_UP') factors.push('час закрылся телом вверх — смещение настоящее')
  else if (closeQuality === 'DISPLACEMENT_DOWN') factors.push('час закрылся телом вниз — смещение настоящее')
  else if (closeQuality === 'INDECISION') factors.push('час доджи — BOS не доверять')

  const distShorts = crowdShorts != null ? pct(crowdShorts, price) : 99
  const distLongs = crowdLongs != null ? pct(crowdLongs, price) : 99
  const huntShorts = distShorts <= 1.35 && distShorts <= distLongs
  const huntLongs = distLongs <= 1.35 && distLongs < distShorts

  let phase: TrapPhase = 'NEUTRAL'
  let trapSide: 'LONG' | 'SHORT' | null = null
  let tradeSide: 'LONG' | 'SHORT' | null = null
  let huntSide: 'LONG' | 'SHORT' | null = null
  let reclaimLevel: number | null = null
  let weaknessLevel: number | null = null

  // 1) Fresh sweep: wait for reclaim, don't chase the wick
  if (swept?.kind === 'SSL') {
    reclaimLevel = swept.price
    weaknessLevel = h1?.lastSwingLow?.price ?? swept.price
    const held =
      last != null &&
      last[4] > swept.price &&
      (closeIsRealUp || (h1?.lastReclaim?.side === 'UP' && h1.lastReclaim.held))
    if (held && !htfFightsLong(h4, d1)) {
      phase = 'TRADE_READY'
      tradeSide = 'LONG'
      trapSide = 'SHORT'
      huntSide = 'LONG'
      factors.push(`сняли SSL ${fmt(swept.price)} и закрылись выше — лонг по факту`)
    } else {
      phase = 'SWEPT'
      trapSide = 'LONG'
      huntSide = held ? 'LONG' : 'SHORT'
      factors.push(
        held
          ? `сняли SSL, но HTF против — лонг рано`
          : `сняли SSL ${fmt(swept.price)} — лонг только после закрепа над уровнем`
      )
    }
  } else if (swept?.kind === 'BSL') {
    reclaimLevel = swept.price
    weaknessLevel = h1?.lastSwingHigh?.price ?? swept.price
    const held =
      last != null &&
      last[4] < swept.price &&
      (closeIsRealDown || (h1?.lastReclaim?.side === 'DOWN' && h1.lastReclaim.held))
    if (held && !htfFightsShort(h4, d1)) {
      phase = 'TRADE_READY'
      tradeSide = 'SHORT'
      trapSide = 'LONG'
      huntSide = 'SHORT'
      factors.push(`сняли BSL ${fmt(swept.price)} и закрылись ниже — шорт по факту`)
    } else {
      phase = 'SWEPT'
      trapSide = 'SHORT'
      huntSide = held ? 'SHORT' : 'LONG'
      factors.push(
        held
          ? `сняли BSL, но HTF против — шорт рано`
          : `сняли BSL ${fmt(swept.price)} — шорт только после закрепа под уровнем`
      )
    }
  }

  // 2) No confirmed sweep: BOS toward the crowd is usually the trap
  if (phase === 'NEUTRAL') {
    const fakeLong =
      (bosUp || h1?.trend === 'BULLISH') &&
      (closeIsFake || closeQuality === 'NORMAL') &&
      !closeIsRealUp &&
      (premium || htfFightsLong(h4, d1) || huntShorts || Boolean(crowdLongs && distLongs < 0.8))
    const fakeShort =
      (bosDown || h1?.trend === 'BEARISH') &&
      (closeIsFake || closeQuality === 'NORMAL') &&
      !closeIsRealDown &&
      (discount || htfFightsShort(h4, d1) || huntLongs || Boolean(crowdShorts && distShorts < 0.8))

    if (fakeLong) {
      phase = 'TRAP'
      trapSide = 'LONG'
      huntSide = huntShorts ? 'LONG' : crowdLongs != null ? 'SHORT' : 'LONG'
      reclaimLevel = h1?.lastBos?.price ?? h1?.lastSwingLow?.price ?? null
      weaknessLevel = h1?.lastSwingHigh?.price ?? crowdShorts
      factors.push('BOS вверх без смещения телом — кормят лонги')
    } else if (fakeShort) {
      phase = 'TRAP'
      trapSide = 'SHORT'
      huntSide = huntLongs ? 'SHORT' : crowdShorts != null ? 'LONG' : 'SHORT'
      reclaimLevel = h1?.lastBos?.price ?? h1?.lastSwingHigh?.price ?? null
      weaknessLevel = h1?.lastSwingLow?.price ?? crowdLongs
      factors.push('BOS вниз без смещения телом — кормят шорты')
    } else if (huntShorts) {
      phase = 'HUNTING'
      trapSide = 'SHORT'
      huntSide = 'LONG'
      reclaimLevel = h1?.lastSwingHigh?.price ?? crowdShorts
      weaknessLevel = crowdShorts
      factors.push(`ближе шорты @ ${fmt(crowdShorts!)} — сначала охота вверх, не лонг`)
    } else if (huntLongs) {
      phase = 'HUNTING'
      trapSide = 'LONG'
      huntSide = 'SHORT'
      reclaimLevel = h1?.lastSwingLow?.price ?? crowdLongs
      weaknessLevel = crowdLongs
      factors.push(`ближе лонги @ ${fmt(crowdLongs!)} — сначала охота вниз, не шорт`)
    } else if (closeIsRealUp && bosUp && !htfFightsLong(h4, d1) && discount) {
      phase = 'TRADE_READY'
      tradeSide = 'LONG'
      huntSide = 'LONG'
      reclaimLevel = h1?.lastBos?.price ?? h1?.lastSwingLow?.price ?? null
      weaknessLevel = h1?.lastSwingLow?.price ?? null
      factors.push('смещение вверх в дисконте — лонг имеет право')
    } else if (closeIsRealDown && bosDown && !htfFightsShort(h4, d1) && premium) {
      phase = 'TRADE_READY'
      tradeSide = 'SHORT'
      huntSide = 'SHORT'
      reclaimLevel = h1?.lastBos?.price ?? h1?.lastSwingHigh?.price ?? null
      weaknessLevel = h1?.lastSwingHigh?.price ?? null
      factors.push('смещение вниз в премиуме — шорт имеет право')
    }
  }

  if (!reclaimLevel && h1) {
    reclaimLevel =
      trapSide === 'LONG' ? h1.lastSwingHigh?.price ?? h1.dealingHigh : h1.lastSwingLow?.price ?? h1.dealingLow
  }
  if (!weaknessLevel && h1) {
    weaknessLevel =
      tradeSide === 'LONG' || huntSide === 'LONG'
        ? h1.lastSwingLow?.price ?? null
        : h1.lastSwingHigh?.price ?? null
  }

  const summary = buildSummary({
    phase,
    trapSide,
    tradeSide,
    swept,
    reclaimLevel,
    crowdLongs,
    crowdShorts,
    huntSide,
  })
  const forecast = buildForecast({
    phase,
    tradeSide,
    huntSide,
    crowdLongs,
    crowdShorts,
    reclaimLevel,
    weaknessLevel,
    htfLong: htfFightsLong(h4, d1),
    htfShort: htfFightsShort(h4, d1),
  })

  return {
    phase,
    trapSide,
    tradeSide,
    huntSide,
    swept,
    reclaimLevel,
    weaknessLevel,
    crowdLongs,
    crowdShorts,
    closeQuality,
    summary,
    forecast,
    factors: factors.slice(0, 6),
  }
}

function buildSummary(opts: {
  phase: TrapPhase
  trapSide: 'LONG' | 'SHORT' | null
  tradeSide: 'LONG' | 'SHORT' | null
  huntSide: 'LONG' | 'SHORT' | null
  swept: MmTrapThesis['swept']
  reclaimLevel: number | null
  crowdLongs: number | null
  crowdShorts: number | null
}): string {
  const rec = opts.reclaimLevel != null ? fmt(opts.reclaimLevel) : null
  if (opts.phase === 'TRADE_READY' && opts.tradeSide === 'LONG') {
    return `Факт: лонг. Сняли низ, закреп над ${rec ?? 'уровнем'}`
  }
  if (opts.phase === 'TRADE_READY' && opts.tradeSide === 'SHORT') {
    return `Факт: шорт. Сняли хай, закреп под ${rec ?? 'уровнем'}`
  }
  if (opts.phase === 'SWEPT' && opts.swept?.kind === 'SSL') {
    return `Сняли лои ${fmt(opts.swept.price)} · лонг только если закреп над ${rec ?? fmt(opts.swept.price)}`
  }
  if (opts.phase === 'SWEPT' && opts.swept?.kind === 'BSL') {
    return `Сняли хаи ${fmt(opts.swept.price)} · шорт только если закреп под ${rec ?? fmt(opts.swept.price)}`
  }
  if (opts.phase === 'TRAP' && opts.trapSide === 'LONG') {
    return `Развод лонгов${opts.crowdShorts != null ? ` к шортам @ ${fmt(opts.crowdShorts)}` : ''} · не покупать BOS`
  }
  if (opts.phase === 'TRAP' && opts.trapSide === 'SHORT') {
    return `Развод шортов${opts.crowdLongs != null ? ` к лонгам @ ${fmt(opts.crowdLongs)}` : ''} · не продавать BOS`
  }
  if (opts.phase === 'HUNTING' && opts.huntSide === 'LONG' && opts.crowdShorts != null) {
    return `Охота на шорты @ ${fmt(opts.crowdShorts)} · это не лонг, это снятие`
  }
  if (opts.phase === 'HUNTING' && opts.huntSide === 'SHORT' && opts.crowdLongs != null) {
    return `Охота на лонги @ ${fmt(opts.crowdLongs)} · это не шорт, это снятие`
  }
  return 'Структура смешанная — ждём снятие и закреп'
}

function buildForecast(opts: {
  phase: TrapPhase
  tradeSide: 'LONG' | 'SHORT' | null
  huntSide: 'LONG' | 'SHORT' | null
  crowdLongs: number | null
  crowdShorts: number | null
  reclaimLevel: number | null
  weaknessLevel: number | null
  htfLong: boolean
  htfShort: boolean
}): string {
  const rec = opts.reclaimLevel != null ? fmt(opts.reclaimLevel) : 'уровня'
  const weak = opts.weaknessLevel != null ? fmt(opts.weaknessLevel) : null
  if (opts.phase === 'TRADE_READY' && opts.tradeSide === 'LONG') {
    return `Прогноз лонг, пока час держит ${rec}${weak ? ` · слабость ниже ${weak}` : ''}`
  }
  if (opts.phase === 'TRADE_READY' && opts.tradeSide === 'SHORT') {
    return `Прогноз шорт, пока час держит ${rec}${weak ? ` · слабость выше ${weak}` : ''}`
  }
  if (opts.huntSide === 'LONG' && opts.crowdShorts != null) {
    return `Сначала к шортам ${fmt(opts.crowdShorts)}. Лонг — только закреп над ${rec}. Иначе слив в лонги${opts.crowdLongs != null ? ` ${fmt(opts.crowdLongs)}` : ''}.`
  }
  if (opts.huntSide === 'SHORT' && opts.crowdLongs != null) {
    return `Сначала к лонгам ${fmt(opts.crowdLongs)}. Шорт — только закреп под ${rec}. Иначе вынос шортов${opts.crowdShorts != null ? ` ${fmt(opts.crowdShorts)}` : ''}.`
  }
  if (opts.htfLong) {
    return 'Час может врать вверх: 4H/день против. Ждём закреп или слабость.'
  }
  if (opts.htfShort) {
    return 'Час может врать вниз: 4H/день против. Ждём закреп или слабость.'
  }
  return 'Без снятия и закрепа прогноз не даём — только уровни охоты.'
}
