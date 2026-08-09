/**
 * Hot-meme watchlist: TOP liquid memes by 24h heat for Day Continue scanner.
 * Sticky soft-refresh keeps continuity but list is wide enough to cover the top.
 */

const WATCHLIST_KEY = 'scanner:hot_meme_watchlist_v6_liq'
/** Rebuild order more often so new hot names enter the top */
const REFRESH_MS = 10 * 60_000
/**
 * Dual lane: rockets (worked) + calmer mid-liq — both kept, not either/or.
 * Scan still caps how many we deep-scan per tick (CF budget).
 */
const MAX_ROCKETS = 14
const MAX_CALM = 12
/** Dump lane for DUMP_FUEL_FAIL LONGs (mirror of pump shorts). */
const MAX_DUMPS = 10
const MAX_TOTAL = 28
/** Force full rebuild if sticky list collapses (was stuck at 1 coin → no signals) */
const MIN_HEALTHY_LIST = 10
const MIN_ABS_CHG_PCT = 3
/** Rockets: was 100k — thin names (LONGXIA…) SL'd; need tradeable depth */
const MIN_QUOTE_VOL = 500_000
/** Calm lane: more liquid, milder 24h — slower path to TP */
const CALM_VOL_MIN = 1_000_000
const CALM_VOL_MAX = 25_000_000
const CALM_CHG_MIN = 5
const CALM_CHG_MAX = 28

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

/** Classic rocket heat — thin/hot books that already worked */
function rocketScore(chgAbs: number, vol: number): number {
  const volFactor = Math.log10(Math.max(vol, 10_000))
  const thinBonus =
    vol >= 200_000 && vol <= 2_000_000 ? 1.25 : vol > 5_000_000 ? 0.85 : 1
  return chgAbs * volFactor * thinBonus
}

/** Calm mid-liq — slower fades, more time to enter */
function calmScore(chgAbs: number, vol: number): number {
  if (vol < CALM_VOL_MIN || vol > CALM_VOL_MAX) return 0
  if (chgAbs < CALM_CHG_MIN || chgAbs > CALM_CHG_MAX) return 0
  const volFactor = Math.log10(Math.max(vol, 10_000))
  return chgAbs * volFactor * 1.15
}

function heatScore(chgAbs: number, vol: number): number {
  return Math.max(rocketScore(chgAbs, vol), calmScore(chgAbs, vol))
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
  const listHealthy = (prev?.entries?.length ?? 0) >= MIN_HEALTHY_LIST
  const freshEnough =
    prev &&
    listHealthy &&
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

  const pumpsAll = candidates.filter((e) => e.dayBias === 'PUMP')
  const rockets = [...pumpsAll]
    .sort(
      (a, b) =>
        rocketScore(Math.abs(b.chg24hPct), b.quoteVolUsd) -
        rocketScore(Math.abs(a.chg24hPct), a.quoteVolUsd)
    )
    .slice(0, MAX_ROCKETS)
  const calm = [...pumpsAll]
    .filter(
      (e) =>
        e.quoteVolUsd >= CALM_VOL_MIN &&
        e.quoteVolUsd <= CALM_VOL_MAX &&
        e.chg24hPct >= CALM_CHG_MIN &&
        e.chg24hPct <= CALM_CHG_MAX
    )
    .sort(
      (a, b) =>
        calmScore(Math.abs(b.chg24hPct), b.quoteVolUsd) -
        calmScore(Math.abs(a.chg24hPct), a.quoteVolUsd)
    )
    .slice(0, MAX_CALM)
  // Rockets first (proven), then unique calm names — both lanes live together
  const bySym = new Map<string, HotMemeEntry>()
  for (const e of rockets) bySym.set(e.symbol, e)
  for (const e of calm) {
    if (!bySym.has(e.symbol)) bySym.set(e.symbol, e)
  }
  const dumps = candidates
    .filter((e) => e.dayBias === 'DUMP')
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DUMPS)
  for (const e of dumps) bySym.set(e.symbol, e)

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
    .filter((e) => Math.abs(e.chg24hPct) >= MIN_ABS_CHG_PCT)
    .sort((a, b) => {
      // Keep both lanes; mild pump bias only for tie-breaks
      const pumpA = a.dayBias === 'PUMP' ? 1 : 0
      const pumpB = b.dayBias === 'PUMP' ? 1 : 0
      return b.score - a.score || pumpB - pumpA
    })
    .slice(0, MAX_TOTAL)

  if (freshEnough && prev) {
    // Soft refresh: keep previous order for symbols still present; only replace drops.
    const keep = prev.entries
      .map((e) => bySym.get(e.symbol))
      .filter(
        (e): e is HotMemeEntry =>
          Boolean(e) && Math.abs(e!.chg24hPct) >= 4
      )
    // Collapsed sticky → full rebuild. Never return empty if candidates exist.
    if (keep.length < MIN_HEALTHY_LIST) {
      if (!entries.length && candidates.length) {
        // Fall through thresholds were too tight this tick — take top candidates raw
        entries = [...candidates]
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_TOTAL)
      }
      return {
        updatedAt: now,
        dayKey: key,
        entries,
        reason: entries.length
          ? `rebuild-unhealthy-sticky keep=${keep.length} n=${entries.length}`
          : `rebuild-empty keep=${keep.length} candidates=${candidates.length}`,
      }
    }
    const extras = entries.filter(
      (e) => !keep.some((k) => k.symbol === e.symbol)
    )
    entries = [...keep, ...extras].slice(0, MAX_TOTAL)
    return {
      updatedAt: now,
      dayKey: key,
      entries,
      reason: 'sticky-watchlist-pump+dump',
    }
  }

  return {
    updatedAt: now,
    dayKey: key,
    entries,
    reason: entries.length
      ? `pump+dump dual-lane top-${MAX_TOTAL}`
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
