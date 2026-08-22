/**
 * Hot-meme watchlist: liquid memes for deep-scan.
 * v7: rockets/calm 24h heat + PREMOVE lane (liq, mild 24h — volume accel
 * confirmed on 1m in memeOrderFlow, not from ticker alone).
 */

const WATCHLIST_KEY = 'scanner:hot_meme_watchlist_v9_classic_memes'
/** Rebuild order more often so new hot names enter the top */
const REFRESH_MS = 10 * 60_000
/**
 * Dual lane: rockets (worked) + calmer mid-liq — both kept, not either/or.
 * Scan still caps how many we deep-scan per tick (CF budget).
 */
const MAX_ROCKETS = 12
const MAX_CALM = 10
/** Pre-move: liquid, mild |chg24| — candidates for vol-accel before price move */
const MAX_PREMOVE = 10
/** Dump lane for DUMP_CONTINUATION SHORT / balance */
const MAX_DUMPS = 10
/** Guaranteed source pool for candle-confirmed RANGE setups. */
const MAX_SIDEWAYS = 10
const MAX_TOTAL = 30
/** Force full rebuild if sticky list collapses (was stuck at 1 coin → no signals) */
const MIN_HEALTHY_LIST = 10
const MIN_ABS_CHG_PCT = 0.5
/** Rockets: was 100k — thin names (LONGXIA…) SL'd; need tradeable depth */
const MIN_QUOTE_VOL = 100_000
/** Calm lane: more liquid, milder 24h — slower path to TP */
const CALM_VOL_MIN = 400_000
const CALM_VOL_MAX = 25_000_000
const CALM_CHG_MIN = 4
const CALM_CHG_MAX = 35
/** Pre-move lane: enough depth, price not already extended */
const PREMOVE_VOL_MIN = 200_000
const PREMOVE_CHG_MAX = 14
const PREMOVE_CHG_MIN = 1.5
const SIDEWAYS_VOL_MIN = 250_000
const SIDEWAYS_CHG_MAX = 6

/**
 * Equity-token perps (CRWVSTOCK, WDAYSTOCK, BSPSTOCK…).
 * PEAK journal: 0% WR — never scan them as memes.
 */
export function isEquityTokenSymbol(symbol: string): boolean {
  return /STOCK/i.test(symbol)
}

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

/** Prefer liquid + NOT extended — scan will confirm vol accel on 1m */
function premoveScore(chgAbs: number, vol: number): number {
  if (vol < PREMOVE_VOL_MIN) return 0
  if (chgAbs < PREMOVE_CHG_MIN || chgAbs > PREMOVE_CHG_MAX) return 0
  const volFactor = Math.log10(Math.max(vol, 10_000))
  // Invert heat: quieter 24h + higher vol ranks higher
  const quietBonus = 1 + (PREMOVE_CHG_MAX - chgAbs) / PREMOVE_CHG_MAX
  return volFactor * quietBonus * 12
}

function heatScore(chgAbs: number, vol: number): number {
  return Math.max(
    rocketScore(chgAbs, vol),
    calmScore(chgAbs, vol),
    premoveScore(chgAbs, vol)
  )
}

function isSidewaysEntry(entry: HotMemeEntry): boolean {
  const chgAbs = Math.abs(entry.chg24hPct)
  return (
    chgAbs >= MIN_ABS_CHG_PCT &&
    chgAbs < SIDEWAYS_CHG_MAX &&
    entry.quoteVolUsd >= SIDEWAYS_VOL_MIN
  )
}

/** Sticky keep: rockets stay hot, RANGE names stay if still liquid and quiet. */
function stillWatchable(chgPct: number, vol: number): boolean {
  const chgAbs = Math.abs(chgPct)
  if (chgAbs < MIN_ABS_CHG_PCT || vol < MIN_QUOTE_VOL * 0.5) return false
  if (chgAbs >= 4) return true
  return chgAbs < SIDEWAYS_CHG_MAX && vol >= SIDEWAYS_VOL_MIN
}

function sidewaysScore(entry: HotMemeEntry): number {
  const liquidity = Math.log10(Math.max(entry.quoteVolUsd, 10_000))
  const calm = SIDEWAYS_CHG_MAX - Math.abs(entry.chg24hPct)
  return liquidity + calm * 0.35
}

