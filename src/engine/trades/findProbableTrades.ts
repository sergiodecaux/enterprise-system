/**
 * Rank nearest high-probability trades for the open chart symbol:
 * zones + surgical/MM + forecast setups → target ladder 1R/2R/3R + magnet + global bias.
 */

import type { OhlcvCandle } from '../../api/mexc'
import type {
  CoinSignal,
  LiquidityMap,
  MmIntentSnapshot,
} from '../types'
import type { PriceForecast } from '../prediction/types'
import type {
  ConditionalSetup,
  SetupTradeStyle,
  TradeGlobalView,
  TradeMagnet,
} from '../setups/types'
import { HORIZON_PROFILES } from '../zones/horizonProfiles'
import { buildConditionalSetups } from '../setups/buildConditionalSetups'
import { findTradeZones, type FoundTradeZone } from '../zones/findTradeZones'
import { buildGlobalFibonacci } from '../zones/globalFibonacci'
import { buildLadderPath, computeTargetLadder } from './targetLadder'

export interface ProbableTradesResult {
  trades: ConditionalSetup[]
  zones: FoundTradeZone[]
  chartZones: FoundTradeZone['chartZone'][]
  globalView: TradeGlobalView
  magnet: TradeMagnet | null
  liquidityMap: LiquidityMap
}

function pickMagnet(opts: {
  side: 'LONG' | 'SHORT'
  price: number
  entry: number
  mm?: MmIntentSnapshot | null
  map?: LiquidityMap | null
  fib141?: number | null
  setupTarget?: number | null
}): TradeMagnet | null {
  const { side, price, entry, mm, map, fib141, setupTarget } = opts
  const candidates: TradeMagnet[] = []

  if (mm?.hunt.macroTarget != null && mm.hunt.macroTarget > 0) {
    candidates.push({
      price: mm.hunt.macroTarget,
      label: 'MM macro hunt',
      kind: 'MM_MACRO',
    })
  }
  if (mm?.hunt.microTarget != null && mm.hunt.microTarget > 0) {
    candidates.push({
      price: mm.hunt.microTarget,
      label: 'MM micro hunt',
      kind: 'MM_MICRO',
    })
  }
  if (map?.nearestBSL != null && map.nearestBSL.price > 0) {
    candidates.push({
      price: map.nearestBSL.price,
      label: 'BSL pool',
      kind: 'BSL',
    })
  }
  if (map?.nearestSSL != null && map.nearestSSL.price > 0) {
    candidates.push({
      price: map.nearestSSL.price,
      label: 'SSL pool',
      kind: 'SSL',
    })
  }
  if (fib141 != null && fib141 > 0) {
    candidates.push({
      price: fib141,
      label: 'Fib 1.41 magnet',
      kind: 'FIB141',
    })
  }
  if (setupTarget != null && setupTarget > 0) {
    candidates.push({
      price: setupTarget,
      label: 'opposite liquidity',
      kind: 'OPPOSITE_LIQ',
    })
  }

  const aligned = candidates.filter((c) =>
    side === 'LONG' ? c.price > entry : c.price < entry
  )
  if (!aligned.length) return null

  // Prefer farther structural magnets (macro / BSL-SSL / fib) over micro noise
  const rank = (k: TradeMagnet['kind']): number => {
    switch (k) {
      case 'MM_MACRO':
        return 5
      case 'BSL':
      case 'SSL':
        return 4
      case 'FIB141':
        return 3
      case 'OPPOSITE_LIQ':
        return 2
      case 'MM_MICRO':
        return 1
      default:
        return 0
    }
  }

  aligned.sort((a, b) => {
    const dr = rank(b.kind) - rank(a.kind)
    if (dr !== 0) return dr
    // Prefer magnet not too far from price (actionable)
    const da = Math.abs(a.price - price) / price
    const db = Math.abs(b.price - price) / price
    return da - db
  })
  return aligned[0] ?? null
}

