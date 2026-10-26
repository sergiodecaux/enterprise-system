/**
 * Live limit-order sniper engine.
 *
 * The strict sniper filter (`sniperMode.ts`) only fires on fully confirmed
 * setups, so the Sniper tab is empty most of the time. This engine instead
 * turns every pending limit idea (surgical / SSL / BSL / MM hunt / OTE /
 * pullback) into a live trade plan with a computed potential to target.
 *
 * Everything is derived from data that already exists in the store
 * (`signals`, `liveTickets`, `liquidityMaps`, `mmIntent`, `surgicalEntries`),
 * so it can be recomputed on every 12s ticker poll without extra requests.
 */

import type {
  CoinSignal,
  LiquidityMap,
  LiveTicker,
  MmIntentSnapshot,
  SurgicalEntrySnapshot,
  TradeStyle,
} from '../types'

export type LiveLimitSource =
  | 'SURGICAL'
  | 'SSL'
  | 'BSL'
  | 'MM_HUNT'
  | 'OTE'
  | 'SIGNAL'
  | 'RANGE'

export type LiveLimitState =
  | 'WAITING'
  | 'APPROACHING'
  | 'IN_ZONE'
  | 'FILLED'
  | 'INVALIDATED'

export interface LiveLimitTrade {
  id: string
  symbol: string
  internalSymbol: string
  displayName: string
  side: 'LONG' | 'SHORT'
  source: LiveLimitSource
  style: TradeStyle
  /** Limit price (where we want to be filled) */
  entry: number
  /** First realistic target / magnet */
  target: number
  /** Human label of the target (TP1 / BSL ×3 / MM macro …) */
  targetLabel: string
  /** Invalidation below/above the limit */
  invalidation: number
  /** Live price used for distance/state */
  price: number
  /** |price → entry| in % */
  distancePct: number
  /** entry → target in % */
  potentialPct: number
  /** entry → invalidation in % */
  riskPct: number
  riskReward: number
  /** 5..96 calibrated confidence */
  confidence: number
  state: LiveLimitState
  reasons: string[]
  score: number
  change24h: number
  updatedAt: number
  /** Internal ranking weight (higher = stronger source) */
  priority: number
}

export interface BuildLiveLimitTradesInput {
  signals: CoinSignal[]
  liveTickets: Record<string, LiveTicker>
  liquidityMaps?: Record<string, LiquidityMap>
  mmIntent?: Record<string, MmIntentSnapshot>
  surgicalEntries?: Record<string, SurgicalEntrySnapshot>
  /** Minimum entry → target move, default 2% */
  minPotentialPct?: number
  /** Hard cap of returned rows */
  maxResults?: number
  now?: number
}

export const LIVE_LIMIT_DEFAULT_MIN_POTENTIAL = 2
export const LIVE_LIMIT_IN_ZONE_PCT = 0.35
export const LIVE_LIMIT_APPROACH_PCT = 1.5

/** Style-specific max distance from live price to a pending limit */
const MAX_DISTANCE_PCT: Record<TradeStyle, number> = {
  SCALP: 4,
  INTRADAY: 8,
  SWING: 15,
}

/** Noise floor for the stop — avoids absurd R:R on ultra-tight invalidation */
const MIN_RISK_PCT: Record<TradeStyle, number> = {
  SCALP: 0.35,
  INTRADAY: 0.6,
  SWING: 1,
}

const SOURCE_CONFIDENCE: Record<LiveLimitSource, number> = {
  SURGICAL: 12,
  MM_HUNT: 9,
  SSL: 7,
  BSL: 7,
  OTE: 6,
  SIGNAL: 2,
  RANGE: -4,
}

const STATE_CONFIDENCE: Record<LiveLimitState, number> = {
  IN_ZONE: 8,
  FILLED: 3,
  APPROACHING: 3,
  WAITING: 0,
  INVALIDATED: 0,
}

const STATE_RANK: Record<LiveLimitState, number> = {
  IN_ZONE: 0,
  APPROACHING: 1,
  FILLED: 2,
  WAITING: 3,
  INVALIDATED: 4,
}

interface RawLimit {
  source: LiveLimitSource
  side: 'LONG' | 'SHORT'
  entry: number
  invalidation: number | null
  target: number | null
  style: TradeStyle
  baseConfidence: number
  priority: number
  reasons: string[]
}

