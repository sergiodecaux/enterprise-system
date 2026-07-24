/**
 * «Найти сигнал» — самый вероятный ход прямо сейчас:
 * тест зоны / SMC hunt / продолжение / разворот + варианты развития.
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
import { findProbableTrades } from './findProbableTrades'
import { buildZoneTradeVariants } from '../zones/zoneScenarios'
import type { FoundTradeZone } from '../zones/findTradeZones'
import {
  analyzeLiveMarket,
  type LiveMarketRead,
} from './liveMarketRead'

export type LiveSignalPhase =
  | 'IN_ZONE'
  | 'APPROACHING'
  | 'EXTENDED'
  | 'HUNTING'
  | 'CHOP'

export type LiveScenarioKind =
  | 'ZONE_TEST_BOUNCE'
  | 'ZONE_BREAK'
  | 'MM_HUNT'
  | 'CONTINUATION'
  | 'REVERSAL'
  | 'WAIT'

export interface LiveScenario {
  id: string
  kind: LiveScenarioKind
  side: 'LONG' | 'SHORT' | 'FLAT'
  title: string
  winPct: number
  summary: string
  steps: string[]
  invalidation?: string
  /** Link to actionable setup when available */
  setupId?: string
}

export interface LiveSignalResult {
  phase: LiveSignalPhase
  phaseLabel: string
  /** Primary call right now */
  primary: LiveScenario
  /** Alternative developments (sorted by win%) */
  scenarios: LiveScenario[]
  /** Best actionable setup to watch / enter */
  bestSetup: ConditionalSetup | null
  trades: ConditionalSetup[]
  zones: FoundTradeZone[]
  chartZones: FoundTradeZone['chartZone'][]
  globalView: TradeGlobalView
  magnet: TradeMagnet | null
  liquidityMap: LiquidityMap
  /** How price is being driven (SMC / MM) */
  driveNarrative: string
  smcLines: string[]
  /** Trader-style: zone reaction, hour close, bounce → D1/W */
  liveMarket: LiveMarketRead | null
}

function distPct(price: number, level: number): number {
  if (!(price > 0)) return 999
  return ((level - price) / price) * 100
}

function phaseOf(opts: {
  price: number
  zones: FoundTradeZone[]
  mm?: MmIntentSnapshot | null
}): { phase: LiveSignalPhase; label: string } {
  const near = opts.zones
    .map((z) => ({
      z,
      d: Math.abs(z.distancePct),
      inZone: opts.price >= z.bottom * 0.998 && opts.price <= z.top * 1.002,
    }))
    .sort((a, b) => a.d - b.d)[0]

  if (near?.inZone) {
    return {
      phase: 'IN_ZONE',
      label: `Цена в зоне ${near.z.label} — тест ликвидности`,
    }
  }
  if (near && near.d <= 1.2) {
    return {
      phase: 'APPROACHING',
      label: `Подход к ${near.z.label} (${near.d.toFixed(2)}%) — жду реакцию`,
    }
  }
  if (opts.mm?.hunt.microIsStopHunt || (opts.mm?.confidence ?? 0) >= 55) {
    return {
      phase: 'HUNTING',
      label: opts.mm?.label
        ? `SMC hunt: ${opts.mm.label}`
        : 'Охота за ликвидностью (MM)',
    }
  }
  if (near && near.d > 3.5) {
    return {
      phase: 'EXTENDED',
      label: `Далеко от зоны (${near.d.toFixed(1)}%) — не догонять, ждать магнит`,
    }
  }
  return {
    phase: 'CHOP',
    label: 'Нет чистого теста — читаем сценарии и ждём структуру',
  }
}

