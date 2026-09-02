/**
 * Directed Long/Short signal for the Signals tab:
 * same pipeline as LiveChart «Найти сигнал», filtered by side.
 */

import type { OhlcvCandle } from '../../api/mexc'
import type {
  CoinSignal,
  LiquidityMap,
  MmIntentSnapshot,
} from '../types'
import type { ConditionalSetup, SetupTradeStyle } from '../setups/types'
import type { PriceForecast } from '../prediction/types'
import {
  findLiveSignal,
  type LiveScenario,
  type LiveSignalResult,
} from '../trades/findLiveSignal'
import type { FoundTradeZone } from '../zones/findTradeZones'
import {
  blendConfidenceWithHist,
  evaluateHistWrPolicy,
} from '../analysis/histWrPolicy'
import { deriveAltMacro } from '../analysis/altMacro'
import type { AltBias, AltRegime } from '../../api/marketContext'

export type SignalSide = 'LONG' | 'SHORT'

export interface WatchFactor {
  id: string
  label: string
  detail: string
  tone: 'ok' | 'warn' | 'bad' | 'neutral'
}

export interface DirectedSignalResult {
  side: SignalSide
  live: LiveSignalResult
  /** Best scenario matching requested side */
  primary: LiveScenario
  /** Setups for this side only */
  setups: ConditionalSetup[]
  bestSetup: ConditionalSetup | null
  /** Catch zone for the move */
  catchZone: FoundTradeZone | null
  winPct: number
  doubts: string[]
  watchFactors: WatchFactor[]
  targetMovePct: number | null
}

function baseFromSymbol(symbol: string): string {
  return symbol
    .replace(/\/USDT:USDT$/i, '')
    .replace(/_USDT$/i, '')
    .replace(/USDT$/i, '')
    .toUpperCase()
}