interface TargetOption {
  price: number
  label: string
}

interface FinalizeContext {
  price: number
  live: LiveTicker | null
  liq: LiquidityMap | null
  mm: MmIntentSnapshot | null
  surgical: SurgicalEntrySnapshot | null
  minPotentialPct: number
  now: number
}

function isNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** Move from `from` to `to` in % of `from` (always positive) */
function movePct(from: number, to: number): number {
  return (Math.abs(to - from) / from) * 100
}

/** Stable 4-significant-digit bucket so live tickers do not churn row ids */
function bucketPrice(p: number): string {
  if (!isNum(p)) return '0'
  const magnitude = Math.pow(10, Math.floor(Math.log10(p)) - 3)
  return String(Math.round(p / magnitude) * magnitude)
}

function uniqueReasons(reasons: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const reason of reasons) {
    const value = reason.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= 5) break
  }
  return out
}

function zoneMid(
  top: number | null | undefined,
  bottom: number | null | undefined
): number | null {
  if (!isNum(top) || !isNum(bottom)) return null
  const lo = Math.min(top, bottom)
  const hi = Math.max(top, bottom)
  return (lo + hi) / 2
}

const PREFERRED_TARGET_LABEL: Record<LiveLimitSource, string> = {
  SURGICAL: 'Surgical macro',
  MM_HUNT: 'MM macro',
  // An SSL bounce targets buy-side liquidity, and vice versa.
  SSL: 'BSL',
  BSL: 'SSL',
  OTE: 'Цель OTE',
  SIGNAL: 'TP1',
  RANGE: 'Граница диапазона',
}

function buildTargetOptions(
  signal: CoinSignal,
  raw: RawLimit,
  liq: LiquidityMap | null,
  mm: MmIntentSnapshot | null,
  live: LiveTicker | null
): TargetOption[] {
  const { side, entry } = raw
  const options: TargetOption[] = []
  const push = (price: number | null | undefined, label: string) => {
    if (!isNum(price)) return
    const beyond =
      side === 'LONG' ? price > entry * 1.0005 : price < entry * 0.9995
    if (!beyond) return
    const dup = options.some(
      (o) => Math.abs(o.price - price) / entry < 0.0005
    )
    if (dup) return
    options.push({ price, label })
  }

  // The setup's own target wins on equal distance (pushed first).
  push(raw.target, PREFERRED_TARGET_LABEL[raw.source])

  if (side === 'LONG') {
    push(signal.tp1, 'TP1')
    push(signal.tp2, 'TP2')
    push(liq?.nearestBSL?.price, `BSL ×${liq?.nearestBSL?.touches ?? 1}`)
    push(mm?.hunt.macroTarget, 'MM macro')
    push(live?.high24h, '24h high')
  } else {
    push(signal.tp1, 'TP1')
    push(signal.tp2, 'TP2')
    push(liq?.nearestSSL?.price, `SSL ×${liq?.nearestSSL?.touches ?? 1}`)
    push(mm?.hunt.macroTarget, 'MM macro')
    push(live?.low24h, '24h low')
  }

  return options
}

/** Nearest target that still delivers at least `minPotentialPct` */
function pickTarget(
  options: TargetOption[],
  entry: number,
  minPotentialPct: number
): TargetOption | null {
  const qualifying = options.filter(
    (o) => movePct(entry, o.price) >= minPotentialPct
  )
  if (qualifying.length === 0) return null
  qualifying.sort(
    (a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry)
  )
  return qualifying[0]
}

