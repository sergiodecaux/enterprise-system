import { toBaseTicker, toFlatSymbol } from '../../api/mexc'
import type { Radar141Row } from '../radar141/types'
import type { SequenceHit } from '../sequence/types'
import type {
  CoinSignal,
  LiquidityMap,
  LiveTicker,
  MmIntentSnapshot,
  OrderBookMetrics,
  SurgicalEntrySnapshot,
  WhaleWatcherState,
} from '../types'
import {
  detectSpentLiquidity,
  humanizeStoryTarget,
  pickFuelWaypoint,
  readDailyFrame,
  tfHorizon,
  type DailyFrame,
  type FuelWaypoint,
  type SpentLiquidity,
} from '../smc/chartStory'
import { buildWhaleSitMap, inferWhaleAccumulation } from '../orderbook/whaleSitLevels'
import { isSniperQuality } from '../sniperMode'
import { evaluateSessionQuality } from '../sessions/sessionQuality'

export type HuntSide = 'LONG' | 'SHORT'
export type HuntShelf = 'WAIT' | 'READY' | 'STREAM'
export type TargetQuality = 'хорошо' | 'средне'

export const SHELF_RU: Record<HuntShelf, string> = {
  WAIT: 'Ждут топливо',
  READY: 'Можно',
  STREAM: 'Стримит',
}

export interface DualHuntCard {
  symbol: string
  internalSymbol: string
  displayName: string
  ticker: string
  side: HuntSide
  shelf: HuntShelf
  shelfLabel: string
  /** Почему сейчас — одна строка, без дампа цифр */
  reason: string
  streamTo: string
  fuelWhere: string
  doNotChase: boolean
  targetQuality: TargetQuality
  distanceLabel: string
  score: number
  probability: number
  settingUp: boolean
  price: number
  priceChange24h: number
  targetPx: number
  fuelPx: number
}

export interface HuntShelfCounts {
  ready: number
  wait: number
  stream: number
}

/** Sticky shelf TTL — incumbents stay unless HARD invalidation. */
export const HUNT_STICKY_TTL_MS = 3 * 60 * 1000

export interface HuntStickyEntry {
  card: DualHuntCard
  side: HuntSide
  targetPx: number
  fuelPx: number
  atr: number
  mountedAt: number
  lastOkAt: number
  order: number
}

export type HuntStickyState = Map<string, HuntStickyEntry>

export function createHuntSticky(): HuntStickyState {
  return new Map()
}

export interface DualHuntInput {
  signals: CoinSignal[]
  radarRows: Radar141Row[]
  liquidityMaps?: Record<string, LiquidityMap>
  mmIntent?: Record<string, MmIntentSnapshot>
  surgicalEntries?: Record<string, SurgicalEntrySnapshot>
  whaleWatcher?: Record<string, WhaleWatcherState>
  liveTickets?: Record<string, LiveTicker>
  orderBookMetrics?: Record<string, OrderBookMetrics>
  sequenceHits?: Record<string, SequenceHit>
  sticky?: HuntStickyState
  now?: number
}

export interface DualHuntResult {
  longs: DualHuntCard[]
  shorts: DualHuntCard[]
  longCounts: HuntShelfCounts
  shortCounts: HuntShelfCounts
}

