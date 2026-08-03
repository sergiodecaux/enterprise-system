/**
 * Hot-meme watchlist: TOP liquid memes by 24h heat for Day Continue scanner.
 * Sticky soft-refresh keeps continuity but list is wide enough to cover the top.
 */

const WATCHLIST_KEY = 'scanner:hot_meme_watchlist_v1'
/** Rebuild order more often so new hot names enter the top */
const REFRESH_MS = 12 * 60_000
const MAX_PUMPS = 14
const MAX_DUMPS = 6
/** Full top cover — peak-only needs more pumps */
const MAX_TOTAL = 20
const MIN_ABS_CHG_PCT = 3
const MIN_QUOTE_VOL = 100_000

export type DayBias = 'PUMP' | 'DUMP'

export interface HotMemeEntry {
  symbol: string
  displayName: string
  dayBias: DayBias
  chg24hPct: number
  quoteVolUsd: number
  score: number
  addedAt: number
}

export interface HotMemeWatchlist {
  updatedAt: number
  dayKey: string
  entries: HotMemeEntry[]
  reason: string
}

export interface HotMemeTickerLike {
  symbol: string
  lastPrice?: number | string
  riseFallRate?: number | string
  amount24?: number | string
  volume24?: number | string
  holdVol?: number | string
}

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<unknown>
}

function dayKeyUtc(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

function quoteVol(t: HotMemeTickerLike): number {
  const amount = Number(t.amount24 ?? 0)
  if (amount > 0) return amount
  const price = Number(t.lastPrice ?? 0)
  const vol = Number(t.volume24 ?? 0)
  return price > 0 && vol > 0 ? price * vol : 0
}

function heatScore(chgAbs: number, vol: number): number {
  const volFactor = Math.log10(Math.max(vol, 10_000))
  // Prefer thin books ($200k–$2M) where MM patterns are readable.
  const thinBonus = vol >= 200_000 && vol <= 2_000_000 ? 1.25 : vol > 5_000_000 ? 0.85 : 1
  return chgAbs * volFactor * thinBonus
}

export async function loadHotMemeWatchlist(
  kv?: KvLike
): Promise<HotMemeWatchlist | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(WATCHLIST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as HotMemeWatchlist
    if (!parsed?.entries?.length) return null
    return parsed
  } catch {
    return null
  }
}

export async function saveHotMemeWatchlist(
  kv: KvLike | undefined,
  list: HotMemeWatchlist
): Promise<void> {
  if (!kv) return
  try {
    await kv.put(WATCHLIST_KEY, JSON.stringify(list))
  } catch {
    // Best effort — next cycle rebuilds.
  }
}

/**
 * Build / refresh the sticky day watchlist.
 * `pinSymbols` keeps open paper trades on the list even if they cool off.
 */
