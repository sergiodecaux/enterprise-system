/**
 * Zone pierce entry: green pierce at support → LONG, red pierce at resistance → SHORT,
 * with volume / absorption (откуп) confirm and ≥1% target.
 * Constants locked before the run, not fitted.
 */

import { detectAbsorption } from '../confluence'
import {
  buildHtfLiquidityMap,
  findSmartZone,
} from '../liquidityZones'
import { atr, fetchTickers, type VaneTicker } from '../vane/mexc'
import { fetchKlinesCached } from '../vane/htfCache'
import type { Candle, VaneKv } from '../vane/types'
import { JEWEL_MIN_MOVE_PCT } from './tacticHunt'

/** Min body share of range for a “пронзающая” candle. Locked before run. */
const PIERCE_BODY_FRAC = 0.42
/** Volume vs 20-bar avg on the pierce bar. Locked before run. */
const PIERCE_VOL_MULT = 1.8
/** Max distance from zone edge to count as “у зоны”, % of price. Locked before run. */
const ZONE_NEAR_PCT = 0.55
/** Batch size per cron tick. Locked before run. */
const PIERCE_BATCH = 6

export type PierceSide = 'LONG' | 'SHORT'

export interface ZonePierceSignal {
  symbol: string
  side: PierceSide
  entry: number
  target: number
  sl: number
  zoneLow: number
  zoneHigh: number
  movePct: number
  candleLabel: string
  volumeLabel: string
  whaleLabel: string | null
  reason: string
  score: number
}

function lastClosed(candles: Candle[]): Candle | null {
  if (candles.length < 3) return null
  // Prefer previous fully closed bar (last may still be forming)
  return candles[candles.length - 2] ?? candles[candles.length - 1] ?? null
}

function avgVol(candles: Candle[], endExcl: number, n = 20): number {
  const start = Math.max(0, endExcl - n)
  let s = 0
  let c = 0
  for (let i = start; i < endExcl; i++) {
    const v = candles[i]?.[5] ?? 0
    if (v > 0) {
      s += v
      c++
    }
  }
  return c > 0 ? s / c : 0
}

/**
 * Green piercing reclaim at support (LONG) or red piercing reject at resistance (SHORT).
 */
export function detectZonePierceCandle(opts: {
  side: PierceSide
  zoneLow: number
  zoneHigh: number
  candles: Candle[]
}): {
  ok: boolean
  label: string
  entryHint: number
  volMult: number
} | null {
  const { side, zoneLow, zoneHigh, candles } = opts
  if (!(zoneLow > 0) || !(zoneHigh > zoneLow) || candles.length < 25) return null
  const bar = lastClosed(candles)
  if (!bar) return null
  const idx = candles.indexOf(bar)
  const [, o, h, l, c, v] = bar
  const range = h - l
  if (!(range > 0) || !(c > 0)) return null
  const body = Math.abs(c - o)
  const bodyFrac = body / range
  const mid = (zoneLow + zoneHigh) / 2
  const base = avgVol(candles, idx >= 0 ? idx : candles.length - 1, 20)
  const volMult = base > 0 ? v / base : 0

  const touched =
    l <= zoneHigh * (1 + ZONE_NEAR_PCT / 100) &&
    h >= zoneLow * (1 - ZONE_NEAR_PCT / 100)

  if (side === 'LONG') {
    const green = c > o
    const piercedDown = l <= zoneHigh * 1.0015 && l <= mid * 1.002
    const reclaim = c >= mid || c >= zoneLow * 1.001
    const strong =
      green &&
      piercedDown &&
      touched &&
      reclaim &&
      bodyFrac >= PIERCE_BODY_FRAC
    if (!strong) return null
    return {
      ok: volMult >= PIERCE_VOL_MULT * 0.85,
      label: `Зелёная пронзающая · тело ${(bodyFrac * 100).toFixed(0)}% · vol×${volMult.toFixed(1)}`,
      entryHint: Math.min(c, mid),
      volMult,
    }
  }

  const red = c < o
  const piercedUp = h >= zoneLow * 0.9985 && h >= mid * 0.998
  const reject = c <= mid || c <= zoneHigh * 0.999
  const strong =
    red && piercedUp && touched && reject && bodyFrac >= PIERCE_BODY_FRAC
  if (!strong) return null
  return {
    ok: volMult >= PIERCE_VOL_MULT * 0.85,
    label: `Красная пронзающая · тело ${(bodyFrac * 100).toFixed(0)}% · vol×${volMult.toFixed(1)}`,
    entryHint: Math.max(c, mid),
    volMult,
  }
}