/** Closest structural invalidation, but never tighter than the noise floor */
function pickInvalidation(
  signal: CoinSignal,
  raw: RawLimit,
  ctx: FinalizeContext
): number | null {
  const { entry, side } = raw
  const candidates: Array<number | null | undefined> = [
    raw.invalidation,
    signal.sl,
  ]

  // Surgical invalidation belongs to the surgical limit. Reuse it only for
  // that plan (or a limit within 0.5%), otherwise the SSL/BSL stop becomes
  // unrealistically tight.
  if (
    raw.source === 'SURGICAL' ||
    (ctx.surgical?.limitEntry != null &&
      Math.abs(ctx.surgical.limitEntry - entry) / entry < 0.005)
  ) {
    candidates.push(ctx.surgical?.invalidation)
  }

  if (side === 'LONG') {
    candidates.push(
      ctx.liq?.nearestSSL?.price != null
        ? ctx.liq.nearestSSL.price * 0.997
        : null
    )
  } else {
    candidates.push(
      ctx.liq?.nearestBSL?.price != null
        ? ctx.liq.nearestBSL.price * 1.003
        : null
    )
  }

  const valid = candidates
    .filter(isNum)
    .filter((price) =>
      side === 'LONG' ? price < entry : price > entry
    )
    .map((price) => ({ price, risk: movePct(entry, price) }))
    .sort((a, b) => a.risk - b.risk)

  if (valid.length === 0) return null

  const minRisk = MIN_RISK_PCT[raw.style] ?? MIN_RISK_PCT.INTRADAY
  const aboveNoise = valid.find((v) => v.risk >= minRisk)
  return aboveNoise?.price ?? valid[valid.length - 1].price
}

function finalizeLimit(
  signal: CoinSignal,
  raw: RawLimit,
  ctx: FinalizeContext
): LiveLimitTrade | null {
  const { side, entry } = raw
  const { price } = ctx
  if (!isNum(entry) || !isNum(price)) return null

  // A pending limit must sit on the correct side of the market. Small
  // tolerance lets an already-touched zone show as FILLED instead of vanish.
  if (side === 'LONG' && entry > price * 1.0015) return null
  if (side === 'SHORT' && entry < price * 0.9985) return null

  const targets = buildTargetOptions(
    signal,
    raw,
    ctx.liq,
    ctx.mm,
    ctx.live
  )
  const target = pickTarget(targets, entry, ctx.minPotentialPct)
  if (!target) return null

  let invalidation =
    pickInvalidation(signal, raw, ctx) ??
    (side === 'LONG' ? entry * 0.994 : entry * 1.006)

  // Guarantee a sane stop and a minimum risk width.
  if (side === 'LONG' && invalidation >= entry) {
    invalidation = entry * 0.994
  }
  if (side === 'SHORT' && invalidation <= entry) {
    invalidation = entry * 1.006
  }

  const minRisk = MIN_RISK_PCT[raw.style] ?? MIN_RISK_PCT.INTRADAY
  let riskPct = movePct(entry, invalidation)
  if (riskPct < minRisk) {
    invalidation =
      side === 'LONG'
        ? entry * (1 - minRisk / 100)
        : entry * (1 + minRisk / 100)
    riskPct = minRisk
  }

  const potentialPct = movePct(entry, target.price)
  if (potentialPct < ctx.minPotentialPct - 0.001) return null

  const distancePct = movePct(price, entry)
  const filled = side === 'LONG' ? price <= entry : price >= entry
  const invalidated =
    side === 'LONG' ? price <= invalidation : price >= invalidation
  const targetHit =
    side === 'LONG' ? price >= target.price : price <= target.price

  // The opportunity is gone: level broke or price already ran to target.
  if (invalidated || targetHit) return null

  const maxDistance = MAX_DISTANCE_PCT[raw.style] ?? 8
  if (!filled && distancePct > maxDistance) return null

  const state: LiveLimitState = filled
    ? 'FILLED'
    : distancePct <= LIVE_LIMIT_IN_ZONE_PCT
      ? 'IN_ZONE'
      : distancePct <= LIVE_LIMIT_APPROACH_PCT
        ? 'APPROACHING'
        : 'WAITING'

  const riskReward = riskPct > 0 ? potentialPct / riskPct : 0

  let confidence = clamp(raw.baseConfidence, 0, 100) * 0.45 + 22
  confidence += clamp(signal.score, 0, 10) * 0.8
  confidence += (clamp(signal.probabilityPct, 0, 100) / 100) * 6
  confidence += (clamp(signal.styleConfidence ?? 0, 0, 100) / 100) * 5
  confidence += SOURCE_CONFIDENCE[raw.source]
  confidence += STATE_CONFIDENCE[state]

  const mmAgrees = ctx.mm?.preferredSide === side
  if (mmAgrees) confidence += 3
  else if (ctx.mm?.preferredSide) confidence -= 3

  const htfBias = signal.htfTrend?.bias ?? null
  const htfOpposes =
    htfBias != null &&
    htfBias !== 'RANGING' &&
    !((htfBias === 'BULLISH' && side === 'LONG') ||
      (htfBias === 'BEARISH' && side === 'SHORT'))
  if (htfBias != null && htfBias !== 'RANGING') {
    confidence += htfOpposes ? -5 : 2
  }

  const dailyOpposes =
    (signal.dailyBias === 'BULLISH' && side === 'SHORT') ||
    (signal.dailyBias === 'BEARISH' && side === 'LONG')
  if (dailyOpposes) confidence -= 5

  if (riskPct > 5) confidence -= Math.min(12, (riskPct - 5) * 2)
  if (riskReward >= 3) confidence += 2
  else if (riskReward < 1.2) confidence -= 6

  confidence = clamp(confidence, 5, 92)

  const reasons = uniqueReasons([
    ...raw.reasons,
    `Цель ${target.label} · +${potentialPct.toFixed(1)}%`,
    filled
      ? 'Лимит уже в рынке'
      : `До лимита ${distancePct.toFixed(2)}%`,
    mmAgrees ? `MM ${ctx.mm?.emoji ?? ''} → ${side}` : '',
    htfOpposes ? '⚠️ HTF против' : '',
    dailyOpposes ? '⚠️ Дневной биас против' : '',
  ])

  return {
    id: `${signal.symbol}:${side}:${raw.source}:${bucketPrice(entry)}`,
    symbol: signal.symbol,
    internalSymbol: signal.internalSymbol,
    displayName: signal.displayName,
    side,
    source: raw.source,
    style: raw.style,
    entry,
    target: target.price,
    targetLabel: target.label,
    invalidation,
    price,
    distancePct,
    potentialPct,
    riskPct,
    riskReward,
    confidence: Math.round(confidence),
    state,
    reasons,
    score: signal.score,
    change24h: ctx.live?.priceChange24h ?? signal.priceChange24h,
    updatedAt: ctx.now,
    priority: raw.priority,
  }
}

