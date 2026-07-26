/**
 * PREDATOR Hotlist 2.0 — powder-keg coins for Liquidation Echo.
 * Vol $3M–$15M · |chg|≥8% · spread≤0.08% · OI +5% / 2h
 */

const HOTLIST_KEY = 'predator:hotlist_v1'
const OI_HIST_KEY = 'predator:oi_history_v1'
const REFRESH_MS = 20 * 60_000
const MAX_COINS = 5
const MIN_VOL = 3_000_000
const MAX_VOL = 15_000_000
const MIN_ABS_CHG = 8
const MAX_SPREAD_PCT = 0.08
const MIN_OI_GROWTH_2H = 5

export type PredatorBias = 'LONG_ECHO' | 'SHORT_ECHO'

export interface PredatorCoin {
  symbol: string
  displayName: string
  /** LONG_ECHO = wait for long-liq flush then buy echo; SHORT_ECHO = short after short-squeeze flush */
  bias: PredatorBias
  chg24hPct: number
  quoteVolUsd: number
  spreadPct: number
  oiGrowth2hPct: number | null
  score: number
  addedAt: number
}

export interface PredatorHotlist {
  updatedAt: number
  dayKey: string
  entries: PredatorCoin[]
  reason: string
}

export interface PredatorTicker {
  symbol: string
  lastPrice?: number | string
  riseFallRate?: number | string
  amount24?: number | string
  volume24?: number | string
  holdVol?: number | string
  bid1?: number | string
  ask1?: number | string
}

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<unknown>
}

type OiHist = Record<string, Array<{ at: number; oi: number }>>

function dayKeyUtc(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

function quoteVol(t: PredatorTicker): number {
  const amount = Number(t.amount24 ?? 0)
  if (amount > 0) return amount
  const price = Number(t.lastPrice ?? 0)
  const vol = Number(t.volume24 ?? 0)
  return price > 0 && vol > 0 ? price * vol : 0
}

function spreadPct(t: PredatorTicker): number {
  const bid = Number(t.bid1 ?? 0)
  const ask = Number(t.ask1 ?? 0)
  const mid = (bid + ask) / 2 || Number(t.lastPrice ?? 0)
  if (!(bid > 0 && ask > 0 && mid > 0)) return 999
  return ((ask - bid) / mid) * 100
}

async function loadOiHist(kv?: KvLike): Promise<OiHist> {
  if (!kv) return {}
  try {
    const raw = await kv.get(OI_HIST_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as OiHist
  } catch {
    return {}
  }
}

async function saveOiHist(kv: KvLike | undefined, hist: OiHist): Promise<void> {
  if (!kv) return
  try {
    await kv.put(OI_HIST_KEY, JSON.stringify(hist))
  } catch {
    /* quota */
  }
}

/** Sample OI each cycle; return % change vs ~2h ago. */
export async function sampleOiAndGrowth(
  kv: KvLike | undefined,
  tickers: PredatorTicker[],
  now = Date.now()
): Promise<Map<string, number | null>> {
  const hist = await loadOiHist(kv)
  const out = new Map<string, number | null>()
  const cutoff = now - 6 * 60 * 60_000
  for (const t of tickers) {
    const oi = Number(t.holdVol ?? 0)
    if (!(oi > 0)) {
      out.set(t.symbol, null)
      continue
    }
    const series = (hist[t.symbol] ?? []).filter((p) => p.at >= cutoff)
    series.push({ at: now, oi })
    // keep ≤1 point / 10 min
    const compact: Array<{ at: number; oi: number }> = []
    for (const p of series) {
      const last = compact[compact.length - 1]
      if (!last || p.at - last.at >= 8 * 60_000) compact.push(p)
      else compact[compact.length - 1] = p
    }
    hist[t.symbol] = compact.slice(-40)
    const target = now - 2 * 60 * 60_000
    let base = compact[0]
    for (const p of compact) {
      if (p.at <= target) base = p
    }
    if (base && now - base.at >= 60 * 60_000 && base.oi > 0) {
      out.set(t.symbol, ((oi - base.oi) / base.oi) * 100)
    } else {
      out.set(t.symbol, null)
    }
  }
  // prune dead symbols
  const keep = new Set(tickers.map((t) => t.symbol))
  for (const k of Object.keys(hist)) {
    if (!keep.has(k)) delete hist[k]
  }
  await saveOiHist(kv, hist)
  return out
}

export async function loadPredatorHotlist(
  kv?: KvLike
): Promise<PredatorHotlist | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(HOTLIST_KEY)
    if (!raw) return null
    return JSON.parse(raw) as PredatorHotlist
  } catch {
    return null
  }
}