function buildDriveNarrative(
  mm: MmIntentSnapshot | null | undefined,
  map: LiquidityMap,
  price: number
): { narrative: string; lines: string[] } {
  const lines: string[] = []
  const bsl = map.nearestBSL
  const ssl = map.nearestSSL

  if (mm) {
    lines.push(
      `${mm.emoji || '⚡'} Drive ${mm.drive} · уверенность ${mm.confidence}% · ${mm.label}`
    )
    for (const r of mm.reasons.slice(0, 3)) lines.push(r)
    if (mm.hunt.microTarget != null) {
      lines.push(
        `Микро-цель${mm.hunt.microIsStopHunt ? ' (stop-hunt)' : ''}: ${mm.hunt.microLabel} @ ${mm.hunt.microTarget.toPrecision(6)}`
      )
    }
    if (mm.hunt.macroTarget != null) {
      lines.push(
        `Макро-магнит: ${mm.hunt.macroLabel} @ ${mm.hunt.macroTarget.toPrecision(6)}`
      )
    }
  }

  if (ssl) {
    lines.push(
      `SSL ${map.timeframe} ×${ssl.touches} (${ssl.strength}) @ ${ssl.price.toPrecision(6)} · ${distPct(price, ssl.price).toFixed(2)}%`
    )
  }
  if (bsl) {
    lines.push(
      `BSL ${map.timeframe} ×${bsl.touches} (${bsl.strength}) @ ${bsl.price.toPrecision(6)} · ${distPct(price, bsl.price).toFixed(2)}%`
    )
  }

  let narrative: string
  if (mm?.drive === 'UP' && mm.preferredSide === 'LONG') {
    narrative =
      'MM/поток тянет вверх: типичный путь — забрать SSL (стоп-хант) → разворот к BSL/макро-магниту.'
  } else if (mm?.drive === 'DOWN' && mm.preferredSide === 'SHORT') {
    narrative =
      'MM/поток тянет вниз: типичный путь — снять BSL сверху → продолжение к SSL/макро-цели.'
  } else if (mm?.drive === 'UP') {
    narrative =
      'Краткосрочно цену гонят вверх, но сторона сделки ещё не подтверждена — смотри реакцию на зоне.'
  } else if (mm?.drive === 'DOWN') {
    narrative =
      'Краткосрочно цену гонят вниз — жди тест ликвидности и подтверждение, не входи в середину хода.'
  } else if (ssl && bsl) {
    narrative =
      'Drive нейтрален: цена в коридоре SSL↔BSL. Вероятнее — тест ближайшей ликвидности, затем выбор направления.'
  } else {
    narrative =
      'Нет явного drive: строим сценарии от ближайших пулов ликвидности и ScoreCard.'
  }

  return { narrative, lines: lines.slice(0, 8) }
}

function scenarioFromSetup(
  s: ConditionalSetup,
  kind: LiveScenarioKind,
  title?: string
): LiveScenario {
  return {
    id: `sc_${s.id}`,
    kind,
    side: s.side,
    title: title ?? s.title,
    winPct: Math.round(s.probability),
    summary: s.triggerSummary,
    steps: s.reasoning.slice(0, 4),
    invalidation: `SL ${s.invalidation.toPrecision(6)}`,
    setupId: s.id,
  }
}

/**
 * Find the most probable live signal + scenario tree for the open coin.
 */
