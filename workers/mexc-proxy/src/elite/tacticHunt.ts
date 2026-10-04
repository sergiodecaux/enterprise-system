/**
 * Compact DualHunt «Можно» gate for the Elite worker.
 * Mirrors src/engine/radar/dualHunt shelves without porting chartStory.
 *
 * READY (fire): unused fuel + unused target ahead + daily not against
 *   + not stretched + in/near zone.
 * WAIT / STREAM: never sent as a new entry.
 */

import { biasFromCandles } from '../globalScanContext'
import {
  buildHtfLiquidityMap,
  findSmartZone,
  type SmartZonePlan,
} from '../liquidityZones'
import { atr, fetchTickers, type VaneTicker } from '../vane/mexc'
import { fetchKlinesCached } from '../vane/htfCache'
import { evaluateVaneSession } from '../vane/sessionFilter'
import type { Candle, VaneKv } from '../vane/types'

export type HuntSide = 'LONG' | 'SHORT'
export type HuntShelf = 'WAIT' | 'READY' | 'STREAM'

export const ELITE_HUNT_PINNED = [
  'BTC_USDT',
  'ETH_USDT',
  'SOL_USDT',
  'BNB_USDT',
  'XRP_USDT',
  'AVAX_USDT',
  'LINK_USDT',
  'SUI_USDT',
  'TON_USDT',
  'XAU_USDT',
  'SILVER_USDT',
  'USOIL_USDT',
] as const

const MIN_SCORE_READY = 38
const HUNT_BATCH = 8

export interface TacticHuntInput {
  symbol: string
  price: number
  atr: number
  chg24: number
  fundingPct: number | null
  bias1h: 'BULL' | 'BEAR' | 'FLAT'
  bias4h: 'BULL' | 'BEAR' | 'FLAT'
  bias1d: 'BULL' | 'BEAR' | 'FLAT'
  high24: number | null
  low24: number | null
  ssl: { price: number; isActive: boolean } | null
  bsl: { price: number; isActive: boolean } | null
  zoneLong: SmartZonePlan | null
  zoneShort: SmartZonePlan | null
  pdh: number | null
  pdl: number | null
  rsi: number | null
  sessionDead: boolean
}

export interface TacticHuntVerdict {
  symbol: string
  side: HuntSide
  shelf: HuntShelf
  fuelPx: number
  fuelWhere: string
  targetPx: number
  streamTo: string
  entry: number
  zoneLow: number
  zoneHigh: number
  reason: string
  doNotChase: boolean
  magnetPx: number | null
  magnetLabel: string | null
  score: number
}