export function buildHotMemeWatchlist(
  tickers: HotMemeTickerLike[],
  opts: {
    blueChips: Set<string>
    tradable: Set<string>
    pinSymbols?: string[]
    now?: number
    previous?: HotMemeWatchlist | null
  }
): HotMemeWatchlist {
  const now = opts.now ?? Date.now()
  const key = dayKeyUtc(now)
  const prev = opts.previous
  const freshEnough =
    prev &&
    prev.dayKey === key &&
    now - prev.updatedAt < REFRESH_MS &&
    prev.entries.length > 0

  const candidates = tickers
    .filter((t) => {
      if (!opts.tradable.has(t.symbol)) return false
      if (!t.symbol.endsWith('_USDT')) return false
      if (t.symbol.includes('USDC')) return false
      if (opts.blueChips.has(t.symbol)) return false
      const price = Number(t.lastPrice ?? 0)
      const vol = quoteVol(t)
      const chg = Number(t.riseFallRate ?? 0) * 100
      if (!(price > 0) || price > 250) return false
      if (vol < MIN_QUOTE_VOL) return false
      return Math.abs(chg) >= MIN_ABS_CHG_PCT
    })
    .map((t) => {
      const chg = Number(t.riseFallRate ?? 0) * 100
      const vol = quoteVol(t)
      const dayBias: DayBias = chg >= 0 ? 'PUMP' : 'DUMP'
      return {
        symbol: t.symbol,
        displayName: t.symbol.replace('_USDT', '/USDT'),
        dayBias,
        chg24hPct: Number(chg.toFixed(2)),
        quoteVolUsd: Math.round(vol),
        score: Number(heatScore(Math.abs(chg), vol).toFixed(2)),
        addedAt: now,
      } satisfies HotMemeEntry
    })

  const pumps = candidates
    .filter((e) => e.dayBias === 'PUMP')
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PUMPS)
  const dumps = candidates
    .filter((e) => e.dayBias === 'DUMP')
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DUMPS)

  const bySym = new Map<string, HotMemeEntry>()
  for (const e of [...pumps, ...dumps]) bySym.set(e.symbol, e)

  // Sticky: keep prior watchlist names if still hot enough (|chg|≥4) today.
  if (prev?.dayKey === key) {
    for (const old of prev.entries) {
      if (bySym.has(old.symbol)) continue
      const t = tickers.find((x) => x.symbol === old.symbol)
      if (!t) continue
      const chg = Number(t.riseFallRate ?? 0) * 100
      const vol = quoteVol(t)
      if (Math.abs(chg) < 4 || vol < MIN_QUOTE_VOL * 0.5) continue
      bySym.set(old.symbol, {
        symbol: old.symbol,
        displayName: old.displayName,
        dayBias: chg >= 0 ? 'PUMP' : 'DUMP',
        chg24hPct: Number(chg.toFixed(2)),
        quoteVolUsd: Math.round(vol),
        score: Number(heatScore(Math.abs(chg), vol).toFixed(2)),
        addedAt: old.addedAt,
      })
    }
  }

  for (const sym of opts.pinSymbols ?? []) {
    if (bySym.has(sym)) continue
    const t = tickers.find((x) => x.symbol === sym)
    if (!t) continue
    const chg = Number(t.riseFallRate ?? 0) * 100
    const vol = quoteVol(t)
    bySym.set(sym, {
      symbol: sym,
      displayName: sym.replace('_USDT', '/USDT'),
      dayBias: chg >= 0 ? 'PUMP' : 'DUMP',
      chg24hPct: Number(chg.toFixed(2)),
      quoteVolUsd: Math.round(vol),
      score: Number(heatScore(Math.max(Math.abs(chg), 6), Math.max(vol, MIN_QUOTE_VOL)).toFixed(2)),
      addedAt: now,
    })
  }

  let entries = [...bySym.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TOTAL)

  if (freshEnough && prev) {
    // Soft refresh: keep previous order for symbols still present; only replace drops.
    const keep = prev.entries
      .map((e) => bySym.get(e.symbol))
      .filter((e): e is HotMemeEntry => Boolean(e))
    const extras = entries.filter(
      (e) => !keep.some((k) => k.symbol === e.symbol)
    )
    entries = [...keep, ...extras].slice(0, MAX_TOTAL)
    return {
      updatedAt: prev.updatedAt,
      dayKey: key,
      entries,
      reason: 'sticky-watchlist',
    }
  }

  return {
    updatedAt: now,
    dayKey: key,
    entries,
    reason:
      pumps.length || dumps.length
        ? `top-${MAX_TOTAL}: ${pumps.length} pumps + ${dumps.length} dumps by 24h heat`
        : 'no hot memes above thresholds',
  }
}

export async function resolveHotMemeWatchlist(
  kv: KvLike | undefined,
  tickers: HotMemeTickerLike[],
  opts: {
    blueChips: Set<string>
    tradable: Set<string>
    pinSymbols?: string[]
  }
): Promise<HotMemeWatchlist> {
  const previous = await loadHotMemeWatchlist(kv)
  const next = buildHotMemeWatchlist(tickers, { ...opts, previous })
  const changed =
    !previous ||
    previous.dayKey !== next.dayKey ||
    previous.updatedAt !== next.updatedAt ||
    previous.entries.map((e) => e.symbol).join() !==
      next.entries.map((e) => e.symbol).join()
  if (changed) await saveHotMemeWatchlist(kv, next)
  return next
}

export function biasForSymbol(
  list: HotMemeWatchlist | null | undefined,
  symbol: string
): DayBias | null {
  return list?.entries.find((e) => e.symbol === symbol)?.dayBias ?? null
}
