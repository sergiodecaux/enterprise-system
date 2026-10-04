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
}

export interface HuntShelfCounts {
  ready: number
  wait: number
  stream: number
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

function estimateAtr(price: number, radar: Radar141Row | undefined): number {
  if (radar && radar.atrPct > 0 && price > 0) return (radar.atrPct / 100) * price
  return price > 0 ? price * 0.008 : 0
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

function stretchTowardTarget(
  side: HuntSide,
  price: number,
  atr: number,
  fuel: FuelWaypoint,
  target: StreamTarget,
  signal: CoinSignal | null,
  radar: Radar141Row | undefined
): { stream: boolean; drop: boolean } {
  const remaining = Math.abs(target.price - price)
  const span = Math.abs(target.price - fuel.price)
  const done = span > 0 ? 1 - remaining / span : 0
  const atrLeft = atr > 0 ? remaining / atr : 99
  if (done >= 0.88 || atrLeft < 0.35) return { stream: true, drop: true }
  if (sameLevel(price, target.price, atr, price)) return { stream: false, drop: true }
  if (side === 'LONG' && price >= target.price) return { stream: false, drop: true }
  if (side === 'SHORT' && price <= target.price) return { stream: false, drop: true }

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

function capLane(cards: DualHuntCard[]): DualHuntCard[] {
  const ready = cards.filter((c) => c.shelf === 'READY')
  const wait = cards.filter((c) => c.shelf === 'WAIT')
  const stream = cards.filter((c) => c.shelf === 'STREAM')
  const out: DualHuntCard[] = []
  for (const pack of [ready, wait, stream]) {
    for (const c of pack) {
      if (out.length >= LIST_CAP) return out
      out.push(c)
    }
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
  fuel: FuelWaypoint
): StreamTarget | null {
  const barSec = barSecondsOf(signal)
  const horizon = tfHorizon(barSec, atr, price)
  const style = signal?.tradeStyle ?? 'INTRADAY'
  const minDist = Math.max(atr * 0.45, price * 0.0028)
  const maxPct = style === 'SCALP' ? 0.035 : style === 'SWING' ? 0.14 : 0.085
  const maxDist = Math.min(horizon.dist * 1.15, price * maxPct)
  const spentPool = side === 'LONG' ? spent.bsl : spent.ssl
  const inv =
    signal?.invalidationPrice && signal.invalidationPrice > 0
      ? signal.invalidationPrice
      : signal?.sl && signal.sl > 0
        ? signal.sl
        : fuel.price

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

  const scored: Array<StreamTarget & { score: number }> = []
  for (const c of raw) {
    const ahead = side === 'LONG' ? c.price > price + minDist : c.price < price - minDist
    if (!ahead) continue
    const dist = Math.abs(c.price - price)
    if (dist < minDist || dist > maxDist) continue
    if (spentPool && sameLevel(c.price, spentPool.price, atr, price)) continue
    if (sameLevel(c.price, fuel.price, atr, price)) continue

    const distPct = price > 0 ? (dist / price) * 100 : 0
    const atrMult = atr > 0 ? dist / atr : 0
    const risk = inv > 0 ? Math.abs(price - inv) : 0
    const rMultiple = risk > 0 ? dist / risk : null
    if (rMultiple != null && rMultiple < 0.75) continue
    if (rMultiple != null && rMultiple > 6 && c.weight < 90) continue

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

function evaluateSide(
  side: HuntSide,
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  liq: LiquidityMap | undefined,
  whaleState: WhaleWatcherState | null | undefined,
  mm: MmIntentSnapshot | null | undefined,
  ticker: LiveTicker | undefined,
  sequence: SequenceHit | null | undefined,
  walls: OrderBookMetrics | undefined
): DualHuntCard | null {
  const internal = signal?.internalSymbol ?? radar?.internalSymbol
  if (!internal) return null
  const price = signal?.price ?? radar?.price ?? ticker?.price ?? 0
  if (!(price > 0)) return null
  if (radar?.liquidityGrade === 'D' && !signal?.hasActiveSetup) return null
  if (isChopOnly(signal, radar) && !freshChochFlip(side, signal)) return null

  const atr = estimateAtr(price, radar)
  if (invalidationHit(side, price, signal)) return null
  if (zoneBrokenAgainst(side, price, atr, signal)) return null
  if (equalBothSides(liq, price, atr) && !freshChochFlip(side, signal)) return null
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

  const daily = readDailyFrame({
    signal,
    spent,
    price,
    atr,
  })
  if (!daily.side && radar?.htfBias && radar.htfBias !== 'FLAT') {
    daily.side = radar.htfBias
    daily.bias = radar.htfBias === 'LONG' ? 'BULLISH' : 'BEARISH'
  }
  const flipped = freshChochFlip(side, signal)
  if (side === 'LONG' && dailyBlocksLong(daily, price, flipped)) return null
  if (side === 'SHORT' && dailyBlocksShort(daily, price, flipped)) return null

  const fuel = resolveFuel(side, price, atr, signal, liq, spent, whaleMap, mm)
  if (!fuel) return null

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
    fuel
  )
  if (!target) return null

  const fuelClose =
    Math.abs(fuel.price - price) <= Math.max(atr * 0.9, price * 0.004) ||
    inZoneLabel(fuel)
  const inZone = inZoneLabel(fuel)
  const settingUp = isSettingUp(side, signal, radar, fuelClose)
  const stretch = stretchTowardTarget(side, price, atr, fuel, target, signal, radar)
  if (stretch.drop) return null

  let shelf: HuntShelf
  if (stretch.stream) {
    shelf = 'STREAM'
  } else if (fuelClose || inZone) {
    shelf = 'READY'
    if (sessionIsDead(signal) && !inZone) shelf = 'WAIT'
    if (crowdedSameSide(side, signal, liq)) shelf = 'WAIT'
  } else {
    shelf = 'WAIT'
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
    target,
    daily,
    settingUp,
    whaleSide: whaleAcc?.side ?? null,
  })
  if (score < minScoreOf(shelf)) return null

  const destName = humanizeStoryTarget(target.label, side)
  const doNotChase = shelf === 'STREAM'
  return {
    symbol: signal?.symbol ?? toFlatSymbol(internal),
    internalSymbol: internal,
    displayName: signal?.displayName ?? radar?.displayName ?? internal,
    ticker: toBaseTicker(internal),
    side,
    shelf,
    shelfLabel: SHELF_RU[shelf],
    reason: whyNow(side, shelf, fuel, target, signal),
    streamTo: destName,
    fuelWhere: fuelKindRu(fuel, side),
    doNotChase,
    targetQuality: target.quality,
    distanceLabel: `≈${target.distPct.toFixed(1)}%`,
    score,
    probability: probabilityOf(signal, radar, score),
    settingUp,
    price,
    priceChange24h: signal?.priceChange24h ?? radar?.change24h ?? ticker?.priceChange24h ?? 0,
  }
}

/**
 * Tradable hunt: long only with unused fuel below/in-zone and an unused
 * target above; short only with the inverse. Same scanner universe.
 */
export function buildDualHunt(input: DualHuntInput): DualHuntResult {
  const radarByKey = new Map<string, Radar141Row>()
  for (const row of input.radarRows) {
    radarByKey.set(row.internalSymbol, row)
    radarByKey.set(row.symbol, row)
    radarByKey.set(toFlatSymbol(row.internalSymbol), row)
  }

  const seen = new Set<string>()
  const longs: DualHuntCard[] = []
  const shorts: DualHuntCard[] = []

  const consider = (signal: CoinSignal | null, radarHint?: Radar141Row) => {
    const radar =
      radarHint ??
      (signal
        ? radarByKey.get(signal.internalSymbol) ?? radarByKey.get(signal.symbol)
        : undefined)
    const key = signal?.internalSymbol ?? radar?.internalSymbol
    if (!key || seen.has(key)) return
    seen.add(key)

    const liq = input.liquidityMaps?.[key]
    const whale = input.whaleWatcher?.[key] ?? null
    const mm = signal?.mmIntent ?? input.mmIntent?.[key]
    const ticker = tickerOf(key, signal?.symbol ?? radar?.symbol, input.liveTickets)
    const sequence =
      input.sequenceHits?.[key] ??
      (signal ? input.sequenceHits?.[signal.symbol] : undefined)
    const walls = input.orderBookMetrics?.[key]

    const longCard = evaluateSide(
      'LONG',
      signal,
      radar,
      liq,
      whale,
      mm,
      ticker,
      sequence,
      walls
    )
    const shortCard = evaluateSide(
      'SHORT',
      signal,
      radar,
      liq,
      whale,
      mm,
      ticker,
      sequence,
      walls
    )

    const keep = pickAgreedSide(signal, radar, longCard, shortCard)
    if (keep === 'LONG' && longCard) longs.push(longCard)
    else if (keep === 'SHORT' && shortCard) shorts.push(shortCard)
  }

  for (const raw of input.signals) {
    consider(overlaySignal(raw, input.mmIntent, input.surgicalEntries))
  }
  for (const row of input.radarRows) {
    consider(null, row)
  }

  const rank = (a: DualHuntCard, b: DualHuntCard) => {
    if (SHELF_ORDER[a.shelf] !== SHELF_ORDER[b.shelf]) {
      return SHELF_ORDER[a.shelf] - SHELF_ORDER[b.shelf]
    }
    if (a.targetQuality !== b.targetQuality) {
      return a.targetQuality === 'хорошо' ? -1 : 1
    }
    if (a.settingUp !== b.settingUp) return a.settingUp ? -1 : 1
    if (b.score !== a.score) return b.score - a.score
    return b.probability - a.probability
  }

  longs.sort(rank)
  shorts.sort(rank)

  const longCounts = countShelves(longs)
  const shortCounts = countShelves(shorts)

  return {
    longs: capLane(longs),
    shorts: capLane(shorts),
    longCounts,
    shortCounts,
  }
}