interface SideDraft {
  side: HuntSide
  shelf: HuntShelf
  fuelPx: number
  fuelWhere: string
  targetPx: number
  streamTo: string
  entry: number
  zoneLow: number
  zoneHigh: number
  reason: string
  magnetPx: number | null
  magnetLabel: string | null
  score: number
  inZone: boolean
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function sameLevel(a: number, b: number, atrPx: number, price: number): boolean {
  if (!(a > 0) || !(b > 0)) return false
  const tol = Math.max(atrPx * 0.35, price * 0.0015, Math.abs(a) * 0.0008)
  return Math.abs(a - b) <= tol
}

function rsiOf(candles: Candle[]): number | null {
  if (candles.length < 16) return null
  let gains = 0
  let losses = 0
  for (let i = candles.length - 14; i < candles.length; i++) {
    const d = candles[i]![4] - candles[i - 1]![4]
    if (d >= 0) gains += d
    else losses -= d
  }
  const rs = losses > 0 ? gains / losses : 100
  return 100 - 100 / (1 + rs)
}

function isExtended(side: HuntSide, chg24: number, rsi: number | null): boolean {
  if (side === 'LONG' && chg24 >= 12) return true
  if (side === 'SHORT' && chg24 <= -12) return true
  if (rsi != null) {
    if (side === 'LONG' && rsi >= 74) return true
    if (side === 'SHORT' && rsi <= 26) return true
  }
  return false
}

function dailySideOf(input: TacticHuntInput): HuntSide | null {
  if (input.bias1d === 'BULL') return 'LONG'
  if (input.bias1d === 'BEAR') return 'SHORT'
  if (input.bias4h === 'BULL') return 'LONG'
  if (input.bias4h === 'BEAR') return 'SHORT'
  return null
}

function humanTarget(label: string, side: HuntSide): string {
  const s = label.toLowerCase()
  if (s.includes('pdh') || s.includes('хай дня')) return 'хай дня'
  if (s.includes('pdl') || s.includes('лой дня')) return 'лой дня'
  if (s.includes('равные хаи') || s.includes('bsl') || s.includes('ликвидность сверху')) {
    return 'ликвидность сверху'
  }
  if (s.includes('равные лои') || s.includes('ssl') || s.includes('стопы')) {
    return 'стопы снизу'
  }
  if (s.includes('магнит')) return 'магнит дня'
  return side === 'SHORT' ? 'стопы снизу' : 'ликвидность сверху'
}

function whyNow(
  side: HuntSide,
  shelf: HuntShelf,
  inZone: boolean,
  dest: string
): string {
  if (shelf === 'STREAM') {
    return side === 'LONG'
      ? `уже идут на ${dest} — не догонять`
      : `уже сыплются к ${dest} — не догонять`
  }
  if (shelf === 'WAIT') {
    return side === 'LONG'
      ? `ждут топливо снизу → потом на ${dest}`
      : `ждут топливо сверху → потом на ${dest}`
  }
  if (inZone) {
    return side === 'LONG'
      ? `сидят в спросе → на ${dest}`
      : `сидят в предложении → на ${dest}`
  }
  return side === 'LONG'
    ? `топливо рядом → на ${dest}`
    : `топливо рядом → на ${dest}`
}

function pickFuel(
  side: HuntSide,
  input: TacticHuntInput
): { price: number; where: string; inZone: boolean } | null {
  const zone = side === 'LONG' ? input.zoneLong : input.zoneShort
  const inZone = zone?.phase === 'TOUCH'
  if (inZone && zone) {
    return {
      price: zone.mid,
      where: side === 'LONG' ? 'в зоне спроса' : 'в зоне предложения',
      inZone: true,
    }
  }
  if (side === 'LONG') {
    const ssl = input.ssl
    if (ssl?.isActive && ssl.price < input.price * 1.004) {
      return { price: ssl.price, where: 'SSL снизу', inZone: false }
    }
    return null
  }
  const bsl = input.bsl
  if (bsl?.isActive && bsl.price > input.price * 0.996) {
    return { price: bsl.price, where: 'BSL сверху', inZone: false }
  }
  return null
}

function pickTarget(
  side: HuntSide,
  input: TacticHuntInput,
  fuelPx: number
): { price: number; label: string } | null {
  const { price, atr: atrPx } = input
  const minDist = Math.max(atrPx * 0.45, price * 0.0028)
  const maxDist = price * 0.085
  const raw: Array<{ price: number; label: string; weight: number }> = []

  if (side === 'LONG') {
    if (input.pdh && input.pdh > price) raw.push({ price: input.pdh, label: 'PDH', weight: 96 })
    if (input.high24 && input.high24 > price) {
      raw.push({ price: input.high24, label: 'PDH', weight: 92 })
    }
    if (input.bsl?.isActive) raw.push({ price: input.bsl.price, label: 'BSL', weight: 90 })
    if (input.zoneLong?.target && input.zoneLong.target > price) {
      raw.push({ price: input.zoneLong.target, label: input.zoneLong.targetLabel || 'цель', weight: 80 })
    }
  } else {
    if (input.pdl && input.pdl < price) raw.push({ price: input.pdl, label: 'PDL', weight: 96 })
    if (input.low24 && input.low24 > 0 && input.low24 < price) {
      raw.push({ price: input.low24, label: 'PDL', weight: 92 })
    }
    if (input.ssl?.isActive) raw.push({ price: input.ssl.price, label: 'SSL', weight: 90 })
    if (input.zoneShort?.target && input.zoneShort.target < price) {
      raw.push({ price: input.zoneShort.target, label: input.zoneShort.targetLabel || 'цель', weight: 80 })
    }
  }

  let best: { price: number; label: string; weight: number } | null = null
  for (const c of raw) {
    const ahead = side === 'LONG' ? c.price > price + minDist : c.price < price - minDist
    if (!ahead) continue
    const dist = Math.abs(c.price - price)
    if (dist < minDist || dist > maxDist) continue
    if (sameLevel(c.price, fuelPx, atrPx, price)) continue
    if (!best || c.weight > best.weight) best = c
  }
  return best ? { price: best.price, label: best.label } : null
}

function dailyBlocks(side: HuntSide, input: TacticHuntInput): boolean {
  if (side === 'LONG') {
    if (input.bias1d !== 'BEAR') return false
    if (input.pdl != null && input.pdl < input.price) return true
    return true
  }
  if (input.bias1d !== 'BULL') return false
  if (input.pdh != null && input.pdh > input.price) return true
  return true
}

function stretchOf(
  side: HuntSide,
  input: TacticHuntInput,
  fuelPx: number,
  targetPx: number
): { stream: boolean; drop: boolean } {
  const { price, atr: atrPx } = input
  if (side === 'LONG' ? price > targetPx : price < targetPx) {
    return { stream: false, drop: true }
  }
  const remaining = Math.abs(targetPx - price)
  const span = Math.abs(targetPx - fuelPx)
  const done = span > 0 ? 1 - remaining / span : 0
  const atrLeft = atrPx > 0 ? remaining / atrPx : 99
  if (done >= 0.88 || atrLeft < 0.35) return { stream: true, drop: true }

  const leftFuel =
    side === 'LONG'
      ? price > fuelPx + Math.max(atrPx * 0.55, price * 0.002)
      : price < fuelPx - Math.max(atrPx * 0.55, price * 0.002)
  const stream =
    done >= 0.55 ||
    atrLeft < 0.85 ||
    isExtended(side, input.chg24, input.rsi) ||
    (leftFuel && done >= 0.32)
  return { stream, drop: false }
}

function crowded(side: HuntSide, input: TacticHuntInput): boolean {
  const fund = input.fundingPct
  if (side === 'LONG') {
    const crowdedFund = fund != null && fund > 0.03
    return (crowdedFund || input.chg24 >= 10) && !input.bsl?.isActive
  }
  const crowdedFund = fund != null && fund < -0.03
  return (crowdedFund || input.chg24 <= -10) && !input.ssl?.isActive
}

function pickShelf(
  stretchStream: boolean,
  fuelClose: boolean,
  inZone: boolean,
  input: TacticHuntInput,
  side: HuntSide
): HuntShelf {
  if (stretchStream) return 'STREAM'
  if (fuelClose || inZone) {
    if (input.sessionDead && !inZone) return 'WAIT'
    if (crowded(side, input)) return 'WAIT'
    return 'READY'
  }
  return 'WAIT'
}

function scoreOf(
  side: HuntSide,
  input: TacticHuntInput,
  inZone: boolean,
  fuelClose: boolean
): number {
  let score = 28
  score += 18
  score += 10
  if (inZone || fuelClose) score += 10
  const daily = dailySideOf(input)
  if (daily === side) score += 12
  else if (daily == null) score += 2
  if (input.bias4h === (side === 'LONG' ? 'BULL' : 'BEAR')) score += 6
  if (isExtended(side, input.chg24, input.rsi) && !inZone) score -= 16
  return clamp(Math.round(score), 0, 100)
}

function draftSide(side: HuntSide, input: TacticHuntInput): SideDraft | null {
  if (dailyBlocks(side, input)) return null
  const fuel = pickFuel(side, input)
  if (!fuel) return null
  const target = pickTarget(side, input, fuel.price)
  if (!target) return null
  if (side === 'LONG' ? input.price > target.price : input.price < target.price) {
    return null
  }

  const stretch = stretchOf(side, input, fuel.price, target.price)
  if (stretch.drop && !stretch.stream) return null

  const fuelClose =
    Math.abs(fuel.price - input.price) <= Math.max(input.atr * 0.9, input.price * 0.004) ||
    fuel.inZone
  const shelf = pickShelf(stretch.stream, fuelClose, fuel.inZone, input, side)
  const score = scoreOf(side, input, fuel.inZone, fuelClose)
  if (shelf === 'READY' && score < MIN_SCORE_READY) {
    return null
  }

  const dest = humanTarget(target.label, side)
  const zone = side === 'LONG' ? input.zoneLong : input.zoneShort
  return {
    side,
    shelf,
    fuelPx: fuel.price,
    fuelWhere: fuel.where,
    targetPx: target.price,
    streamTo: dest,
    entry: zone?.limitEntry ?? fuel.price,
    zoneLow: zone?.zoneLow ?? fuel.price * 0.994,
    zoneHigh: zone?.zoneHigh ?? fuel.price * 1.006,
    reason: whyNow(side, shelf, fuel.inZone, dest),
    magnetPx: side === 'LONG' ? input.pdh ?? input.bsl?.price ?? null : input.pdl ?? input.ssl?.price ?? null,
    magnetLabel: side === 'LONG' ? (input.pdh ? 'PDH' : 'BSL') : input.pdl ? 'PDL' : 'SSL',
    score,
    inZone: fuel.inZone,
  }
}

function pickAgreedSide(
  input: TacticHuntInput,
  long: SideDraft | null,
  short: SideDraft | null
): HuntSide | null {
  if (long && !short) return 'LONG'
  if (short && !long) return 'SHORT'
  if (!long || !short) return null
  const daily = dailySideOf(input)
  if (daily) return daily
  return long.score >= short.score ? 'LONG' : 'SHORT'
}

export function judgeTacticHunt(input: TacticHuntInput): TacticHuntVerdict | null {
  if (!(input.price > 0) || !(input.atr > 0)) return null
  const long = draftSide('LONG', input)
  const short = draftSide('SHORT', input)
  const keep = pickAgreedSide(input, long, short)
  const draft = keep === 'SHORT' ? short : keep === 'LONG' ? long : null
  if (!draft || !keep) return null
  return {
    symbol: input.symbol,
    side: draft.side,
    shelf: draft.shelf,
    fuelPx: draft.fuelPx,
    fuelWhere: draft.fuelWhere,
    targetPx: draft.targetPx,
    streamTo: draft.streamTo,
    entry: draft.entry,
    zoneLow: draft.zoneLow,
    zoneHigh: draft.zoneHigh,
    reason: draft.reason,
    doNotChase: draft.shelf === 'STREAM',
    magnetPx: draft.magnetPx,
    magnetLabel: draft.magnetLabel,
    score: draft.score,
  }
}

export function isTacticReady(
  v: TacticHuntVerdict | null
): v is TacticHuntVerdict {
  return Boolean(v && v.shelf === 'READY' && !v.doNotChase)
}

export function tacticAllowsEntry(
  verdict: TacticHuntVerdict | null,
  side: HuntSide
): boolean {
  return isTacticReady(verdict) && verdict.side === side
}

export function buildHuntInput(opts: {
  symbol: string
  price: number
  chg24?: number
  fundingPct?: number | null
  high24?: number | null
  low24?: number | null
  candles4h: Candle[]
  candles1d: Candle[]
  candles1h?: Candle[]
}): TacticHuntInput | null {
  const price = opts.price
  if (!(price > 0) || opts.candles4h.length < 20) return null
  const atrPx = atr(opts.candles4h, 14) || price * 0.008
  const map = buildHtfLiquidityMap({
    candles4h: opts.candles4h,
    candles1d: opts.candles1d,
    candles1h: opts.candles1h,
    price,
  })
  const prevDay =
    opts.candles1d.length >= 2
      ? opts.candles1d[opts.candles1d.length - 2]
      : opts.candles1d[opts.candles1d.length - 1]
  const session = evaluateVaneSession()
  return {
    symbol: opts.symbol,
    price,
    atr: atrPx,
    chg24: opts.chg24 ?? 0,
    fundingPct: opts.fundingPct ?? null,
    bias1h: opts.candles1h?.length ? biasFromCandles(opts.candles1h) : biasFromCandles(opts.candles4h),
    bias4h: biasFromCandles(opts.candles4h),
    bias1d: biasFromCandles(opts.candles1d),
    high24: opts.high24 ?? null,
    low24: opts.low24 ?? null,
    ssl: map.nearestSSL
      ? { price: map.nearestSSL.price, isActive: map.nearestSSL.isActive }
      : null,
    bsl: map.nearestBSL
      ? { price: map.nearestBSL.price, isActive: map.nearestBSL.isActive }
      : null,
    zoneLong: findSmartZone('LONG', price, map, atrPx, { relaxed: true }),
    zoneShort: findSmartZone('SHORT', price, map, atrPx, { relaxed: true }),
    pdh: prevDay?.[2] ?? null,
    pdl: prevDay?.[3] ?? null,
    rsi: rsiOf(opts.candles4h),
    sessionDead: !session.ok || session.session === 'ASIA' || session.session === 'OFF',
  }
}

export function unionHuntUniverse(favorites: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of [...favorites, ...ELITE_HUNT_PINNED]) {
    const s = raw.toUpperCase()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

export function pickHuntSymbols(
  universe: string[],
  favorites: string[],
  now = Date.now()
): string[] {
  const favSet = new Set(favorites.map((s) => s.toUpperCase()))
  const favs = universe.filter((s) => favSet.has(s))
  const rest = universe.filter((s) => !favSet.has(s))
  const room = Math.max(2, HUNT_BATCH - favs.length)
  if (rest.length <= room) return [...favs, ...rest]
  const slot = Math.floor(now / 120_000) % Math.ceil(rest.length / room)
  const batch = rest.slice(slot * room, slot * room + room)
  return [...favs, ...batch]
}

export async function loadHuntInput(
  symbol: string,
  ticker: VaneTicker | undefined,
  kv?: VaneKv
): Promise<TacticHuntInput | null> {
  const [c4h, c1d, c1h] = await Promise.all([
    fetchKlinesCached(kv, symbol, 'Hour4', 90),
    fetchKlinesCached(kv, symbol, 'Day1', 40),
    fetchKlinesCached(kv, symbol, 'Min60', 48),
  ])
  const price = Number(ticker?.lastPrice ?? c4h[c4h.length - 1]?.[4] ?? 0)
  return buildHuntInput({
    symbol,
    price,
    chg24: ticker ? Number(ticker.riseFallRate ?? 0) * 100 : 0,
    fundingPct: ticker?.fundingRate != null ? Number(ticker.fundingRate) * 100 : null,
    high24: ticker?.high24Price != null ? Number(ticker.high24Price) : null,
    low24: ticker?.lower24Price != null ? Number(ticker.lower24Price) : null,
    candles4h: c4h,
    candles1d: c1d,
    candles1h: c1h,
  })
}

export async function scanTacticHunt(opts: {
  symbols: string[]
  kv?: VaneKv
  tickers?: VaneTicker[]
}): Promise<TacticHuntVerdict[]> {
  const tickers = opts.tickers ?? (await fetchTickers())
  const bySym = new Map(tickers.map((t) => [t.symbol, t]))
  const out: TacticHuntVerdict[] = []
  for (const symbol of opts.symbols) {
    try {
      const input = await loadHuntInput(symbol, bySym.get(symbol), opts.kv)
      if (!input) continue
      const verdict = judgeTacticHunt(input)
      if (verdict) out.push(verdict)
    } catch (err) {
      console.error('[tacticHunt]', symbol, err)
    }
  }
  return out
}