function fromSurgical(
  signal: CoinSignal,
  surgical: SurgicalEntrySnapshot | null
): RawLimit | null {
  if (!surgical) return null
  if (
    surgical.status === 'IDLE' ||
    surgical.status === 'INVALIDATED' ||
    surgical.status === 'MISSED'
  ) {
    return null
  }

  const entry =
    surgical.limitEntry ??
    zoneMid(surgical.zoneTop, surgical.zoneBottom)
  if (!isNum(entry)) return null

  const statusConfidence =
    surgical.status === 'READY'
      ? 78
      : surgical.status === 'WAITING_CONFIRM'
        ? 60
        : 52

  return {
    source: 'SURGICAL',
    side: surgical.side,
    entry,
    invalidation: surgical.invalidation,
    target: surgical.macroTarget ?? signal.tp1,
    style: signal.tradeStyle ?? 'INTRADAY',
    baseConfidence: statusConfidence,
    priority: surgical.status === 'READY' ? 100 : 80,
    reasons: [
      surgical.status === 'READY'
        ? '🎯 Surgical: лимит готов'
        : `⏳ Surgical: ${surgical.status}`,
      ...surgical.confirmations.slice(0, 2),
      surgical.reason,
    ].filter(Boolean),
  }
}

function fromLiquidity(
  signal: CoinSignal,
  liq: LiquidityMap,
  side: 'LONG' | 'SHORT'
): RawLimit | null {
  const level = side === 'LONG' ? liq.nearestSSL : liq.nearestBSL
  if (!level?.isActive || !isNum(level.price)) return null
  if (level.strength === 'WEAK') return null

  const entry =
    side === 'LONG' ? level.price * 1.0015 : level.price * 0.9985
  const invalidation =
    side === 'LONG' ? level.price * 0.992 : level.price * 1.008
  const opposite = side === 'LONG' ? liq.nearestBSL : liq.nearestSSL
  const fallbackTarget =
    side === 'LONG' ? signal.price * 1.015 : signal.price * 0.985
  const strengthBonus =
    level.strength === 'STRONG' ? 20 : level.strength === 'MEDIUM' ? 12 : 6

  return {
    source: side === 'LONG' ? 'SSL' : 'BSL',
    side,
    entry,
    invalidation,
    target: opposite?.price ?? fallbackTarget,
    style: signal.tradeStyle ?? 'INTRADAY',
    baseConfidence: 35 + strengthBonus,
    priority: 60 + strengthBonus,
    reasons: [
      `${side === 'LONG' ? 'SSL' : 'BSL'} ${level.strength} ×${level.touches}`,
      side === 'LONG'
        ? 'Лимит на sell-side ликвидности'
        : 'Лимит на buy-side ликвидности',
    ],
  }
}