export function buildWatchFactors(opts: {
  side: SignalSide
  signal: CoinSignal | null
  btcDominance: number | null
  fearGreed: number | null
  fearGreedLabel?: string | null
  newsLabel?: string | null
  newsHeadlines?: string[]
  coinNewsLabel?: string | null
  coinNewsHeadlines?: string[]
  dailyBias?: string | null
  btcTrend?: string | null
  total3Usd?: number | null
  total3Delta24h?: number | null
  btcDomDelta24h?: number | null
  altRegime?: AltRegime | null
  altBias?: AltBias | null
  isBtc?: boolean
}): WatchFactor[] {
  const factors: WatchFactor[] = []
  const { side, signal } = opts
  const isBtc = opts.isBtc ?? false
  const macro = deriveAltMacro({
    btcDominance: opts.btcDominance,
    btcDomDelta24h: opts.btcDomDelta24h,
    total3Usd: opts.total3Usd,
    total3Delta24h: opts.total3Delta24h,
    altRegime: opts.altRegime,
    altBias: opts.altBias,
  })

  if (opts.btcDominance != null) {
    const d = opts.btcDominance
    const delta =
      opts.btcDomDelta24h != null
        ? ` ${opts.btcDomDelta24h >= 0 ? '+' : ''}${opts.btcDomDelta24h.toFixed(2)}пп`
        : ''
    let tone: WatchFactor['tone'] = 'neutral'
    let detail = `${d.toFixed(1)}%${delta}`
    if (!isBtc) {
      if (side === 'LONG' && (macro.regime === 'ALT_OFF' || d >= 56)) {
        tone = 'bad'
        detail = `${d.toFixed(1)}%${delta} — давит альты (LONG рискованнее)`
      } else if (side === 'LONG' && (macro.regime === 'ALT_ON' || d <= 48)) {
        tone = 'ok'
        detail = `${d.toFixed(1)}%${delta} — пространство альтам`
      } else if (side === 'SHORT' && (macro.regime === 'ALT_OFF' || d >= 55)) {
        tone = 'ok'
        detail = `${d.toFixed(1)}%${delta} — давление на альты поддерживает SHORT`
      } else if (side === 'SHORT' && (macro.regime === 'ALT_ON' || d <= 48)) {
        tone = 'warn'
        detail = `${d.toFixed(1)}%${delta} — альты сильны, SHORT осторожнее`
      }
    }
    factors.push({ id: 'btc_d', label: 'BTC.D', detail, tone })
  }

  if (opts.total3Usd != null || opts.total3Delta24h != null || macro.regime !== 'NEUTRAL') {
    let tone: WatchFactor['tone'] = 'neutral'
    if (!isBtc) {
      if (macro.altBias === 'LONG' && side === 'LONG') tone = 'ok'
      else if (macro.altBias === 'SHORT' && side === 'SHORT') tone = 'ok'
      else if (macro.altBias === 'LONG' && side === 'SHORT') tone = 'warn'
      else if (macro.altBias === 'SHORT' && side === 'LONG') tone = 'bad'
    }
    const t3d =
      opts.total3Delta24h != null
        ? `${opts.total3Delta24h >= 0 ? '+' : ''}${opts.total3Delta24h.toFixed(1)}%`
        : ''
    factors.push({
      id: 'total3',
      label: 'TOTAL3',
      detail: t3d ? `${t3d} · ${macro.line}` : macro.line,
      tone,
    })
  }

  if (opts.fearGreed != null) {
    const fg = opts.fearGreed
    let tone: WatchFactor['tone'] = 'neutral'
    if (side === 'LONG' && fg <= 25) tone = 'ok'
    else if (side === 'LONG' && fg >= 75) tone = 'warn'
    else if (side === 'SHORT' && fg >= 75) tone = 'ok'
    else if (side === 'SHORT' && fg <= 25) tone = 'warn'
    factors.push({
      id: 'fg',
      label: 'Fear & Greed',
      detail: `${fg}${opts.fearGreedLabel ? ` · ${opts.fearGreedLabel}` : ''}`,
      tone,
    })
  }

  const bias = opts.dailyBias ?? signal?.dailyBias ?? null
  if (bias) {
    let tone: WatchFactor['tone'] = 'neutral'
    if (side === 'LONG' && bias === 'BULLISH') tone = 'ok'
    else if (side === 'LONG' && bias === 'BEARISH') tone = 'bad'
    else if (side === 'SHORT' && bias === 'BEARISH') tone = 'ok'
    else if (side === 'SHORT' && bias === 'BULLISH') tone = 'bad'
    factors.push({
      id: 'daily_bias',
      label: 'BTC daily bias',
      detail: String(bias),
      tone,
    })
  }

  const btcTrend = opts.btcTrend ?? signal?.btcTrend ?? null
  if (btcTrend) {
    factors.push({
      id: 'btc_trend',
      label: 'BTC структура',
      detail: String(btcTrend),
      tone: 'neutral',
    })
  }

  if (signal?.btcDivergence?.relativeStrength != null) {
    const rs = signal.btcDivergence.relativeStrength
    let tone: WatchFactor['tone'] = 'neutral'
    if (side === 'LONG' && rs > 0) tone = 'ok'
    else if (side === 'LONG' && rs < 0) tone = 'warn'
    else if (side === 'SHORT' && rs < 0) tone = 'ok'
    else if (side === 'SHORT' && rs > 0) tone = 'warn'
    factors.push({
      id: 'btc_rs',
      label: 'RS vs BTC',
      detail: rs > 0 ? `сильнее BTC (+${rs.toFixed(1)})` : `слабее BTC (${rs.toFixed(1)})`,
      tone,
    })
  }

  const coinLabel = opts.coinNewsLabel
  if (coinLabel && coinLabel !== 'NEUTRAL') {
    let tone: WatchFactor['tone'] = 'neutral'
    if (side === 'LONG' && coinLabel === 'BULLISH') tone = 'ok'
    else if (side === 'LONG' && coinLabel === 'BEARISH') tone = 'bad'
    else if (side === 'SHORT' && coinLabel === 'BEARISH') tone = 'ok'
    else if (side === 'SHORT' && coinLabel === 'BULLISH') tone = 'bad'
    const head = opts.coinNewsHeadlines?.[0]
    factors.push({
      id: 'coin_news',
      label: 'Новости монеты',
      detail: head ? `${coinLabel} · ${head}` : coinLabel,
      tone,
    })
  } else if (opts.newsLabel && opts.newsLabel !== 'NEUTRAL') {
    factors.push({
      id: 'news',
      label: 'Новости (глоб.)',
      detail: opts.newsHeadlines?.[0]
        ? `${opts.newsLabel} · ${opts.newsHeadlines[0]}`
        : opts.newsLabel,
      tone: 'neutral',
    })
  }

  if (signal?.mmIntent?.label) {
    factors.push({
      id: 'mm',
      label: 'MM Intent',
      detail: `${signal.mmIntent.label} · conf ${Math.round(signal.mmIntent.confidence)}%`,
      tone: signal.mmIntent.preferredSide === side ? 'ok' : 'warn',
    })
  }

  return factors
}