export async function savePredatorHotlist(
  kv: KvLike | undefined,
  list: PredatorHotlist
): Promise<void> {
  if (!kv) return
  try {
    await kv.put(HOTLIST_KEY, JSON.stringify(list))
  } catch {
    /* quota */
  }
}

export async function resolvePredatorHotlist(
  kv: KvLike | undefined,
  tickers: PredatorTicker[],
  opts: { blueChips: Set<string>; tradable: Set<string>; pinSymbols?: string[] }
): Promise<PredatorHotlist> {
  const now = Date.now()
  const previous = await loadPredatorHotlist(kv)
  if (
    previous &&
    previous.dayKey === dayKeyUtc(now) &&
    now - previous.updatedAt < REFRESH_MS &&
    previous.entries.length > 0
  ) {
    // Still refresh OI samples for growth tracking
    await sampleOiAndGrowth(kv, tickers, now)
    return previous
  }

  const oiGrowth = await sampleOiAndGrowth(kv, tickers, now)
  const candidates: PredatorCoin[] = []

  for (const t of tickers) {
    if (!opts.tradable.has(t.symbol)) continue
    if (!t.symbol.endsWith('_USDT') || t.symbol.includes('USDC')) continue
    if (opts.blueChips.has(t.symbol)) continue
    const price = Number(t.lastPrice ?? 0)
    const vol = quoteVol(t)
    const chg = Number(t.riseFallRate ?? 0) * 100
    const spr = spreadPct(t)
    const oiG = oiGrowth.get(t.symbol) ?? null
    if (!(price > 0) || price > 250) continue
    if (vol < MIN_VOL || vol > MAX_VOL) continue
    if (Math.abs(chg) < MIN_ABS_CHG) continue
    if (spr > MAX_SPREAD_PCT) continue
    // OI powder keg: +5% / 2h required when we have history; else soft-admit top movers
    if (oiG != null && oiG < MIN_OI_GROWTH_2H) continue
    const bias: PredatorBias = chg >= 0 ? 'LONG_ECHO' : 'SHORT_ECHO'
    // After a pump, long liquidations create LONG_ECHO (buy dip).
    // After a dump, short liquidations create SHORT_ECHO (sell rip).
    const score =
      Math.abs(chg) * Math.log10(vol) +
      (oiG != null ? oiG * 2 : 0) -
      spr * 50
    candidates.push({
      symbol: t.symbol,
      displayName: t.symbol.replace('_USDT', '/USDT'),
      bias,
      chg24hPct: Number(chg.toFixed(2)),
      quoteVolUsd: Math.round(vol),
      spreadPct: Number(spr.toFixed(4)),
      oiGrowth2hPct: oiG != null ? Number(oiG.toFixed(2)) : null,
      score: Number(score.toFixed(2)),
      addedAt: now,
    })
  }

  candidates.sort((a, b) => b.score - a.score)
  const entries = candidates.slice(0, MAX_COINS)

  // Pin open trades
  for (const sym of opts.pinSymbols ?? []) {
    if (entries.some((e) => e.symbol === sym)) continue
    const t = tickers.find((x) => x.symbol === sym)
    if (!t) continue
    const chg = Number(t.riseFallRate ?? 0) * 100
    entries.push({
      symbol: sym,
      displayName: sym.replace('_USDT', '/USDT'),
      bias: chg >= 0 ? 'LONG_ECHO' : 'SHORT_ECHO',
      chg24hPct: Number(chg.toFixed(2)),
      quoteVolUsd: Math.round(quoteVol(t)),
      spreadPct: Number(spreadPct(t).toFixed(4)),
      oiGrowth2hPct: oiGrowth.get(sym) ?? null,
      score: 0,
      addedAt: now,
    })
  }

  const list: PredatorHotlist = {
    updatedAt: now,
    dayKey: dayKeyUtc(now),
    entries: entries.slice(0, MAX_COINS),
    reason: entries.length
      ? `predator powder-keg top ${entries.length} (vol 3–15M, |chg|≥8%, spread≤0.08%, OI+2h)`
      : 'no predator candidates',
  }
  await savePredatorHotlist(kv, list)
  return list
}