function fromMmHunt(
  signal: CoinSignal,
  mm: MmIntentSnapshot | null
): RawLimit | null {
  if (!mm?.preferredSide || !isNum(mm.hunt.microTarget)) return null

  const side = mm.preferredSide
  const entry = mm.hunt.microTarget
  const invalidation = side === 'LONG' ? entry * 0.992 : entry * 1.008

  return {
    source: 'MM_HUNT',
    side,
    entry,
    invalidation,
    target: mm.hunt.macroTarget ?? signal.tp1,
    style: signal.tradeStyle ?? 'INTRADAY',
    baseConfidence: Math.min(85, 40 + mm.confidence * 0.4),
    priority: 85,
    reasons: [
      `MM ${mm.emoji} → ${side}`,
      mm.hunt.macroLabel
        ? `Магнит: ${mm.hunt.macroLabel}`
        : 'Stop-hunt → разворот',
      ...mm.reasons.slice(0, 1),
    ],
  }
}

function fromOte(
  signal: CoinSignal,
  ote: CoinSignal['ote']
): RawLimit | null {
  if (!ote?.isActive || !ote.direction) return null

  const side = ote.direction
  const entry = zoneMid(ote.zoneTop, ote.zoneBottom)
  if (!isNum(entry)) return null

  const invalidation =
    side === 'LONG' ? ote.zoneBottom * 0.997 : ote.zoneTop * 1.003

  return {
    source: 'OTE',
    side,
    entry,
    invalidation,
    target: signal.tp1,
    style: signal.tradeStyle ?? 'INTRADAY',
    baseConfidence: 52,
    priority: 65,
    reasons: [
      'OTE 0.618–0.786',
      `Импульс ${ote.impulseOrigin.toPrecision(5)} → ${ote.impulseEnd.toPrecision(5)}`,
    ],
  }
}

/**
 * Fallback limit for any directional signal: 35% retrace toward SL.
 * Keeps the tab useful even when there is no fresh liquidity/surgical data.
 */
function fromSignal(signal: CoinSignal): RawLimit | null {
  if (!signal.direction) return null
  if (!isNum(signal.sl) || !isNum(signal.tp1) || !isNum(signal.price)) {
    return null
  }

  const side = signal.direction
  const base = signal.price
  if (side === 'LONG' && signal.sl >= base) return null
  if (side === 'SHORT' && signal.sl <= base) return null

  const risk = Math.abs(base - signal.sl)
  if (!(risk > 0)) return null

  let entry =
    side === 'LONG' ? base - risk * 0.35 : base + risk * 0.35

  // Never place the limit beyond the stop.
  if (side === 'LONG' && entry <= signal.sl * 1.0005) {
    entry = base - risk * 0.2
  }
  if (side === 'SHORT' && entry >= signal.sl * 0.9995) {
    entry = base + risk * 0.2
  }
  if (side === 'LONG' && entry <= signal.sl) return null
  if (side === 'SHORT' && entry >= signal.sl) return null

  return {
    source: 'SIGNAL',
    side,
    entry,
    invalidation: signal.sl,
    target: signal.tp1,
    style: signal.tradeStyle ?? 'INTRADAY',
    baseConfidence: 40 + Math.min(10, signal.score),
    priority: 35,
    reasons: ['Откат 35% к стопу'],
  }
}