/**
 * Filter live signal result to the requested side and pick catch zone.
 */
export function buildDirectedSignal(input: {
  side: SignalSide
  candles: OhlcvCandle[]
  candles1d?: OhlcvCandle[]
  candles1h?: OhlcvCandle[]
  symbol: string
  flatSymbol: string
  price: number
  signal?: CoinSignal | null
  mmIntent?: MmIntentSnapshot | null
  forecast?: PriceForecast | null
  liquidityMap?: LiquidityMap | null
  bookImbalance?: number | null
  fearGreed?: number | null
  tradeStyle?: SetupTradeStyle
  btcDominance?: number | null
  fearGreedLabel?: string | null
  newsLabel?: string | null
  newsHeadlines?: string[]
  coinNewsLabel?: string | null
  coinNewsHeadlines?: string[]
  dailyBias?: string | null
  btcTrend?: string | null
  total3Usd?: number | null
  total3Delta24h?: number | null
  btcDomDelta24h?: number | null
  altRegime?: AltRegime | null
  altBias?: AltBias | null
}): DirectedSignalResult {
  const live = findLiveSignal({
    candles: input.candles,
    candles1d: input.candles1d,
    candles1h: input.candles1h,
    symbol: input.symbol,
    flatSymbol: input.flatSymbol,
    price: input.price,
    signal: input.signal,
    mmIntent: input.mmIntent,
    forecast: input.forecast,
    liquidityMap: input.liquidityMap,
    bookImbalance: input.bookImbalance,
    fearGreed: input.fearGreed,
    tradeStyle: input.tradeStyle ?? 'INTRADAY',
  })

  const side = input.side
  const sideScenarios = live.scenarios.filter((s) => s.side === side)
  const setups = live.trades.filter((t) => t.side === side)

  let primary =
    sideScenarios.find((s) => s.kind === 'SEQUENCE_LIMIT') ??
    sideScenarios.find((s) => s.kind === 'ZONE_TEST_BOUNCE') ??
    sideScenarios[0] ??
    null

  if (!primary) {
    primary = {
      id: `sc_forced_${side.toLowerCase()}`,
      kind: 'WAIT',
      side,
      title: `${side}: зона пока слабая`,
      winPct: Math.max(
        28,
        Math.round((input.signal?.probabilityPct ?? 35) * 0.7)
      ),
      summary:
        live.primary.side === side
          ? live.primary.summary
          : `По ${side} нет сильного сценария — ждать подхода к зоне или сменить сторону`,
      steps: [
        'Не входить маркет в середину',
        'Лимит на ближайшей зоне ликвидности',
        'Следить за BTC.D / новостями / invalidation',
      ],
      invalidation: live.primary.invalidation,
    }
  }

  const bestSetup =
    (primary.setupId
      ? setups.find((t) => t.id === primary!.setupId)
      : null) ??
    setups[0] ??
    (live.bestSetup?.side === side ? live.bestSetup : null) ??
    null

  const catchZone: FoundTradeZone | null =
    live.zones.find((z) => z.side === side) ??
    live.zones.find((z) => {
      const mid = (z.top + z.bottom) / 2
      if (side === 'LONG') return mid <= input.price
      return mid >= input.price
    }) ??
    (bestSetup
      ? {
          id: `zone_${bestSetup.id}`,
          source: 'SSL' as const,
          side: bestSetup.side,
          top: bestSetup.entryZone.top,
          bottom: bestSetup.entryZone.bottom,
          mid: (bestSetup.entryZone.top + bestSetup.entryZone.bottom) / 2,
          label: bestSetup.title,
          strength: Math.round(bestSetup.probability / 10),
          distancePct:
            ((bestSetup.limitEntry - input.price) / Math.max(input.price, 1e-12)) *
            100,
          target: bestSetup.target,
          invalidation: bestSetup.invalidation,
          limitEntry: bestSetup.limitEntry,
          chartZone: {
            id: `cz_${bestSetup.id}`,
            type: 'SSL' as const,
            side: bestSetup.side === 'LONG' ? ('BULLISH' as const) : ('BEARISH' as const),
            top: bestSetup.entryZone.top,
            bottom: bestSetup.entryZone.bottom,
            startTime: 0 as never,
            endTime: 0 as never,
            label: bestSetup.title,
            strength: Math.round(bestSetup.probability / 10),
          },
        }
      : null)

  const modelPct = Math.round(
    bestSetup?.probability ??
      primary.winPct ??
      input.signal?.styleConfidence ??
      input.signal?.probabilityPct ??
      0
  )
  const histPolicy = input.signal
    ? evaluateHistWrPolicy(input.signal)
    : null
  const winPct = histPolicy
    ? blendConfidenceWithHist(modelPct, histPolicy)
    : modelPct

  const doubts: string[] = []
  const missing = input.signal?.scoreCard?.missingFactors ?? []
  for (const m of missing.slice(0, 4)) doubts.push(m)
  if (input.signal?.scoreCard?.grade === 'SKIP') {
    doubts.push('ScoreCard SKIP — вход только от зоны')
  }
  if (histPolicy?.action === 'block' || histPolicy?.action === 'demote') {
    doubts.push(histPolicy.reason)
  }
  if (histPolicy?.action === 'boost') {
    doubts.push(histPolicy.reason)
  }
  if (primary.invalidation) doubts.push(primary.invalidation)
  if (bestSetup) {
    for (const p of bestSetup.preconditions) {
      if (p.status === 'FAILED' || p.status === 'PENDING') {
        doubts.push(`${p.label} (${p.status})`)
      }
    }
  }
  if (sideScenarios.length === 0) {
    doubts.push(`Слабое совпадение сценариев для ${side}`)
  }

  const watchFactors = buildWatchFactors({
    side,
    signal: input.signal ?? null,
    btcDominance: input.btcDominance ?? null,
    fearGreed: input.fearGreed ?? null,
    fearGreedLabel: input.fearGreedLabel,
    newsLabel: input.newsLabel,
    newsHeadlines: input.newsHeadlines,
    coinNewsLabel: input.coinNewsLabel,
    coinNewsHeadlines: input.coinNewsHeadlines,
    dailyBias: input.dailyBias,
    btcTrend: input.btcTrend,
    total3Usd: input.total3Usd,
    total3Delta24h: input.total3Delta24h,
    btcDomDelta24h: input.btcDomDelta24h,
    altRegime: input.altRegime,
    altBias: input.altBias,
    isBtc: baseFromSymbol(input.symbol) === 'BTC',
  })

  let targetMovePct: number | null = null
  if (bestSetup && input.price > 0) {
    targetMovePct =
      ((bestSetup.target - bestSetup.limitEntry) / bestSetup.limitEntry) * 100
    if (side === 'SHORT') targetMovePct = -targetMovePct
    targetMovePct = Math.abs(targetMovePct)
  } else if (catchZone && input.price > 0 && live.magnet?.price) {
    targetMovePct =
      (Math.abs(live.magnet.price - (catchZone.top + catchZone.bottom) / 2) /
        input.price) *
      100
  }

  const style = input.tradeStyle ?? 'INTRADAY'
  const stampedSetups = setups.map((s) =>
    s.tradeStyle ? s : { ...s, tradeStyle: style }
  )
  const stampedBest =
    bestSetup == null
      ? null
      : bestSetup.tradeStyle
        ? bestSetup
        : { ...bestSetup, tradeStyle: style }

  return {
    side,
    live,
    primary,
    setups: stampedSetups,
    bestSetup: stampedBest,
    catchZone,
    winPct,
    doubts: [...new Set(doubts)].slice(0, 6),
    watchFactors,
    targetMovePct,
  }
}

export function coinBaseFromInternal(internalSymbol: string): string {
  return baseFromSymbol(internalSymbol)
}