function targetFor(
  side: PierceSide,
  entry: number,
  map: ReturnType<typeof buildHtfLiquidityMap>
): { price: number; label: string } | null {
  if (!(entry > 0)) return null
  if (side === 'LONG') {
    const px = map.nearestBSL?.price ?? entry * (1 + JEWEL_MIN_MOVE_PCT / 100)
    if (px <= entry * (1 + JEWEL_MIN_MOVE_PCT / 100 - 0.05 / 100)) {
      return { price: entry * (1 + JEWEL_MIN_MOVE_PCT / 100), label: '+1%' }
    }
    return {
      price: Math.max(px, entry * (1 + JEWEL_MIN_MOVE_PCT / 100)),
      label: map.nearestBSL?.isActive ? 'BSL' : '+1%',
    }
  }
  const px = map.nearestSSL?.price ?? entry * (1 - JEWEL_MIN_MOVE_PCT / 100)
  if (px >= entry * (1 - JEWEL_MIN_MOVE_PCT / 100 + 0.05 / 100)) {
    return { price: entry * (1 - JEWEL_MIN_MOVE_PCT / 100), label: '−1%' }
  }
  return {
    price: Math.min(px, entry * (1 - JEWEL_MIN_MOVE_PCT / 100)),
    label: map.nearestSSL?.isActive ? 'SSL' : '−1%',
  }
}

export function judgeZonePierce(opts: {
  symbol: string
  price: number
  candles15m: Candle[]
  candles1m?: Candle[]
  candles4h: Candle[]
  candles1d: Candle[]
  candles1h?: Candle[]
  bookKind?: string | null
  bookNote?: string | null
}): ZonePierceSignal | null {
  const { symbol, price, candles15m, candles4h, candles1d } = opts
  if (!(price > 0) || candles15m.length < 30 || candles4h.length < 20) return null

  const atrPx = atr(candles4h, 14) || price * 0.008
  const map = buildHtfLiquidityMap({
    candles4h,
    candles1d,
    candles1h: opts.candles1h,
    price,
  })

  const candidates: Array<{
    side: PierceSide
    zoneLow: number
    zoneHigh: number
  }> = []

  const zL = findSmartZone('LONG', price, map, atrPx, { relaxed: true })
  const zS = findSmartZone('SHORT', price, map, atrPx, { relaxed: true })
  if (zL) candidates.push({ side: 'LONG', zoneLow: zL.zoneLow, zoneHigh: zL.zoneHigh })
  if (zS)
    candidates.push({ side: 'SHORT', zoneLow: zS.zoneLow, zoneHigh: zS.zoneHigh })
  if (map.nearestSSL?.isActive) {
    const p = map.nearestSSL.price
    candidates.push({
      side: 'LONG',
      zoneLow: p * 0.996,
      zoneHigh: p * 1.002,
    })
  }
  if (map.nearestBSL?.isActive) {
    const p = map.nearestBSL.price
    candidates.push({
      side: 'SHORT',
      zoneLow: p * 0.998,
      zoneHigh: p * 1.004,
    })
  }

  const abs15 = detectAbsorption(candles15m, 8)
  const abs1m =
    opts.candles1m && opts.candles1m.length >= 30
      ? detectAbsorption(opts.candles1m, 10)
      : null

  let best: ZonePierceSignal | null = null

  for (const cand of candidates) {
    const pierce = detectZonePierceCandle({
      side: cand.side,
      zoneLow: cand.zoneLow,
      zoneHigh: cand.zoneHigh,
      candles: candles15m,
    })
    if (!pierce) continue

    const absOk =
      (abs15.detected && abs15.sideHint === cand.side) ||
      (abs1m?.detected === true && abs1m.sideHint === cand.side) ||
      pierce.volMult >= PIERCE_VOL_MULT

    const bookOk =
      (cand.side === 'LONG' && opts.bookKind === 'ABSORPTION_LONG') ||
      (cand.side === 'SHORT' && opts.bookKind === 'ABSORPTION_SHORT')

    if (!absOk && !bookOk && !pierce.ok) continue

    const zone =
      cand.side === 'LONG'
        ? findSmartZone('LONG', price, map, atrPx, { relaxed: true })
        : findSmartZone('SHORT', price, map, atrPx, { relaxed: true })
    const entry = zone?.limitEntry ?? pierce.entryHint
    const tgt = targetFor(cand.side, entry, map)
    if (!tgt) continue
    const movePct = (Math.abs(tgt.price - entry) / entry) * 100
    if (movePct < JEWEL_MIN_MOVE_PCT) continue

    const sl =
      cand.side === 'LONG'
        ? Math.min(cand.zoneLow, entry) * 0.994
        : Math.max(cand.zoneHigh, entry) * 1.006

    let score = 40
    if (pierce.ok) score += 12
    if (absOk) score += 14
    if (bookOk) score += 16
    if (pierce.volMult >= 2.5) score += 8

    const volumeLabel = absOk
      ? abs1m?.detected && abs1m.sideHint === cand.side
        ? abs1m.label
        : abs15.detected && abs15.sideHint === cand.side
          ? abs15.label
          : `Объём ×${pierce.volMult.toFixed(1)} на пронзающей`
      : `Объём ×${pierce.volMult.toFixed(1)}`

    const whaleLabel = bookOk
      ? opts.bookNote ||
        (cand.side === 'LONG'
          ? 'Откуп в стакане — поглощают продажи'
          : 'Раздача в стакане — поглощают покупки')
      : null

    const signal: ZonePierceSignal = {
      symbol,
      side: cand.side,
      entry,
      target: tgt.price,
      sl,
      zoneLow: cand.zoneLow,
      zoneHigh: cand.zoneHigh,
      movePct: Number(movePct.toFixed(2)),
      candleLabel: pierce.label,
      volumeLabel,
      whaleLabel,
      reason: [
        pierce.label,
        volumeLabel,
        whaleLabel,
        `Цель ${tgt.label} · ~${movePct.toFixed(1)}%`,
      ]
        .filter(Boolean)
        .join(' · '),
      score,
    }

    if (!best || signal.score > best.score) best = signal
  }

  return best
}