/** Last-resort 24h range limit, used only when a symbol has no other plan. */
function fromRange(live: LiveTicker | null): RawLimit | null {
  if (!live) return null
  if (!isNum(live.high24h) || !isNum(live.low24h) || !isNum(live.price)) {
    return null
  }

  const range = live.high24h - live.low24h
  if (range <= 0) return null
  const rangePct = (range / live.low24h) * 100
  if (rangePct < 3) return null

  const position = (live.price - live.low24h) / range
  if (position >= 0.45) {
    const entry = live.low24h * 1.003
    if (entry >= live.price * 0.999) return null
    return {
      source: 'RANGE',
      side: 'LONG',
      entry,
      invalidation: live.low24h * 0.994,
      target: live.high24h,
      style: 'SCALP',
      baseConfidence: 34,
      priority: 10,
      reasons: [
        `Диапазон 24ч ${rangePct.toFixed(1)}%`,
        'Лимит у нижней границы',
      ],
    }
  }

  const entry = live.high24h * 0.997
  if (entry <= live.price * 1.001) return null
  return {
    source: 'RANGE',
    side: 'SHORT',
    entry,
    invalidation: live.high24h * 1.006,
    target: live.low24h,
    style: 'SCALP',
    baseConfidence: 34,
    priority: 10,
    reasons: [
      `Диапазон 24ч ${rangePct.toFixed(1)}%`,
      'Лимит у верхней границы',
    ],
  }
}

function dedupeAndSort(
  trades: LiveLimitTrade[],
  maxResults: number
): LiveLimitTrade[] {
  const bySymbolSide = new Map<string, LiveLimitTrade[]>()
  const kept: LiveLimitTrade[] = []

  const sorted = [...trades].sort(
    (a, b) =>
      b.priority - a.priority ||
      b.confidence - a.confidence ||
      b.potentialPct - a.potentialPct
  )

  for (const trade of sorted) {
    const key = `${trade.symbol}:${trade.side}`
    const list = bySymbolSide.get(key) ?? []
    if (list.length >= 2) continue

    const nearDuplicate = list.some(
      (other) => Math.abs(other.entry - trade.entry) / trade.entry < 0.0045
    )
    if (nearDuplicate) continue

    list.push(trade)
    bySymbolSide.set(key, list)
    kept.push(trade)
  }

  kept.sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      b.confidence - a.confidence ||
      b.potentialPct - a.potentialPct
  )

  return kept.slice(0, maxResults)
}

/** Build all live limit plans, already filtered by potential and deduped. */
export function buildLiveLimitTrades(
  input: BuildLiveLimitTradesInput
): LiveLimitTrade[] {
  const minPotentialPct =
    input.minPotentialPct ?? LIVE_LIMIT_DEFAULT_MIN_POTENTIAL
  const maxResults = input.maxResults ?? 48
  const now = input.now ?? Date.now()
  const out: LiveLimitTrade[] = []

  for (const signal of input.signals) {
    const live = input.liveTickets[signal.symbol] ?? null
    const price = isNum(live?.price) ? live!.price : signal.price
    if (!isNum(price)) continue

    const liq = input.liquidityMaps?.[signal.internalSymbol] ?? null
    const mm =
      input.mmIntent?.[signal.internalSymbol] ?? signal.mmIntent ?? null
    const surgical =
      input.surgicalEntries?.[signal.internalSymbol] ??
      signal.surgicalEntry ??
      null

    const raws: RawLimit[] = []
    const push = (raw: RawLimit | null) => {
      if (raw) raws.push(raw)
    }

    push(fromSurgical(signal, surgical))
    push(fromMmHunt(signal, mm))
    push(fromOte(signal, signal.ote))
    if (liq) {
      push(fromLiquidity(signal, liq, 'LONG'))
      push(fromLiquidity(signal, liq, 'SHORT'))
    }
    push(fromSignal(signal))

    const ctx: FinalizeContext = {
      price,
      live,
      liq,
      mm,
      surgical,
      minPotentialPct,
      now,
    }

    const symbolTrades: LiveLimitTrade[] = []
    for (const raw of raws) {
      const trade = finalizeLimit(signal, raw, ctx)
      if (trade) symbolTrades.push(trade)
    }

    // Range fallback only when nothing else survived for this symbol.
    if (symbolTrades.length === 0) {
      const rangeRaw = fromRange(live)
      if (rangeRaw) {
        const trade = finalizeLimit(signal, rangeRaw, ctx)
        if (trade) symbolTrades.push(trade)
      }
    }

    out.push(...symbolTrades)
  }

  return dedupeAndSort(out, maxResults)
}

/** Small helper for the UI: average potential of the visible list. */
export function averagePotential(trades: LiveLimitTrade[]): number {
  if (trades.length === 0) return 0
  const sum = trades.reduce((acc, t) => acc + t.potentialPct, 0)
  return sum / trades.length
}