export function findLiveSignal(input: {
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
}): LiveSignalResult {
  const price = input.price
  const mm = input.mmIntent ?? input.signal?.mmIntent ?? null
  const base = findProbableTrades({
    ...input,
    mmIntent: mm,
    maxTrades: 8,
  })

  const zoneVariants = buildZoneTradeVariants(
    base.zones,
    price,
    input.bookImbalance ?? null,
    input.flatSymbol,
    input.symbol,
    input.signal?.btcDivergence?.relativeStrength ?? null,
    input.tradeStyle ?? 'INTRADAY'
  )

  const liveMarket = analyzeLiveMarket({
    price,
    candles: input.candles,
    candles1h: input.candles1h,
    candles1d: input.candles1d,
    zones: base.zones,
  })

  const { phase, label: phaseLabel } = phaseOf({
    price,
    zones: base.zones,
    mm,
  })
  // Prefer live reaction label when more specific
  const phaseLabelLive =
    liveMarket.reaction === 'BOUNCE_NO_HOLD' ||
    liveMarket.reaction === 'BOUNCE_HELD' ||
    liveMarket.reaction === 'CONSOLIDATING' ||
    liveMarket.reaction === 'BREAKING'
      ? liveMarket.reactionNote
      : phaseLabel

  const { narrative, lines: smcLines } = buildDriveNarrative(
    mm,
    base.liquidityMap,
    price
  )

  const scenarios: LiveScenario[] = []

  // Bounce plan as first-class scenario
  if (liveMarket.nearestBounce) {
    const b = liveMarket.nearestBounce
    scenarios.push({
      id: 'sc_htf_bounce',
      kind:
        liveMarket.reaction === 'BREAKING' ? 'ZONE_BREAK' : 'ZONE_TEST_BOUNCE',
      side: b.side,
      title: `${b.side} от ${b.zoneLabel}`,
      winPct: b.winPct,
      summary: b.thesis,
      steps: b.steps,
      invalidation: `SL ${b.invalidation.toPrecision(6)}`,
    })
  }

  for (const v of zoneVariants.slice(0, 6)) {
    const isBreak = v.id.includes('_break_') || v.kind === 'STOP_THEN_REVERSE'
    scenarios.push(
      scenarioFromSetup(
        v,
        isBreak ? 'ZONE_BREAK' : 'ZONE_TEST_BOUNCE',
        isBreak
          ? `Пробой ${v.side === 'LONG' ? 'вверх' : 'вниз'}`
          : `Тест зоны → отскок ${v.side}`
      )
    )
  }

  if (mm && mm.confidence >= 40 && mm.preferredSide) {
    const micro = mm.hunt.microTarget
    const macro = mm.hunt.macroTarget
    const steps = [
      mm.hunt.microIsStopHunt
        ? `1) Ложный ход / stop-hunt к ${mm.hunt.microLabel || 'ликвидности'}`
        : `1) Микро-импульс к ${mm.hunt.microLabel || 'цели'}`,
      macro
        ? `2) Макро-полёт к ${mm.hunt.macroLabel} @ ${macro.toPrecision(6)}`
        : '2) Закрепление по направлению drive',
      '3) Вход после реакции · не догонять mid-impulse',
    ]
    scenarios.push({
      id: 'sc_mm_hunt',
      kind: 'MM_HUNT',
      side: mm.preferredSide,
      title: `SMC · ${mm.label}`,
      winPct: Math.min(82, Math.max(42, Math.round(mm.confidence * 0.75 + 18))),
      summary: narrative,
      steps,
      invalidation: micro
        ? `Слом за микро-целью ${micro.toPrecision(6)} без реакции`
        : undefined,
    })
  }

  for (const t of base.trades.slice(0, 3)) {
    if (scenarios.some((s) => s.setupId === t.id)) continue
    scenarios.push(
      scenarioFromSetup(t, 'CONTINUATION', `Вероятный ход · ${t.side}`)
    )
  }

  if (
    liveMarket.reaction === 'BOUNCE_NO_HOLD' ||
    liveMarket.reaction === 'EXTENDED'
  ) {
    scenarios.push({
      id: 'sc_wait_zone',
      kind: 'WAIT',
      side: 'FLAT',
      title: 'Ждать зону / reclaim',
      winPct: 40,
      summary: liveMarket.whatNow,
      steps: liveMarket.nearestBounce?.steps.slice(0, 3) ?? [
        'Не догонять mid-impulse',
        'Лимит на ближайшей SSL/BSL',
        'Цель — D1/W магнит по дню',
      ],
    })
  }

  const sc = input.signal?.scoreCard
  if (sc && sc.grade === 'SKIP') {
    scenarios.push({
      id: 'sc_wait',
      kind: 'WAIT',
      side: 'FLAT',
      title: 'Ждать · ScoreCard SKIP',
      winPct: 35,
      summary: `Не хватает: ${(sc.missingFactors ?? []).slice(0, 3).join(', ') || 'факторов'}`,
      steps: [
        'Не входить маркет в середину',
        'Дождаться теста зоны + стакан/поглощение',
        'Или пробой с объёмом и закреплением',
      ],
    })
  }

  const seen = new Set<string>()
  const uniq = scenarios.filter((s) => {
    const k = `${s.kind}:${s.side}:${s.title}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  uniq.sort((a, b) => b.winPct - a.winPct)

  let primary = uniq.find((s) => s.id === 'sc_htf_bounce') ?? uniq[0]
  if (!primary) {
    primary = {
      id: 'sc_empty',
      kind: 'WAIT',
      side: 'FLAT',
      title: 'Нет сигнала',
      winPct: 0,
      summary: 'Мало данных — обнови график / смени ТФ',
      steps: ['Дождись свечей', 'Проверь ликвидность 4H/D'],
    }
  } else if (
    liveMarket.reaction === 'BOUNCE_NO_HOLD' ||
    liveMarket.reaction === 'BREAKING'
  ) {
    const wait = uniq.find((s) => s.kind === 'WAIT')
    if (wait && wait.winPct + 5 >= primary.winPct - 10) {
      primary = {
        ...wait,
        summary: `${liveMarket.whatNow} ${wait.summary}`,
      }
    }
  } else if (phase === 'IN_ZONE' || phase === 'APPROACHING') {
    const zoneSc = uniq.find(
      (s) => s.kind === 'ZONE_TEST_BOUNCE' || s.kind === 'ZONE_BREAK'
    )
    if (zoneSc && zoneSc.winPct >= primary.winPct - 8) primary = zoneSc
  } else if (phase === 'HUNTING') {
    const hunt = uniq.find((s) => s.kind === 'MM_HUNT')
    if (hunt && hunt.winPct >= primary.winPct - 6) primary = hunt
  }

  const bestSetup =
    (primary.setupId
      ? (base.trades.find((t) => t.id === primary.setupId) ??
        zoneVariants.find((t) => t.id === primary.setupId))
      : null) ??
    base.trades[0] ??
    zoneVariants[0] ??
    null

  const trades = [...base.trades]
  for (const v of zoneVariants) {
    if (!trades.some((t) => t.id === v.id)) trades.push(v)
  }
  trades.sort((a, b) => b.probability - a.probability)

  return {
    phase,
    phaseLabel: phaseLabelLive,
    primary,
    scenarios: uniq.slice(0, 6),
    bestSetup,
    trades: trades.slice(0, 8),
    zones: base.zones,
    chartZones: base.chartZones,
    globalView: base.globalView,
    magnet: base.magnet,
    liquidityMap: base.liquidityMap,
    driveNarrative: narrative,
    smcLines: [...liveMarket.lines.slice(0, 4), ...smcLines].slice(0, 10),
    liveMarket,
  }
}