export function formatZonePierceUrgent(s: ZonePierceSignal): {
  title: string
  text: string
} {
  const ticker = s.symbol.replace('_USDT', '')
  const side = s.side === 'LONG' ? 'лонг' : 'шорт'
  const title =
    s.side === 'LONG'
      ? `${ticker} — вход LONG · пронзающая + откуп`
      : `${ticker} — вход SHORT · пронзающая + давление`
  const text = [
    `<b>${s.candleLabel}</b>`,
    s.volumeLabel,
    s.whaleLabel ? `🐋 ${s.whaleLabel}` : null,
    `Зона ${s.zoneLow.toPrecision(6)}–${s.zoneHigh.toPrecision(6)}`,
    `Лимитка ${s.entry.toPrecision(6)} → цель ${s.target.toPrecision(6)} (~${s.movePct.toFixed(1)}%)`,
    `Стоп ${s.sl.toPrecision(6)}`,
    s.side === 'LONG'
      ? 'Забираем ~1% от откупа у зоны. Не догонять выше.'
      : 'Забираем ~1% от давления у зоны. Не догонять ниже.',
  ]
    .filter(Boolean)
    .join('\n')
  return { title, text }
}

export async function scanZonePierceEntries(opts: {
  symbols: string[]
  kv?: VaneKv
  tickers?: VaneTicker[]
  /** Optional book reader — keep budget low (only for top candidates) */
  readBook?: (symbol: string) => Promise<{
    kind: string | null
    note: string | null
  } | null>
}): Promise<ZonePierceSignal[]> {
  const tickers = opts.tickers ?? (await fetchTickers())
  const bySym = new Map(tickers.map((t) => [t.symbol, t]))
  const out: ZonePierceSignal[] = []
  const batch = opts.symbols.slice(0, PIERCE_BATCH)

  for (const symbol of batch) {
    try {
      const [c15, c1m, c4h, c1d, c1h] = await Promise.all([
        fetchKlinesCached(opts.kv, symbol, 'Min15', 60),
        fetchKlinesCached(opts.kv, symbol, 'Min1', 80),
        fetchKlinesCached(opts.kv, symbol, 'Hour4', 90),
        fetchKlinesCached(opts.kv, symbol, 'Day1', 40),
        fetchKlinesCached(opts.kv, symbol, 'Min60', 48),
      ])
      const ticker = bySym.get(symbol)
      const price = Number(ticker?.lastPrice ?? c15[c15.length - 1]?.[4] ?? 0)

      // First pass without book (cheap)
      let draft = judgeZonePierce({
        symbol,
        price,
        candles15m: c15,
        candles1m: c1m,
        candles4h: c4h,
        candles1d: c1d,
        candles1h: c1h,
      })
      if (!draft) continue

      // Enrich with book откуп when reader provided
      if (opts.readBook) {
        try {
          const book = await opts.readBook(symbol)
          if (book?.kind) {
            draft =
              judgeZonePierce({
                symbol,
                price,
                candles15m: c15,
                candles1m: c1m,
                candles4h: c4h,
                candles1d: c1d,
                candles1h: c1h,
                bookKind: book.kind,
                bookNote: book.note,
              }) ?? draft
          }
        } catch {
          /* keep candle-only */
        }
      }

      if (draft && draft.movePct >= JEWEL_MIN_MOVE_PCT) out.push(draft)
    } catch (err) {
      console.error('[zonePierce]', symbol, err)
    }
  }

  return out.sort((a, b) => b.score - a.score)
}