function buildGlobalView(opts: {
  signal?: CoinSignal | null
  mm?: MmIntentSnapshot | null
  forecast?: PriceForecast | null
  btcRs?: number | null
  fearGreed?: number | null
  magnet: TradeMagnet | null
}): TradeGlobalView {
  const factors: string[] = []
  let bull = 0
  let bear = 0

  const side = opts.mm?.preferredSide ?? opts.signal?.direction ?? null
  if (side === 'LONG') {
    bull += 2
    factors.push('MM/сигнал предпочитает LONG')
  } else if (side === 'SHORT') {
    bear += 2
    factors.push('MM/сигнал предпочитает SHORT')
  }

  const btc = opts.btcRs
  if (btc != null) {
    if (btc >= 2) {
      bull += 1
      factors.push(`Альт сильнее BTC (RS ${btc.toFixed(1)})`)
    } else if (btc <= -2) {
      bear += 1
      factors.push(`Альт слабее BTC (RS ${btc.toFixed(1)})`)
    }
  }

  const dom = opts.forecast?.dominantScenario
  const domSc = opts.forecast?.scenarios?.find((s) => s.id === dom)
  if (domSc) {
    if (domSc.type === 'LONG') {
      bull += 1
      factors.push(`Прогноз ${dom}: LONG`)
    } else if (domSc.type === 'SHORT') {
      bear += 1
      factors.push(`Прогноз ${dom}: SHORT`)
    }
    if (opts.forecast?.macroSummary) {
      factors.push(opts.forecast.macroSummary.slice(0, 120))
    }
  }

  const fg = opts.fearGreed
  if (fg != null) {
    if (fg <= 25) {
      bull += 1
      factors.push(`Fear&Greed ${fg} — контрактный long-bias`)
    } else if (fg >= 75) {
      bear += 1
      factors.push(`Fear&Greed ${fg} — риск эйфории`)
    }
  }

  if (opts.magnet) {
    factors.push(
      `Главный магнит: ${opts.magnet.label} @ ${opts.magnet.price.toPrecision(6)}`
    )
  }

  const bias: TradeGlobalView['bias'] =
    bull - bear >= 2 ? 'BULLISH' : bear - bull >= 2 ? 'BEARISH' : 'NEUTRAL'

  const summary =
    bias === 'BULLISH'
      ? 'Рынок глобально смотрит вверх — приоритет LONG у поддержки / SSL'
      : bias === 'BEARISH'
        ? 'Рынок глобально смотрит вниз — приоритет SHORT у сопротивления / BSL'
        : 'Нет явного глобального вектора — берём ближайшие зоны с лучшим Score'

  return {
    bias,
    summary,
    factors: factors.slice(0, 6),
  }
}

function enrichSetup(
  setup: ConditionalSetup,
  opts: {
    price: number
    mm?: MmIntentSnapshot | null
    map?: LiquidityMap | null
    fib141?: number | null
    globalView: TradeGlobalView
  }
): ConditionalSetup {
  const magnet = pickMagnet({
    side: setup.side,
    price: opts.price,
    entry: setup.limitEntry,
    mm: opts.mm,
    map: opts.map,
    fib141: opts.fib141,
    setupTarget: setup.target,
  })

  const ladder = computeTargetLadder({
    side: setup.side,
    entry: setup.limitEntry,
    invalidation: setup.invalidation,
    preferredTarget: setup.target,
    magnet,
    baseWinPct: setup.probability,
  })

  const zoneMid = (setup.entryZone.top + setup.entryZone.bottom) / 2
  const chartPath = buildLadderPath({
    price: opts.price,
    entry: setup.limitEntry,
    zoneMid,
    ladder,
    magnetLabel: magnet?.label,
  })

  const why = [
    ...setup.reasoning.slice(0, 2),
    `Лестница: 1R ~${ladder.pReach1}% → 2R ~${ladder.pReach2}% → 3R ~${ladder.pReach3}%`,
    magnet
      ? `Магнит полёта: ${magnet.label} @ ${magnet.price.toPrecision(6)}`
      : 'Магнит: структурная ликвидность по R-лестнице',
    opts.globalView.summary,
  ]

  return {
    ...setup,
    target: ladder.r2,
    targetsLadder: ladder,
    magnet: magnet ?? undefined,
    globalView: opts.globalView,
    chartPath,
    reasoning: why,
    triggerSummary: `${setup.side} · вход ${setup.limitEntry.toPrecision(6)} · 1R ${ladder.r1.toPrecision(6)} (~${ladder.pReach1}%) · 2R ${ladder.r2.toPrecision(6)} (~${ladder.pReach2}%) · 3R ${ladder.r3.toPrecision(6)} (~${ladder.pReach3}%) · P(win) ~${Math.round(setup.probability)}%`,
  }
}

function dedupeTrades(trades: ConditionalSetup[]): ConditionalSetup[] {
  const out: ConditionalSetup[] = []
  for (const t of trades) {
    const twin = out.find(
      (x) =>
        x.side === t.side &&
        Math.abs(x.limitEntry - t.limitEntry) / Math.max(t.limitEntry, 1e-9) <
          0.0015
    )
    if (!twin) {
      out.push(t)
      continue
    }
    if (t.probability > twin.probability) {
      out[out.indexOf(twin)] = t
    }
  }
  return out
}

/**
 * Find and rank the most probable nearby trades for the current chart.
 */