/** Keep RANGE names from being displaced by 24h rockets in the 30-slot list. */
function reserveSideways(
  entries: HotMemeEntry[],
  prefer: Set<string>
): HotMemeEntry[] {
  const sideways = entries
    .filter(isSidewaysEntry)
    .sort((a, b) => {
      const prefA = prefer.has(a.symbol) ? 1 : 0
      const prefB = prefer.has(b.symbol) ? 1 : 0
      return prefB - prefA || sidewaysScore(b) - sidewaysScore(a)
    })
    .slice(0, MAX_SIDEWAYS)
  const sideSymbols = new Set(sideways.map((entry) => entry.symbol))
  const directional = entries
    .filter((entry) => !sideSymbols.has(entry.symbol))
    .slice(0, MAX_TOTAL - sideways.length)
  return [...directional, ...sideways]
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
    /** Journal dumpers — drop unless an open paper pins them */
    blockedSymbols?: string[]
    /** Journal winners — keep on the list even if they cool a bit */
    preferSymbols?: string[]
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

  const blocked = new Set(
    (opts.blockedSymbols ?? []).filter((s) => !(opts.pinSymbols ?? []).includes(s))
  )
  const prefer = new Set(opts.preferSymbols ?? [])
  const candidates = tickers
    .filter((t) => {
      if (!opts.tradable.has(t.symbol)) return false
      if (!t.symbol.endsWith('_USDT')) return false
      if (t.symbol.includes('USDC')) return false
      if (opts.blueChips.has(t.symbol)) return false
      if (isEquityTokenSymbol(t.symbol)) return false
      if (blocked.has(t.symbol)) return false
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
  const premoves = [...pumpsAll]
    .filter(
      (e) =>
        e.quoteVolUsd >= PREMOVE_VOL_MIN &&
        e.chg24hPct >= PREMOVE_CHG_MIN &&
        e.chg24hPct <= PREMOVE_CHG_MAX
    )
    .sort(
      (a, b) =>
        premoveScore(Math.abs(b.chg24hPct), b.quoteVolUsd) -
        premoveScore(Math.abs(a.chg24hPct), a.quoteVolUsd)
    )
    .slice(0, MAX_PREMOVE)
    .map((e) => ({
      ...e,
      score: Number(
        Math.max(e.score, premoveScore(Math.abs(e.chg24hPct), e.quoteVolUsd)).toFixed(2)
      ),
    }))
  const sideways = [...candidates]
    .filter(isSidewaysEntry)
    .sort((a, b) => sidewaysScore(b) - sidewaysScore(a))
    .slice(0, MAX_SIDEWAYS)

  // Premoves first (early), then rockets/calm + an explicit RANGE pool.
  const bySym = new Map<string, HotMemeEntry>()
  for (const e of premoves) bySym.set(e.symbol, e)
  for (const e of sideways) bySym.set(e.symbol, e)
  for (const e of rockets) {
    if (!bySym.has(e.symbol)) bySym.set(e.symbol, e)
  }
  for (const e of calm) {
    if (!bySym.has(e.symbol)) bySym.set(e.symbol, e)
  }
  const dumps = candidates
    .filter((e) => e.dayBias === 'DUMP')
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DUMPS)
  for (const e of dumps) bySym.set(e.symbol, e)

  // Sticky: keep prior names if still a rocket or a liquid sideways box.
  if (prev?.dayKey === key) {
    for (const old of prev.entries) {
      if (bySym.has(old.symbol)) continue
      if (isEquityTokenSymbol(old.symbol) || blocked.has(old.symbol)) continue
      if (opts.blueChips.has(old.symbol)) continue
      const t = tickers.find((x) => x.symbol === old.symbol)
      if (!t) continue
      const chg = Number(t.riseFallRate ?? 0) * 100
      const vol = quoteVol(t)
      if (!stillWatchable(chg, vol)) continue
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

  // Keep coins the bot already reads well — don't let heat ranking drop them.
  for (const sym of prefer) {
    if (bySym.has(sym) || blocked.has(sym) || isEquityTokenSymbol(sym)) continue
    if (!opts.tradable.has(sym) || opts.blueChips.has(sym)) continue
    const t = tickers.find((x) => x.symbol === sym)
    if (!t) continue
    const chg = Number(t.riseFallRate ?? 0) * 100
    const vol = quoteVol(t)
    const price = Number(t.lastPrice ?? 0)
    if (!(price > 0) || price > 250) continue
    if (!stillWatchable(chg, vol)) continue
    bySym.set(sym, {
      symbol: sym,
      displayName: sym.replace('_USDT', '/USDT'),
      dayBias: chg >= 0 ? 'PUMP' : 'DUMP',
      chg24hPct: Number(chg.toFixed(2)),
      quoteVolUsd: Math.round(vol),
      score: Number(
        (heatScore(Math.max(Math.abs(chg), 4), Math.max(vol, MIN_QUOTE_VOL)) + 40).toFixed(2)
      ),
      addedAt: now,
    })
  }

  let entries = reserveSideways([...bySym.values()]
    .filter((e) => Math.abs(e.chg24hPct) >= MIN_ABS_CHG_PCT || prefer.has(e.symbol))
    .map((e) =>
      prefer.has(e.symbol) ? { ...e, score: Number((e.score + 40).toFixed(2)) } : e
    )
    .sort((a, b) => {
      const prefA = prefer.has(a.symbol) ? 1 : 0
      const prefB = prefer.has(b.symbol) ? 1 : 0
      const pumpA = a.dayBias === 'PUMP' ? 1 : 0
      const pumpB = b.dayBias === 'PUMP' ? 1 : 0
      return prefB - prefA || b.score - a.score || pumpB - pumpA
    }), prefer)

  if (freshEnough && prev) {
    // Soft refresh: keep previous order for symbols still present; only replace drops.
    const keep = prev.entries
      .map((e) => bySym.get(e.symbol))
      .filter(
        (e): e is HotMemeEntry =>
          Boolean(e) && (Math.abs(e.chg24hPct) >= 4 || isSidewaysEntry(e))
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
    const merged = reserveSideways([...keep, ...extras], prefer)
    entries = [
      ...merged.filter((e) => prefer.has(e.symbol)),
      ...merged.filter((e) => !prefer.has(e.symbol)),
    ]
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
    blockedSymbols?: string[]
    preferSymbols?: string[]
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