const LIST_CAP = 6
const MIN_SCORE_READY = 38
const MIN_SCORE_WAIT = 32
const MIN_SCORE_STREAM = 34
const MIN_BOARD_CARDS = 3
const MIN_UNIVERSE_FOR_FLOOR = 10
const SHELF_ORDER: Record<HuntShelf, number> = {
  READY: 0,
  WAIT: 1,
  STREAM: 2,
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function overlaySignal(
  signal: CoinSignal,
  mm: Record<string, MmIntentSnapshot> | undefined,
  surgical: Record<string, SurgicalEntrySnapshot> | undefined
): CoinSignal {
  const key = signal.internalSymbol
  return {
    ...signal,
    mmIntent: signal.mmIntent ?? mm?.[key] ?? null,
    surgicalEntry: signal.surgicalEntry ?? surgical?.[key] ?? null,
  }
}

function tickerOf(
  internal: string,
  symbol: string | undefined,
  tickets: Record<string, LiveTicker> | undefined
): LiveTicker | undefined {
  if (!tickets) return undefined
  return (
    (symbol ? tickets[symbol] : undefined) ??
    tickets[toFlatSymbol(internal)] ??
    tickets[internal]
  )
}

function estimateAtr(
  price: number,
  radar: Radar141Row | undefined,
  stickyAtr?: number
): number {
  if (radar && radar.atrPct > 0 && price > 0) return (radar.atrPct / 100) * price
  if (stickyAtr && stickyAtr > 0) return stickyAtr
  return price > 0 ? price * 0.008 : 0
}

function atrIsReady(radar: Radar141Row | undefined): boolean {
  return Boolean(radar && radar.atrPct > 0)
}

function barSecondsOf(signal: CoinSignal | null): number {
  if (signal?.tradeStyle === 'SCALP') return 300
  if (signal?.tradeStyle === 'SWING') return 14_400
  return 3_600
}

function sameLevel(a: number, b: number, atr: number, price: number): boolean {
  if (!(a > 0) || !(b > 0)) return false
  const tol = Math.max(atr * 0.35, price * 0.0015, Math.abs(a) * 0.0008)
  return Math.abs(a - b) <= tol
}

function freshChochFlip(side: HuntSide, signal: CoinSignal | null): boolean {
  if (!signal) return false
  if (side === 'LONG') {
    if (signal.mss?.detected && signal.mss.direction === 'BULLISH') return true
    if (signal.ltfChoCH?.detected) return true
    return false
  }
  return Boolean(signal.mss?.detected && signal.mss.direction === 'BEARISH')
}

function isChopOnly(signal: CoinSignal | null, radar: Radar141Row | undefined): boolean {
  if (radar?.volRegime === 'CHOP') return true
  if (signal?.marketRegime === 'VOLATILE_CHOP') return true
  if (signal?.memePulse?.toxic?.detected) return true
  return false
}

function isExtended(side: HuntSide, signal: CoinSignal | null, radar: Radar141Row | undefined): boolean {
  const chg = signal?.priceChange24h ?? radar?.change24h ?? 0
  if (side === 'LONG' && chg >= 12) return true
  if (side === 'SHORT' && chg <= -12) return true
  const rsi = signal?.currentRSI
  if (rsi != null) {
    if (side === 'LONG' && rsi >= 74) return true
    if (side === 'SHORT' && rsi <= 26) return true
  }
  if (radar?.trigger === 'IN_GAP' || radar?.trigger === 'EXIT_141') return true
  if (radar?.testKind === 'EXHAUSTED') return true
  return false
}

function lastStructureSide(signal: CoinSignal | null): HuntSide | null {
  if (!signal) return null
  if (signal.mss?.detected) {
    if (signal.mss.direction === 'BULLISH') return 'LONG'
    if (signal.mss.direction === 'BEARISH') return 'SHORT'
  }
  if (signal.ltfChoCH?.detected) return 'LONG'
  return null
}

function dailySideOf(
  signal: CoinSignal | null,
  radar: Radar141Row | undefined
): HuntSide | null {
  if (signal?.dailyBias === 'BULLISH') return 'LONG'
  if (signal?.dailyBias === 'BEARISH') return 'SHORT'
  if (radar?.htfBias === 'LONG' || radar?.htfBias === 'SHORT') return radar.htfBias
  return null
}

/** One coin, one side: daily + last CHoCH/MSS. Never both. */
function pickAgreedSide(
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  longCard: DualHuntCard | null,
  shortCard: DualHuntCard | null
): HuntSide | null {
  if (longCard && !shortCard) return 'LONG'
  if (shortCard && !longCard) return 'SHORT'
  if (!longCard || !shortCard) return null

  const dailySide = dailySideOf(signal, radar)
  const struct = lastStructureSide(signal)
  if (dailySide && struct && dailySide === struct) return dailySide
  if (struct && freshChochFlip(struct, signal)) return struct
  if (dailySide) return dailySide
  if (struct) return struct
  return longCard.score >= shortCard.score ? 'LONG' : 'SHORT'
}

function invalidationHit(side: HuntSide, price: number, signal: CoinSignal | null): boolean {
  const surg = signal?.surgicalEntry
  if (surg && surg.side === side && surg.status === 'INVALIDATED') return true
  const inv =
    surg && surg.side === side && surg.invalidation && surg.invalidation > 0
      ? surg.invalidation
      : signal?.invalidationPrice && signal.invalidationPrice > 0
        ? signal.invalidationPrice
        : signal?.sl && signal.sl > 0 && signal.direction === side
          ? signal.sl
          : null
  if (inv == null) return false
  return side === 'LONG' ? price <= inv : price >= inv
}

function zoneBrokenAgainst(
  side: HuntSide,
  price: number,
  atr: number,
  signal: CoinSignal | null
): boolean {
  const pad = Math.max(atr * 0.25, price * 0.001)
  const surg = signal?.surgicalEntry
  if (surg && surg.side === side && surg.status === 'MISSED') return true
  if (surg && surg.side === side && surg.zoneTop != null && surg.zoneBottom != null) {
    if (side === 'LONG' && price < surg.zoneBottom - pad) return true
    if (side === 'SHORT' && price > surg.zoneTop + pad) return true
  }
  const ote = signal?.ote
  if (ote && (ote.direction ?? side) === side) {
    if (!ote.isActive) {
      if (side === 'LONG' && price < ote.zoneBottom - pad) return true
      if (side === 'SHORT' && price > ote.zoneTop + pad) return true
    }
  }
  return false
}

function equalBothSides(
  liq: LiquidityMap | undefined,
  price: number,
  atr: number
): boolean {
  const eh = liq?.nearestBSL
  const el = liq?.nearestSSL
  if (!eh?.isActive || !el?.isActive) return false
  const dH = Math.abs(eh.price - price)
  const dL = Math.abs(el.price - price)
  const band = Math.max(atr * 1.8, price * 0.008)
  if (dH > band || dL > band) return false
  const hi = Math.max(dH, dL)
  if (!(hi > 0)) return false
  return Math.min(dH, dL) / hi >= 0.65
}

function sessionIsDead(signal: CoinSignal | null): boolean {
  const q = signal?.sessionQuality
  if (q) return q.avoid || q.session === 'DEAD' || q.session === 'ASIA'
  return evaluateSessionQuality().avoid
}

function inZoneLabel(fuel: FuelWaypoint): boolean {
  return (
    fuel.label.includes('в зоне') ||
    fuel.label.includes('дисконт') ||
    fuel.label.includes('премиум')
  )
}

function crowdedSameSide(
  side: HuntSide,
  signal: CoinSignal | null,
  liq: LiquidityMap | undefined
): boolean {
  if (!liq) return false
  const sq = signal?.memePulse?.squeeze
  const chg = signal?.priceChange24h ?? 0
  if (side === 'LONG') {
    const crowded =
      (sq?.fundingPct != null && sq.fundingPct > 0.03) ||
      (chg >= 10 && !sq?.setup)
    return crowded && !liq.nearestBSL?.isActive
  }
  const crowded =
    (sq?.fundingPct != null && sq.fundingPct < -0.03 && !sq?.inProgress) || chg <= -10
  return crowded && !liq.nearestSSL?.isActive
}

function targetClearlySwept(side: HuntSide, price: number, targetPx: number): boolean {
  if (!(targetPx > 0) || !(price > 0)) return false
  return side === 'LONG' ? price > targetPx : price < targetPx
}

function stretchTowardTarget(
  side: HuntSide,
  price: number,
  atr: number,
  fuel: FuelWaypoint,
  target: StreamTarget,
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  sticky: boolean
): { stream: boolean; drop: boolean } {
  const remaining = Math.abs(target.price - price)
  const span = Math.abs(target.price - fuel.price)
  const done = span > 0 ? 1 - remaining / span : 0
  const atrLeft = atr > 0 ? remaining / atr : 99
  if (targetClearlySwept(side, price, target.price)) return { stream: false, drop: true }

  const nearDone = done >= 0.88 || atrLeft < 0.35
  if (nearDone) return { stream: true, drop: !sticky }

  const leftFuel =
    side === 'LONG'
      ? price > fuel.price + Math.max(atr * 0.55, price * 0.002)
      : price < fuel.price - Math.max(atr * 0.55, price * 0.002)
  const squeezeOn = Boolean(
    signal?.memePulse?.squeeze?.inProgress &&
      (side === 'LONG' || signal?.memePulse?.squeeze?.shortBlocked)
  )
  const stretched = isExtended(side, signal, radar)
  const stream =
    done >= 0.55 ||
    atrLeft < 0.85 ||
    stretched ||
    squeezeOn ||
    (leftFuel && done >= 0.32)
  return { stream, drop: false }
}

function minScoreOf(shelf: HuntShelf): number {
  if (shelf === 'READY') return MIN_SCORE_READY
  if (shelf === 'WAIT') return MIN_SCORE_WAIT
  return MIN_SCORE_STREAM
}

function emptyCounts(): HuntShelfCounts {
  return { ready: 0, wait: 0, stream: 0 }
}

export function countShelves(cards: DualHuntCard[]): HuntShelfCounts {
  const out = emptyCounts()
  for (const c of cards) {
    if (c.shelf === 'READY') out.ready += 1
    else if (c.shelf === 'WAIT') out.wait += 1
    else out.stream += 1
  }
  return out
}

function capLane(cards: DualHuntCard[], incumbents: Set<string>): DualHuntCard[] {
  if (cards.length <= LIST_CAP) return cards
  const held = cards.filter((c) => incumbents.has(c.internalSymbol))
  const fresh = cards.filter((c) => !incumbents.has(c.internalSymbol))
  const out: DualHuntCard[] = []
  for (const c of held) {
    if (out.length >= LIST_CAP) return out
    out.push(c)
  }
  for (const c of fresh) {
    if (out.length >= LIST_CAP) return out
    out.push(c)
  }
  return out
}

function isSettingUp(
  side: HuntSide,
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  fuelClose: boolean
): boolean {
  const surg = signal?.surgicalEntry
  if (
    surg &&
    surg.side === side &&
    (surg.status === 'WAITING_SWEEP' || surg.status === 'WAITING_CONFIRM')
  ) {
    return true
  }
  if (signal?.ote?.priceInZone && (signal.ote.direction ?? side) === side) return true
  if (fuelClose) return true
  if (radar?.trigger === 'APPROACH_141' || radar?.trigger === 'INSIDE_141') return true
  const sq = signal?.memePulse?.squeeze
  if (sq?.setup && !sq.inProgress) return true
  return false
}

function fuelKindRu(fuel: FuelWaypoint, side: HuntSide): string {
  const where =
    fuel.where === 'below' ? 'снизу' : fuel.where === 'above' ? 'сверху' : 'в зоне'
  switch (fuel.kind) {
    case 'SSL':
      return `SSL ${where}`
    case 'BSL':
      return `BSL ${where}`
    case 'WHALE':
      return side === 'LONG' ? 'киты на бидах' : 'киты на асках'
    case 'FVG':
      return `незакрытый FVG ${where}`
    case 'SESSION':
      return `${fuel.label} ${where}`
    case 'MM':
      return fuel.label || 'охота MM'
    case 'SQUEEZE':
      return 'сжатие'
    default:
      return fuel.label ? `${fuel.label} ${where}` : `топливо ${where}`
  }
}

function inZoneFuel(
  side: HuntSide,
  price: number,
  atr: number,
  signal: CoinSignal | null,
  liq: LiquidityMap | undefined,
  whaleBelow: number | null,
  whaleAbove: number | null,
  spent: SpentLiquidity
): FuelWaypoint | null {
  const pad = Math.max(atr * 0.35, price * 0.0012)
  const ote = signal?.ote
  if (ote?.priceInZone && (ote.direction ?? side) === side) {
    return {
      price,
      label: side === 'LONG' ? 'в зоне спроса' : 'в зоне предложения',
      where: side === 'LONG' ? 'below' : 'above',
      kind: 'SWING',
    }
  }
  const surg = signal?.surgicalEntry
  if (
    surg &&
    surg.side === side &&
    surg.zoneTop != null &&
    surg.zoneBottom != null &&
    price <= surg.zoneTop &&
    price >= surg.zoneBottom &&
    surg.status === 'WAITING_SWEEP'
  ) {
    return {
      price,
      label: 'в зоне входа',
      where: side === 'LONG' ? 'below' : 'above',
      kind: 'SWING',
    }
  }
  if (
    signal?.globalFib?.inReactionZone &&
    (signal.globalFib.entryBias ?? side) === side
  ) {
    return {
      price,
      label: side === 'LONG' ? 'дисконт' : 'премиум',
      where: side === 'LONG' ? 'below' : 'above',
      kind: 'SWING',
    }
  }
  if (side === 'LONG') {
    const ssl = liq?.nearestSSL
    if (
      ssl?.isActive &&
      Math.abs(ssl.price - price) <= pad &&
      !(spent.ssl && sameLevel(ssl.price, spent.ssl.price, atr, price))
    ) {
      return { price: ssl.price, label: 'SSL', where: 'below', kind: 'SSL' }
    }
    if (
      whaleBelow != null &&
      Math.abs(whaleBelow - price) <= pad &&
      !(spent.ssl && sameLevel(whaleBelow, spent.ssl.price, atr, price))
    ) {
      return { price: whaleBelow, label: 'киты на бидах', where: 'below', kind: 'WHALE' }
    }
  } else {
    const bsl = liq?.nearestBSL
    if (
      bsl?.isActive &&
      Math.abs(bsl.price - price) <= pad &&
      !(spent.bsl && sameLevel(bsl.price, spent.bsl.price, atr, price))
    ) {
      return { price: bsl.price, label: 'BSL', where: 'above', kind: 'BSL' }
    }
    if (
      whaleAbove != null &&
      Math.abs(whaleAbove - price) <= pad &&
      !(spent.bsl && sameLevel(whaleAbove, spent.bsl.price, atr, price))
    ) {
      return { price: whaleAbove, label: 'киты на асках', where: 'above', kind: 'WHALE' }
    }
  }
  return null
}

function resolveFuel(
  side: HuntSide,
  price: number,
  atr: number,
  signal: CoinSignal | null,
  liq: LiquidityMap | undefined,
  spent: SpentLiquidity,
  whale: ReturnType<typeof buildWhaleSitMap>,
  mm: MmIntentSnapshot | null | undefined
): FuelWaypoint | null {
  const picked = pickFuelWaypoint({
    price,
    atr,
    side,
    spent,
    liquidityMap: liq ?? null,
    whale,
    mm: mm ?? null,
    signal,
  })
  const want: FuelWaypoint['where'] = side === 'LONG' ? 'below' : 'above'
  if (picked && picked.where === want) {
    const spentPool = side === 'LONG' ? spent.ssl : spent.bsl
    if (!spentPool || !sameLevel(picked.price, spentPool.price, atr, price)) {
      const sit = picked.where === 'below' ? whale.nearestBelow : whale.nearestAbove
      const magnetOnly = sit?.source === 'MAGNET' && !whale.accumulation
      if (picked.kind === 'WHALE' && magnetOnly) {
        return {
          ...picked,
          kind: side === 'LONG' ? 'SSL' : 'BSL',
          label: side === 'LONG' ? 'SSL' : 'BSL',
        }
      }
      return picked
    }
  }
  return inZoneFuel(
    side,
    price,
    atr,
    signal,
    liq,
    whale.nearestBelow?.spent ? null : whale.nearestBelow?.price ?? null,
    whale.nearestAbove?.spent ? null : whale.nearestAbove?.price ?? null,
    spent
  )
}

interface StreamTarget {
  price: number
  label: string
  distPct: number
  rMultiple: number | null
  quality: TargetQuality
}

function addTarget(
  cands: Array<{ price: number; label: string; weight: number }>,
  price: number | null | undefined,
  label: string,
  weight: number
) {
  if (price == null || !(price > 0) || !Number.isFinite(price)) return
  cands.push({ price, label, weight })
}

function pickStreamTarget(
  side: HuntSide,
  price: number,
  atr: number,
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  liq: LiquidityMap | undefined,
  spent: SpentLiquidity,
  daily: DailyFrame,
  ticker: LiveTicker | undefined,
  fuel: FuelWaypoint,
  opts?: { stickyPx?: number; loose?: boolean }
): StreamTarget | null {
  const barSec = barSecondsOf(signal)
  const horizon = tfHorizon(barSec, atr, price)
  const style = signal?.tradeStyle ?? 'INTRADAY'
  const loose = Boolean(opts?.loose)
  const minDist = loose
    ? Math.max(atr * 0.25, price * 0.0012)
    : Math.max(atr * 0.45, price * 0.0028)
  const maxPct = style === 'SCALP' ? 0.035 : style === 'SWING' ? 0.14 : 0.085
  const maxDist = Math.min(horizon.dist * 1.15, price * maxPct)
  const spentPool = side === 'LONG' ? spent.bsl : spent.ssl
  const inv =
    signal?.invalidationPrice && signal.invalidationPrice > 0
      ? signal.invalidationPrice
      : signal?.sl && signal.sl > 0
        ? signal.sl
        : fuel.price
  const stickyEps = Math.max(price * 0.0004, atr * 0.05)

  const raw: Array<{ price: number; label: string; weight: number }> = []
  if (side === 'LONG') {
    addTarget(raw, daily.magnet != null && daily.magnet > price ? daily.magnet : null, daily.magnetLabel || 'магнит дня', 96)
    addTarget(raw, ticker && ticker.high24h > price ? ticker.high24h : null, 'PDH', 92)
    if (liq?.nearestBSL?.isActive) addTarget(raw, liq.nearestBSL.price, 'BSL', 90)
    for (const eq of liq?.equalHighs ?? []) {
      if (eq.isActive) addTarget(raw, eq.price, 'равные хаи', 78)
    }
    addTarget(raw, signal?.mmIntent?.hunt.macroTarget, signal?.mmIntent?.hunt.macroLabel || 'макро MM', 84)
    addTarget(raw, signal?.surgicalEntry?.macroTarget, 'цель входа', 80)
    if (!signal?.unrealisticTp) {
      addTarget(raw, signal?.tp1, 'цель 1', 70)
      addTarget(raw, signal?.tp2, 'цель 2', 62)
      addTarget(raw, signal?.tpDaily, 'цель дня', 86)
    }
    const fib = signal?.globalFib?.price141
    if (fib != null && fib > price) addTarget(raw, fib, signal?.globalFib?.activeLabel || '141', 74)
    if (radar?.gap && radar.gap.upper.price > price) {
      addTarget(raw, radar.gap.upper.price, radar.gap.upper.label || 'gap сверху', 72)
    }
  } else {
    addTarget(raw, daily.magnet != null && daily.magnet < price ? daily.magnet : null, daily.magnetLabel || 'магнит дня', 96)
    addTarget(raw, ticker && ticker.low24h > 0 && ticker.low24h < price ? ticker.low24h : null, 'PDL', 92)
    if (liq?.nearestSSL?.isActive) addTarget(raw, liq.nearestSSL.price, 'SSL', 90)
    for (const eq of liq?.equalLows ?? []) {
      if (eq.isActive) addTarget(raw, eq.price, 'равные лои', 78)
    }
    addTarget(raw, signal?.mmIntent?.hunt.macroTarget, signal?.mmIntent?.hunt.macroLabel || 'макро MM', 84)
    addTarget(raw, signal?.surgicalEntry?.macroTarget, 'цель входа', 80)
    if (!signal?.unrealisticTp) {
      addTarget(raw, signal?.tp1, 'цель 1', 70)
      addTarget(raw, signal?.tp2, 'цель 2', 62)
      addTarget(raw, signal?.tpDaily, 'цель дня', 86)
    }
    const fib = signal?.globalFib?.price141
    if (fib != null && fib < price) addTarget(raw, fib, signal?.globalFib?.activeLabel || '141', 74)
    if (radar?.gap && radar.gap.lower.price < price) {
      addTarget(raw, radar.gap.lower.price, radar.gap.lower.label || 'gap снизу', 72)
    }
  }
  if (opts?.stickyPx && opts.stickyPx > 0) {
    addTarget(raw, opts.stickyPx, 'цель', 99)
  }

  const scored: Array<StreamTarget & { score: number }> = []
  for (const c of raw) {
    const isSticky = opts?.stickyPx != null && sameLevel(c.price, opts.stickyPx, atr, price)
    const gate = isSticky ? stickyEps : minDist
    const ahead = side === 'LONG' ? c.price > price + gate : c.price < price - gate
    if (!ahead) continue
    const dist = Math.abs(c.price - price)
    if (dist < gate || (!isSticky && dist > maxDist)) continue
    if (spentPool && sameLevel(c.price, spentPool.price, atr, price)) continue
    if (sameLevel(c.price, fuel.price, atr, price)) continue

    const distPct = price > 0 ? (dist / price) * 100 : 0
    const atrMult = atr > 0 ? dist / atr : 0
    const risk = inv > 0 ? Math.abs(price - inv) : 0
    const rMultiple = risk > 0 ? dist / risk : null
    const minR = loose || isSticky ? 0.45 : 0.75
    if (rMultiple != null && rMultiple < minR) continue
    if (!loose && !isSticky && rMultiple != null && rMultiple > 6 && c.weight < 90) continue

    const rOk = rMultiple != null && rMultiple >= 1 && rMultiple <= 3.2
    const atrOk = atrMult >= 0.8 && atrMult <= 3.2
    const quality: TargetQuality = rOk || atrOk ? 'хорошо' : 'средне'
    const rScore =
      rMultiple == null ? 4 : rOk ? 18 : rMultiple > 3.2 && rMultiple <= 4.5 ? 6 : 0
    scored.push({
      price: c.price,
      label: c.label,
      distPct,
      rMultiple,
      quality,
      score: c.weight + rScore - Math.abs(atrMult - 1.8) * 3,
    })
  }
  if (!scored.length) return null
  scored.sort((a, b) => b.score - a.score)
  const hit = scored[0]
  return {
    price: hit.price,
    label: hit.label,
    distPct: hit.distPct,
    rMultiple: hit.rMultiple,
    quality: hit.quality,
  }
}

function dailyBlocksLong(
  daily: DailyFrame,
  price: number,
  flipped: boolean
): boolean {
  if (flipped) return false
  if (daily.side !== 'SHORT') return false
  if (daily.magnet != null && daily.magnet < price) return true
  return true
}

function dailyBlocksShort(
  daily: DailyFrame,
  price: number,
  flipped: boolean
): boolean {
  if (flipped) return false
  if (daily.side !== 'LONG') return false
  if (daily.magnet != null && daily.magnet > price) return true
  return true
}

function whyNow(
  side: HuntSide,
  shelf: HuntShelf,
  fuel: FuelWaypoint,
  target: StreamTarget,
  signal: CoinSignal | null
): string {
  const dest = humanizeStoryTarget(target.label, side)
  if (shelf === 'STREAM') {
    return side === 'LONG'
      ? `уже идут на ${dest} — не догонять`
      : `уже сыплются к ${dest} — не догонять`
  }
  if (shelf === 'WAIT') {
    const surg = signal?.surgicalEntry
    if (surg && surg.side === side && surg.status === 'WAITING_SWEEP') {
      return side === 'LONG'
        ? `ждут свип снизу → потом на ${dest}`
        : `ждут свип сверху → потом на ${dest}`
    }
    return side === 'LONG'
      ? `ждут топливо снизу → потом на ${dest}`
      : `ждут топливо сверху → потом на ${dest}`
  }
  const surg = signal?.surgicalEntry
  if (surg && surg.side === side && surg.status === 'WAITING_SWEEP') {
    return side === 'LONG' ? `ждут свип снизу → на ${dest}` : `ждут свип сверху → на ${dest}`
  }
  if (fuel.kind === 'WHALE') {
    return side === 'LONG' ? `киты на бидах → на ${dest}` : `киты на асках → на ${dest}`
  }
  if (inZoneLabel(fuel)) {
    return side === 'LONG' ? `сидят в спросе → на ${dest}` : `сидят в предложении → на ${dest}`
  }
  if (signal?.mss?.detected && (signal.mss.direction === 'BULLISH') === (side === 'LONG')) {
    return side === 'LONG' ? `CHoCH вверх, цель ${dest}` : `CHoCH вниз, цель ${dest}`
  }
  return side === 'LONG'
    ? `топливо рядом → на ${dest}`
    : `топливо рядом → на ${dest}`
}

function huntScore(opts: {
  side: HuntSide
  signal: CoinSignal | null
  radar: Radar141Row | undefined
  fuel: FuelWaypoint
  target: StreamTarget
  daily: DailyFrame
  settingUp: boolean
  whaleSide: HuntSide | null
}): number {
  const { side, signal, radar, fuel, target, daily, settingUp, whaleSide } = opts
  let score = 28
  if (target.quality === 'хорошо') score += 18
  else score += 8
  if (target.rMultiple != null && target.rMultiple >= 1 && target.rMultiple <= 3.2) score += 12
  if (fuel.kind === 'SSL' || fuel.kind === 'BSL' || fuel.kind === 'WHALE' || fuel.kind === 'FVG') {
    score += 10
  } else if (fuel.kind === 'SWING' || fuel.kind === 'SESSION') {
    score += 8
  }
  if (settingUp) score += 10
  if (daily.side === side) score += 12
  else if (daily.side == null) score += 2

  if (signal && isSniperQuality(signal) && signal.direction === side) score += 10
  if (whaleSide === side) score += 8
  else if (whaleSide && whaleSide !== side) score -= 6

  if (signal?.scoreCard?.ready && signal.scoreCard.direction === side) score += 8
  if (radar?.liquidityGrade === 'A') score += 6
  else if (radar?.liquidityGrade === 'B') score += 3
  else if (radar?.liquidityGrade === 'D') score -= 10

  if (radar?.newsRisk) score -= 6
  if (isExtended(side, signal, radar) && !settingUp) score -= 16
  if (signal?.unrealisticTp) score -= 10

  const mm = signal?.mmIntent
  if (mm?.preferredSide === side && mm.confidence >= 50) score += 6
  else if (mm?.preferredSide && mm.preferredSide !== side) score -= 6

  return clamp(Math.round(score), 0, 100)
}

function probabilityOf(
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  hunt: number
): number {
  if (signal && signal.probabilityPct > 0) return Math.round(signal.probabilityPct)
  if (signal?.scoreCard?.percent) return Math.round(signal.scoreCard.percent)
  if (radar?.gap?.flyProb) return Math.round(radar.gap.flyProb)
  if (radar) return Math.round(radar.opportunityScore)
  return hunt
}

type HardKill =
  | 'target_swept'
  | 'zone_broken'
  | 'invalidation'
  | 'fuel_gone'
  | 'opp_choch'
  | 'daily_against'

interface SideJudge {
  ready: boolean
  hard: HardKill | null
  quality: DualHuntCard | null
  floor: DualHuntCard | null
  targetPx: number | null
  fuelPx: number | null
  atr: number
}

function dailySideKnown(
  signal: CoinSignal | null,
  radar: Radar141Row | undefined
): boolean {
  if (signal?.dailyBias === 'BULLISH' || signal?.dailyBias === 'BEARISH') return true
  return radar?.htfBias === 'LONG' || radar?.htfBias === 'SHORT'
}

function spentFlagsReady(
  signal: CoinSignal | null,
  liq: LiquidityMap | undefined,
  sequence: SequenceHit | null | undefined
): boolean {
  if (liq) return true
  if (sequence) return true
  if (signal?.raid) return true
  if (signal?.mss?.detected) return true
  if (signal?.ltfChoCH?.detected) return true
  return Boolean(signal)
}

function judgementReady(
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  liq: LiquidityMap | undefined,
  sequence: SequenceHit | null | undefined
): boolean {
  if (!dailySideKnown(signal, radar)) return false
  if (!atrIsReady(radar)) return false
  if (!spentFlagsReady(signal, liq, sequence)) return false
  return true
}

function oppositeChoch(side: HuntSide, signal: CoinSignal | null): boolean {
  const struct = lastStructureSide(signal)
  if (!struct || struct === side) return false
  return freshChochFlip(struct, signal)
}

function junkLongVsSpentDaily(
  side: HuntSide,
  daily: DailyFrame,
  spent: SpentLiquidity,
  price: number,
  flipped: boolean
): boolean {
  if (side !== 'LONG' || flipped) return false
  if (daily.side !== 'SHORT') return false
  if (spent.bsl) return true
  if (daily.magnet != null && daily.magnet < price) return true
  return true
}

function applyDaily(
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  spent: SpentLiquidity,
  price: number,
  atr: number
): DailyFrame {
  const daily = readDailyFrame({ signal, spent, price, atr })
  if (!daily.side && radar?.htfBias && radar.htfBias !== 'FLAT') {
    daily.side = radar.htfBias
    daily.bias = radar.htfBias === 'LONG' ? 'BULLISH' : 'BEARISH'
  }
  return daily
}

function makeCard(
  side: HuntSide,
  internal: string,
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  ticker: LiveTicker | undefined,
  shelf: HuntShelf,
  fuel: FuelWaypoint,
  target: StreamTarget,
  score: number,
  settingUp: boolean,
  price: number
): DualHuntCard {
  return {
    symbol: signal?.symbol ?? toFlatSymbol(internal),
    internalSymbol: internal,
    displayName: signal?.displayName ?? radar?.displayName ?? internal,
    ticker: toBaseTicker(internal),
    side,
    shelf,
    shelfLabel: SHELF_RU[shelf],
    reason: whyNow(side, shelf, fuel, target, signal),
    streamTo: humanizeStoryTarget(target.label, side),
    fuelWhere: fuelKindRu(fuel, side),
    doNotChase: shelf === 'STREAM',
    targetQuality: target.quality,
    distanceLabel: `≈${target.distPct.toFixed(1)}%`,
    score,
    probability: probabilityOf(signal, radar, score),
    settingUp,
    price,
    priceChange24h: signal?.priceChange24h ?? radar?.change24h ?? ticker?.priceChange24h ?? 0,
    targetPx: target.price,
    fuelPx: fuel.price,
  }
}

function pickShelf(
  stretchStream: boolean,
  fuelClose: boolean,
  inZone: boolean,
  signal: CoinSignal | null,
  liq: LiquidityMap | undefined,
  side: HuntSide,
  forceWait: boolean
): HuntShelf {
  if (stretchStream) return 'STREAM'
  if (forceWait) return 'WAIT'
  if (fuelClose || inZone) {
    if (sessionIsDead(signal) && !inZone) return 'WAIT'
    if (crowdedSameSide(side, signal, liq)) return 'WAIT'
    return 'READY'
  }
  return 'WAIT'
}

function evaluateSide(
  side: HuntSide,
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  liq: LiquidityMap | undefined,
  whaleState: WhaleWatcherState | null | undefined,
  mm: MmIntentSnapshot | null | undefined,
  ticker: LiveTicker | undefined,
  sequence: SequenceHit | null | undefined,
  walls: OrderBookMetrics | undefined,
  sticky: HuntStickyEntry | null
): SideJudge {
  const blank: SideJudge = {
    ready: false,
    hard: null,
    quality: null,
    floor: null,
    targetPx: sticky?.targetPx ?? null,
    fuelPx: sticky?.fuelPx ?? null,
    atr: sticky?.atr ?? 0,
  }
  const internal = signal?.internalSymbol ?? radar?.internalSymbol
  if (!internal) return blank
  const price = signal?.price ?? radar?.price ?? ticker?.price ?? 0
  if (!(price > 0)) return blank

  const atr = estimateAtr(price, radar, sticky?.atr)
  const ready = judgementReady(signal, radar, liq, sequence)

  if (invalidationHit(side, price, signal)) {
    return { ...blank, ready, hard: 'invalidation', atr }
  }
  if (zoneBrokenAgainst(side, price, atr, signal)) {
    return { ...blank, ready, hard: 'zone_broken', atr }
  }
  if (oppositeChoch(side, signal)) {
    return { ...blank, ready, hard: 'opp_choch', atr }
  }
  if (sticky && targetClearlySwept(side, price, sticky.targetPx)) {
    return { ...blank, ready, hard: 'target_swept', atr }
  }

  if (!ready) return { ...blank, atr }

  const spent = detectSpentLiquidity({
    candles: [],
    price,
    atr,
    signal,
    liquidityMap: liq ?? null,
    sequence: sequence ?? null,
  })
  const whaleMap = buildWhaleSitMap({
    price,
    whale: whaleState ?? null,
    liquidityMap: liq ?? null,
    walls: walls?.walls ?? null,
    spent,
  })
  const daily = applyDaily(signal, radar, spent, price, atr)
  const flipped = freshChochFlip(side, signal)
  if (junkLongVsSpentDaily(side, daily, spent, price, flipped)) {
    return { ...blank, ready: true, hard: 'daily_against', atr }
  }
  if (side === 'LONG' && dailyBlocksLong(daily, price, flipped)) {
    return { ...blank, ready: true, hard: 'daily_against', atr }
  }
  if (side === 'SHORT' && dailyBlocksShort(daily, price, flipped)) {
    return { ...blank, ready: true, hard: 'daily_against', atr }
  }

  const fuel = resolveFuel(side, price, atr, signal, liq, spent, whaleMap, mm)
  if (!fuel) {
    return { ...blank, ready: true, hard: 'fuel_gone', atr }
  }

  const target = pickStreamTarget(
    side,
    price,
    atr,
    signal,
    radar,
    liq,
    spent,
    daily,
    ticker,
    fuel,
    { stickyPx: sticky?.targetPx, loose: Boolean(sticky) }
  )
  const floorTarget =
    target ??
    pickStreamTarget(
      side,
      price,
      atr,
      signal,
      radar,
      liq,
      spent,
      daily,
      ticker,
      fuel,
      { stickyPx: sticky?.targetPx, loose: true }
    )
  if (!floorTarget) {
    const hard: HardKill | null =
      sticky && targetClearlySwept(side, price, sticky.targetPx) ? 'target_swept' : null
    return { ...blank, ready: true, hard, fuelPx: fuel.price, atr }
  }
  if (targetClearlySwept(side, price, floorTarget.price)) {
    return { ...blank, ready: true, hard: 'target_swept', fuelPx: fuel.price, atr }
  }

  const softChop = isChopOnly(signal, radar) && !flipped
  const softThin = radar?.liquidityGrade === 'D' && !signal?.hasActiveSetup
  const softEqual = equalBothSides(liq, price, atr) && !flipped
  const fuelClose =
    Math.abs(fuel.price - price) <= Math.max(atr * 0.9, price * 0.004) ||
    inZoneLabel(fuel)
  const inZone = inZoneLabel(fuel)
  const settingUp = isSettingUp(side, signal, radar, fuelClose)
  const useTarget = target ?? floorTarget
  const stretch = stretchTowardTarget(
    side,
    price,
    atr,
    fuel,
    useTarget,
    signal,
    radar,
    Boolean(sticky)
  )
  if (stretch.drop && !sticky) {
    return {
      ...blank,
      ready: true,
      hard: targetClearlySwept(side, price, useTarget.price) ? 'target_swept' : null,
      fuelPx: fuel.price,
      targetPx: useTarget.price,
      atr,
    }
  }

  const whaleAcc = inferWhaleAccumulation(whaleState) ?? (
    whaleMap.accumulation
      ? { side: whaleMap.accumulation, reason: whaleMap.accumulationReason ?? '' }
      : null
  )
  const score = huntScore({
    side,
    signal,
    radar,
    fuel,
    target: useTarget,
    daily,
    settingUp,
    whaleSide: whaleAcc?.side ?? null,
  })

  const qualityShelf = pickShelf(stretch.stream, fuelClose, inZone, signal, liq, side, false)
  const qualityOk =
    Boolean(target) &&
    !stretch.drop &&
    !softChop &&
    !softThin &&
    !softEqual &&
    score >= minScoreOf(qualityShelf)

  const quality = qualityOk
    ? makeCard(
        side,
        internal,
        signal,
        radar,
        ticker,
        qualityShelf,
        fuel,
        target ?? useTarget,
        score,
        settingUp,
        price
      )
    : null

  const floorShelf = pickShelf(stretch.stream, fuelClose, inZone, signal, liq, side, true)
  const floor =
    !quality && !softChop && !softThin
      ? makeCard(
          side,
          internal,
          signal,
          radar,
          ticker,
          floorShelf,
          fuel,
          useTarget,
          score,
          settingUp,
          price
        )
      : null

  return {
    ready: true,
    hard: null,
    quality,
    floor,
    targetPx: useTarget.price,
    fuelPx: fuel.price,
    atr,
  }
}

function refreshStickyCard(
  prev: DualHuntCard,
  next: DualHuntCard | null,
  price: number,
  ticker: LiveTicker | undefined
): DualHuntCard {
  if (!next) {
    return {
      ...prev,
      price: price > 0 ? price : prev.price,
      priceChange24h: ticker?.priceChange24h ?? prev.priceChange24h,
    }
  }
  let shelf = next.shelf
  if (prev.shelf === 'READY' && (next.shelf === 'WAIT' || next.shelf === 'STREAM')) {
    shelf = next.shelf
  } else if (prev.shelf === 'WAIT' && next.shelf === 'STREAM') {
    shelf = 'STREAM'
  } else if (next.shelf === 'READY' || next.shelf === prev.shelf) {
    shelf = next.shelf
  } else {
    shelf = prev.shelf
  }
  return {
    ...next,
    shelf,
    shelfLabel: SHELF_RU[shelf],
    doNotChase: shelf === 'STREAM',
  }
}

function rankStable(
  a: DualHuntCard,
  b: DualHuntCard,
  prevOrder: Map<string, number>
): number {
  if (SHELF_ORDER[a.shelf] !== SHELF_ORDER[b.shelf]) {
    return SHELF_ORDER[a.shelf] - SHELF_ORDER[b.shelf]
  }
  const ia = prevOrder.get(a.internalSymbol)
  const ib = prevOrder.get(b.internalSymbol)
  if (ia != null && ib != null && ia !== ib) return ia - ib
  if (ia != null && ib == null) return -1
  if (ia == null && ib != null) return 1
  if (a.targetQuality !== b.targetQuality) {
    return a.targetQuality === 'хорошо' ? -1 : 1
  }
  if (a.internalSymbol !== b.internalSymbol) {
    return a.internalSymbol.localeCompare(b.internalSymbol)
  }
  return b.score - a.score
}

/**
 * Tradable hunt: long only with unused fuel below/in-zone and an unused
 * target above; short only with the inverse. Same scanner universe.
 */
export function buildDualHunt(input: DualHuntInput): DualHuntResult {
  const now = input.now ?? Date.now()
  const sticky = input.sticky
  const radarByKey = new Map<string, Radar141Row>()
  for (const row of input.radarRows) {
    radarByKey.set(row.internalSymbol, row)
    radarByKey.set(row.symbol, row)
    radarByKey.set(toFlatSymbol(row.internalSymbol), row)
  }

  const seen = new Set<string>()
  const qualityLongs: DualHuntCard[] = []
  const qualityShorts: DualHuntCard[] = []
  const floorLongs: DualHuntCard[] = []
  const floorShorts: DualHuntCard[] = []
  const stickyKeep: DualHuntCard[] = []
  const hardDead = new Set<string>()
  const renewed = new Set<string>()
  let judged = 0
  let universe = 0

  const consider = (signal: CoinSignal | null, radarHint?: Radar141Row) => {
    const radar =
      radarHint ??
      (signal
        ? radarByKey.get(signal.internalSymbol) ?? radarByKey.get(signal.symbol)
        : undefined)
    const key = signal?.internalSymbol ?? radar?.internalSymbol
    if (!key || seen.has(key)) return
    seen.add(key)
    universe += 1

    const liq = input.liquidityMaps?.[key]
    const whale = input.whaleWatcher?.[key] ?? null
    const mm = signal?.mmIntent ?? input.mmIntent?.[key]
    const ticker = tickerOf(key, signal?.symbol ?? radar?.symbol, input.liveTickets)
    const sequence =
      input.sequenceHits?.[key] ??
      (signal ? input.sequenceHits?.[signal.symbol] : undefined)
    const walls = input.orderBookMetrics?.[key]
    const held = sticky?.get(key) ?? null
    const price = signal?.price ?? radar?.price ?? ticker?.price ?? held?.card.price ?? 0

    const longJ = evaluateSide(
      'LONG',
      signal,
      radar,
      liq,
      whale,
      mm,
      ticker,
      sequence,
      walls,
      held?.side === 'LONG' ? held : null
    )
    const shortJ = evaluateSide(
      'SHORT',
      signal,
      radar,
      liq,
      whale,
      mm,
      ticker,
      sequence,
      walls,
      held?.side === 'SHORT' ? held : null
    )
    if (longJ.ready || shortJ.ready) judged += 1

    let keep: HuntSide | null = null
    if (held) {
      const mine = held.side === 'LONG' ? longJ : shortJ
      if (!mine.hard) keep = held.side
      else {
        hardDead.add(key)
        const other = held.side === 'LONG' ? shortJ : longJ
        if (other.quality) keep = held.side === 'LONG' ? 'SHORT' : 'LONG'
      }
    } else {
      keep = pickAgreedSide(signal, radar, longJ.quality, shortJ.quality)
      if (!keep) {
        keep = pickAgreedSide(signal, radar, longJ.floor, shortJ.floor)
      }
    }

    const pick = keep === 'SHORT' ? shortJ : keep === 'LONG' ? longJ : null
    if (!pick || !keep) {
      if (held && now - held.lastOkAt < HUNT_STICKY_TTL_MS && !hardDead.has(key)) {
        stickyKeep.push(refreshStickyCard(held.card, null, price, ticker))
      }
      return
    }

    if (pick.quality) {
      const card = held
        ? refreshStickyCard(held.card, pick.quality, price, ticker)
        : pick.quality
      renewed.add(key)
      if (keep === 'LONG') qualityLongs.push(card)
      else qualityShorts.push(card)
      return
    }

    if (held && pick.floor && !pick.hard) {
      renewed.add(key)
      stickyKeep.push(refreshStickyCard(held.card, pick.floor, price, ticker))
      return
    }

    if (held && !pick.hard && now - held.lastOkAt < HUNT_STICKY_TTL_MS) {
      stickyKeep.push(refreshStickyCard(held.card, null, price, ticker))
      return
    }

    if (pick.floor) {
      renewed.add(key)
      if (keep === 'LONG') floorLongs.push(pick.floor)
      else floorShorts.push(pick.floor)
    }
  }

  for (const raw of input.signals) {
    consider(overlaySignal(raw, input.mmIntent, input.surgicalEntries))
  }
  for (const row of input.radarRows) {
    consider(null, row)
  }

  const prevOrder = new Map<string, number>()
  if (sticky) {
    for (const [k, e] of sticky) prevOrder.set(k, e.order)
  }

  const incumbents = new Set(prevOrder.keys())
  const takeSticky = (side: HuntSide) =>
    stickyKeep.filter((c) => c.side === side)

  let longs = [...qualityLongs, ...takeSticky('LONG')]
  let shorts = [...qualityShorts, ...takeSticky('SHORT')]

  const dataFull = universe >= MIN_UNIVERSE_FOR_FLOOR && judged >= Math.min(8, universe)
  if (dataFull && longs.length + shorts.length < MIN_BOARD_CARDS) {
    const have = new Set([...longs, ...shorts].map((c) => c.internalSymbol))
    const fill = [...floorLongs, ...floorShorts]
      .filter((c) => !have.has(c.internalSymbol))
      .sort((a, b) => rankStable(a, b, prevOrder))
    for (const c of fill) {
      if (longs.length + shorts.length >= MIN_BOARD_CARDS) break
      if (c.side === 'LONG') longs.push(c)
      else shorts.push(c)
      have.add(c.internalSymbol)
    }
  }

  longs.sort((a, b) => rankStable(a, b, prevOrder))
  shorts.sort((a, b) => rankStable(a, b, prevOrder))
  longs = capLane(longs, incumbents)
  shorts = capLane(shorts, incumbents)

  if (sticky) {
    const live = [...longs, ...shorts]
    const liveKeys = new Set(live.map((c) => c.internalSymbol))
    for (const [k, e] of [...sticky.entries()]) {
      if (hardDead.has(k)) {
        sticky.delete(k)
        continue
      }
      if (!liveKeys.has(k) && now - e.lastOkAt >= HUNT_STICKY_TTL_MS) {
        sticky.delete(k)
      }
    }
    live.forEach((card, i) => {
      const prev = sticky.get(card.internalSymbol)
      sticky.set(card.internalSymbol, {
        card,
        side: card.side,
        targetPx: card.targetPx,
        fuelPx: card.fuelPx,
        atr: prev?.atr && prev.atr > 0 ? prev.atr : estimateAtr(card.price, radarByKey.get(card.internalSymbol)),
        mountedAt: prev?.mountedAt ?? now,
        lastOkAt: renewed.has(card.internalSymbol) ? now : prev?.lastOkAt ?? now,
        order: prev?.order ?? 1000 + i,
      })
    })
  }

  return {
    longs,
    shorts,
    longCounts: countShelves(longs),
    shortCounts: countShelves(shorts),
  }
}