export function findProbableTrades(input: {
  candles: OhlcvCandle[]
  candles1d?: OhlcvCandle[]
  symbol: string
  flatSymbol: string
  price: number
  signal?: CoinSignal | null
  mmIntent?: MmIntentSnapshot | null
  forecast?: PriceForecast | null
  liquidityMap?: LiquidityMap | null
  bookImbalance?: number | null
  fearGreed?: number | null
  maxTrades?: number
  tradeStyle?: SetupTradeStyle
}): ProbableTradesResult {
  const price = input.price
  const tradeStyle: SetupTradeStyle = input.tradeStyle ?? 'INTRADAY'
  const prof = HORIZON_PROFILES[tradeStyle]
  const emptyMap: LiquidityMap = {
    symbol: input.symbol,
    timeframe: '1h',
    equalHighs: [],
    equalLows: [],
    nearestBSL: null,
    nearestSSL: null,
    liquidityBoost: 0,
    computedAt: Date.now(),
  }

  if (!(price > 0) || input.candles.length < 20) {
    const globalView: TradeGlobalView = {
      bias: 'NEUTRAL',
      summary: 'Недостаточно данных для ранжирования сделок',
      factors: [],
    }
    return {
      trades: [],
      zones: [],
      chartZones: [],
      globalView,
      magnet: null,
      liquidityMap: emptyMap,
    }
  }

  const zoneResult = findTradeZones({
    candles: input.candles,
    candles1d: input.candles1d,
    symbol: input.symbol,
    flatSymbol: input.flatSymbol,
    price,
    signal: input.signal,
    mmIntent: input.mmIntent,
    forecast: input.forecast,
    liquidityMap: input.liquidityMap,
    bookImbalance: input.bookImbalance,
    tradeStyle,
  })

  const fibSrc =
    tradeStyle === 'SWING' && input.candles1d && input.candles1d.length >= 40
      ? input.candles1d
      : input.candles
  const fib = buildGlobalFibonacci(fibSrc, price)
  const fib141 = fib?.price141 ?? null

  // Zone setups already horizon-tagged; add any missing forecast extras
  let extras: ConditionalSetup[] = []
  if (input.signal && tradeStyle !== 'SCALP') {
    extras = buildConditionalSetups({
      signal: input.signal,
      forecast: input.forecast ?? null,
      liquidityMap: zoneResult.liquidityMap,
      mmIntent: input.mmIntent ?? input.signal.mmIntent ?? null,
      price,
    })
      .filter((s) =>
        tradeStyle === 'SWING'
          ? s.kind.startsWith('FORECAST') || s.kind === 'MM_HUNT'
          : s.kind === 'FORECAST_A' ||
            s.kind === 'FORECAST_B' ||
            s.kind === 'MM_HUNT'
      )
      .map((s) => ({
        ...s,
        tradeStyle,
        title: s.title.startsWith('#') ? s.title : `${prof.tag} ${s.title}`,
      }))
  }

  const draftMagnet = pickMagnet({
    side:
      input.mmIntent?.preferredSide === 'SHORT'
        ? 'SHORT'
        : input.mmIntent?.preferredSide === 'LONG'
          ? 'LONG'
          : zoneResult.nearestLong &&
              (!zoneResult.nearestShort ||
                Math.abs(zoneResult.nearestLong.distancePct) <=
                  Math.abs(zoneResult.nearestShort.distancePct))
            ? 'LONG'
            : 'SHORT',
    price,
    entry: price,
    mm: input.mmIntent,
    map: zoneResult.liquidityMap,
    fib141,
    setupTarget: null,
  })

  const globalView = buildGlobalView({
    signal: input.signal,
    mm: input.mmIntent,
    forecast: input.forecast,
    btcRs: input.signal?.btcDivergence?.relativeStrength ?? null,
    fearGreed: input.fearGreed,
    magnet: draftMagnet,
  })

  // Soft rank boost when trade aligns with global bias
  const biasBoost = (side: 'LONG' | 'SHORT'): number => {
    if (globalView.bias === 'BULLISH' && side === 'LONG') return 4
    if (globalView.bias === 'BEARISH' && side === 'SHORT') return 4
    if (globalView.bias === 'BULLISH' && side === 'SHORT') return -5
    if (globalView.bias === 'BEARISH' && side === 'LONG') return -5
    return 0
  }

  const merged = dedupeTrades([...zoneResult.setups, ...extras])
    .map((s) => {
      const boosted = {
        ...s,
        probability: Math.round(
          Math.min(88, Math.max(22, s.probability + biasBoost(s.side)))
        ),
      }
      return enrichSetup(boosted, {
        price,
        mm: input.mmIntent,
        map: zoneResult.liquidityMap,
        fib141,
        globalView,
      })
    })
    .sort((a, b) => b.probability - a.probability)

  const max = input.maxTrades ?? 8
  const trades = merged.slice(0, max)

  // Market-level magnet for header (from top trade or draft)
  const magnet = trades[0]?.magnet ?? draftMagnet

  return {
    trades,
    zones: zoneResult.zones,
    chartZones: zoneResult.chartZones,
    globalView,
    magnet,
    liquidityMap: zoneResult.liquidityMap,
  }
}
