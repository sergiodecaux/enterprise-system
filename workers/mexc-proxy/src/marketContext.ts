/**
 * Shared market context: Fear&Greed, coin-relevant news, BTC.D, TOTAL3.
 * Cached ~8 min per Worker isolate.
 */

import { kvPutThrottled } from './kvWrite'

export type AltRegime = 'ALT_ON' | 'ALT_OFF' | 'BTC_LEAD' | 'RISK_OFF' | 'NEUTRAL'
export type AltBias = 'LONG' | 'SHORT' | 'NEUTRAL'

export interface CoinNewsHit {
  score: number
  label: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  headlines: string[]
}

export interface MarketContext {
  fearGreed: number | null
  fearGreedLabel: string
  /** Global −1…+1 from recent headlines */
  newsScore: number
  newsLabel: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  newsHeadlines: string[]
  /** Per-base-asset news (BTC, ETH, SOL, …) */
  coinNews: Record<string, CoinNewsHit>
  btcDominance: number | null
  /** BTC.D change vs ~24h snapshot, percentage points */
  btcDomDelta24h: number | null
  ethDominance: number | null
  /** Alt mcap excluding BTC + ETH */
  total3Usd: number | null
  total3Delta24h: number | null
  totalMcapDelta24h: number | null
  /** Alt mcap excluding the top 10 (the long tail). */
  othersUsd: number | null
  othersDelta24h: number | null
  altRegime: AltRegime
  altBias: AltBias
  /** Reconstructed daily series (oldest→newest) for structure reads. */
  macroSeries: MacroSeries | null
  fetchedAt: number
  lines: string[]
}

export interface MacroSeries {
  /** Daily BTC.D %, oldest→newest. */
  btcD: number[]
  /** Daily TOTAL3 (alt mcap ex BTC+ETH), USD. */
  total3: number[]
  /** Daily OTHERS (alt mcap ex top 10), USD. */
  others: number[]
  /** Where the series came from, shown to the user for honesty. */
  source: string
  /** How the series was built (reconstructed vs direct). */
  reconstructed: boolean
  builtAt: number
}

const FG_URL = 'https://api.alternative.me/fng/?limit=2'
const CG_GLOBAL = 'https://api.coingecko.com/api/v3/global'
const CG_MARKETS =
  'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&sparkline=false'
const CG_CHART = (id: string) =>
  `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=90&interval=daily`
const LORE_GLOBAL = 'https://api.coinlore.net/api/global/'

/** How long the reconstructed daily series stay fresh (they move slowly). */
const MACRO_HISTORY_MS = 6 * 3600_000
const MACRO_HISTORY_KV_KEY = 'market_ctx:macro_series'
const MACRO_HISTORY_CACHE_REQ = new Request(
  'https://enterprise-system-runtime.invalid/macro-series'
)
/** Daily points kept per series. */
const MACRO_SERIES_LEN = 60
const CP_URL =
  'https://cryptopanic.com/api/v1/posts/?public=true&kind=news&limit=25'

const COIN_KEYWORDS: Record<string, string[]> = {
  BTC: ['bitcoin', 'btc', 'биткоин'],
  ETH: ['ethereum', 'eth', 'ether', 'эфириум'],
  SOL: ['solana', 'sol', 'солана'],
  XRP: ['ripple', 'xrp'],
  BNB: ['binance coin', 'bnb', 'binance'],
  ADA: ['cardano', 'ada'],
  DOGE: ['dogecoin', 'doge'],
  AVAX: ['avalanche', 'avax'],
  LINK: ['chainlink', 'link'],
  LTC: ['litecoin', 'ltc'],
  DOT: ['polkadot', 'dot'],
  UNI: ['uniswap', 'uni'],
  ATOM: ['cosmos', 'atom'],
  NEAR: ['near protocol', ' near '],
  SUI: ['sui network', ' sui '],
  APT: ['aptos', ' apt '],
  PEPE: ['pepe'],
  WIF: ['dogwifhat', 'wif'],
  TON: ['toncoin', 'telegram open network', ' ton '],
  TRX: ['tron', 'trx'],
}

const BULL = [
  'approval',
  'etf',
  'rally',
  'surge',
  'record',
  'bull',
  'adopt',
  'partnership',
  'inflow',
  'all-time',
  'ath',
  'upgrade',
  'listing',
]
const BEAR = [
  'hack',
  'ban',
  'sec ',
  'lawsuit',
  'crash',
  'fraud',
  'outflow',
  'exploit',
  'liquidation',
  'collapse',
  'probe',
  'fine',
  'delist',
]

let cache: MarketContext | null = null
const CACHE_MS = 8 * 60_000
const SNAP_KV_KEY = 'market_ctx:macro_snaps'
const SNAP_CACHE_REQ = new Request(
  'https://enterprise-system-runtime.invalid/macro-snaps'
)
const SNAP_MIN_GAP_MS = 25 * 60_000

interface MacroSnap {
  at: number
  btcD: number
  ethD: number
  total3: number
}

function deriveAltMacro(input: {
  btcDominance: number | null
  btcDomDelta24h: number | null
  total3Delta24h: number | null
  totalMcapDelta24h: number | null
}): { altRegime: AltRegime; altBias: AltBias; line: string } {
  const btcD = input.btcDominance
  const dBtcRaw = input.btcDomDelta24h
  const altDelta =
    input.total3Delta24h != null ? input.total3Delta24h : input.totalMcapDelta24h
  const dBtc = dBtcRaw == null ? 0 : dBtcRaw >= 0.2 ? 1 : dBtcRaw <= -0.2 ? -1 : 0
  const dAlt = altDelta == null ? 0 : altDelta >= 1 ? 1 : altDelta <= -1 ? -1 : 0

  let altRegime: AltRegime = 'NEUTRAL'
  if (dBtc !== 0 && dAlt !== 0) {
    if (dBtc > 0 && dAlt < 0) altRegime = 'ALT_OFF'
    else if (dBtc < 0 && dAlt > 0) altRegime = 'ALT_ON'
    else if (dBtc > 0 && dAlt > 0) altRegime = 'BTC_LEAD'
    else altRegime = 'RISK_OFF'
  } else if (btcD != null) {
    if (btcD >= 56 && dAlt < 0) altRegime = 'ALT_OFF'
    else if (btcD <= 48 && dAlt > 0) altRegime = 'ALT_ON'
    else if (btcD >= 56 && dAlt > 0) altRegime = 'BTC_LEAD'
    else if (btcD <= 48 && dAlt < 0) altRegime = 'RISK_OFF'
    else if (btcD >= 56) altRegime = 'ALT_OFF'
    else if (btcD <= 48) altRegime = 'ALT_ON'
  }

  const altBias: AltBias =
    altRegime === 'ALT_ON'
      ? 'LONG'
      : altRegime === 'ALT_OFF' || altRegime === 'RISK_OFF'
        ? 'SHORT'
        : 'NEUTRAL'

  const btcBit =
    btcD != null
      ? `BTC.D ${btcD.toFixed(1)}%${
          dBtcRaw != null ? ` ${dBtcRaw >= 0 ? '+' : ''}${dBtcRaw.toFixed(2)}пп` : ''
        }`
      : 'BTC.D н/д'
  const t3Bit =
    altDelta != null
      ? `TOTAL3 ${altDelta >= 0 ? '+' : ''}${altDelta.toFixed(1)}%`
      : 'TOTAL3 н/д'
  const line =
    altRegime === 'ALT_ON'
      ? `${btcBit} ↓ · ${t3Bit} ↑ → альтсезон, лонги альтов`
      : altRegime === 'ALT_OFF'
        ? `${btcBit} ↑ · ${t3Bit} ↓ → отток в BTC, шорты альтов`
        : altRegime === 'BTC_LEAD'
          ? `${btcBit} ↑ · ${t3Bit} ↑ → рост ведёт BTC, альты отстают`
          : altRegime === 'RISK_OFF'
            ? `${btcBit} ↓ · ${t3Bit} ↓ → риск-офф, не ловить альты`
            : `${btcBit} · ${t3Bit} — смешанно`

  return { altRegime, altBias, line }
}

function fmtTotal3(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9) return `$${(n / 1e9).toFixed(0)}B`
  return `$${(n / 1e6).toFixed(0)}M`
}

async function loadSnaps(kv?: KVNamespace): Promise<MacroSnap[]> {
  try {
    const cached = await caches.default.match(SNAP_CACHE_REQ)
    if (cached) {
      const parsed = (await cached.json()) as MacroSnap[]
      if (Array.isArray(parsed)) return parsed
    }
  } catch {
    /* fall through */
  }
  if (kv) {
    try {
      const raw = await kv.get(SNAP_KV_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as MacroSnap[]
        if (Array.isArray(parsed)) return parsed
      }
    } catch {
      /* ignore */
    }
  }
  return []
}

async function saveSnaps(snaps: MacroSnap[], kv?: KVNamespace): Promise<void> {
  const body = JSON.stringify(snaps)
  try {
    await caches.default.put(
      SNAP_CACHE_REQ,
      new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=172800',
        },
      })
    )
  } catch {
    /* isolate only */
  }
  if (kv) {
    await kvPutThrottled(kv, SNAP_KV_KEY, body, SNAP_MIN_GAP_MS, {
      expirationTtl: 3 * 24 * 3600,
    })
  }
}

function pickRefSnap(snaps: MacroSnap[], now: number): MacroSnap | null {
  const target = now - 24 * 3600_000
  let best: MacroSnap | null = null
  let bestDist = Infinity
  for (const s of snaps) {
    const age = now - s.at
    if (age < 18 * 3600_000 || age > 40 * 3600_000) continue
    const dist = Math.abs(s.at - target)
    if (dist < bestDist) {
      best = s
      bestDist = dist
    }
  }
  if (best) return best
  const older = snaps.filter((s) => now - s.at >= 4 * 3600_000)
  if (!older.length) return null
  return older.reduce((a, b) => (a.at < b.at ? a : b))
}

function toneOf(title: string): number {
  const low = title.toLowerCase()
  let bull = 0
  let bear = 0
  for (const w of BULL) if (low.includes(w)) bull++
  for (const w of BEAR) if (low.includes(w)) bear++
  const tot = bull + bear
  return tot > 0 ? (bull - bear) / tot : 0
}

function labelOf(score: number): CoinNewsHit['label'] {
  if (score > 0.18) return 'BULLISH'
  if (score < -0.18) return 'BEARISH'
  return 'NEUTRAL'
}

function baseFromSymbol(symbol: string): string {
  return symbol.replace(/_USDT$/i, '').replace(/USDT$/i, '').toUpperCase()
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'EnterpriseSystem/2.0' },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function loadMacroSeries(kv?: KVNamespace): Promise<MacroSeries | null> {
  const fresh = (s: MacroSeries | null): MacroSeries | null =>
    s && Date.now() - s.builtAt < MACRO_HISTORY_MS ? s : null
  try {
    const cached = await caches.default.match(MACRO_HISTORY_CACHE_REQ)
    if (cached) {
      const parsed = fresh((await cached.json()) as MacroSeries)
      if (parsed) return parsed
    }
  } catch {
    /* fall through */
  }
  if (kv) {
    try {
      const raw = await kv.get(MACRO_HISTORY_KV_KEY)
      if (raw) {
        const parsed = fresh(JSON.parse(raw) as MacroSeries)
        if (parsed) return parsed
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

async function saveMacroSeries(series: MacroSeries, kv?: KVNamespace): Promise<void> {
  const body = JSON.stringify(series)
  try {
    await caches.default.put(
      MACRO_HISTORY_CACHE_REQ,
      new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${Math.round(MACRO_HISTORY_MS / 1000)}`,
        },
      })
    )
  } catch {
    /* isolate only */
  }
  if (kv) {
    await kvPutThrottled(kv, MACRO_HISTORY_KV_KEY, body, MACRO_HISTORY_MS, {
      expirationTtl: 2 * 24 * 3600,
    })
  }
}

/**
 * Reconstruct daily BTC.D / TOTAL3 / OTHERS from CoinGecko market caps.
 * Top-10 coins give btc, eth and the top-10 sum; the current full-market
 * total scales that sum up to a proxy for the whole market. Fails soft:
 * returns null when CoinGecko is unavailable, and the caller keeps the
 * current + 24h snapshot path.
 */
async function buildMacroSeries(totalNow: number | null): Promise<MacroSeries | null> {
  const markets = await fetchJson<Array<{ id?: string; market_cap?: number }>>(
    CG_MARKETS
  )
  if (!markets || markets.length < 5) return null
  const ids = markets
    .map((m) => m.id)
    .filter((x): x is string => Boolean(x))
    .slice(0, 10)
  if (ids.length < 5) return null

  const charts = await Promise.all(
    ids.map((id) =>
      fetchJson<{ market_caps?: Array<[number, number]> }>(CG_CHART(id))
    )
  )
  const caps: Record<string, number[]> = {}
  let minLen = Infinity
  ids.forEach((id, i) => {
    const arr = (charts[i]?.market_caps ?? [])
      .map((p) => p[1])
      .filter((v) => Number.isFinite(v) && v > 0)
    if (arr.length) {
      caps[id] = arr
      minLen = Math.min(minLen, arr.length)
    }
  })
  const btc = caps['bitcoin']
  const eth = caps['ethereum']
  if (!btc || !eth || !Number.isFinite(minLen) || minLen < 10) return null

  const len = Math.min(minLen, MACRO_SERIES_LEN)
  const tailOf = (a: number[]): number[] => a.slice(a.length - len)
  const btcT = tailOf(btc)
  const ethT = tailOf(eth)
  const top10sum = new Array<number>(len).fill(0)
  for (const id of ids) {
    const a = caps[id]
    if (!a) continue
    const t = tailOf(a)
    for (let i = 0; i < len; i++) top10sum[i]! += t[i] ?? 0
  }

  const top10now = top10sum[len - 1] || 0
  const k = totalNow && top10now > 0 ? Math.max(1, totalNow / top10now) : 1
  const btcD: number[] = []
  const total3: number[] = []
  const others: number[] = []
  for (let i = 0; i < len; i++) {
    const total = top10sum[i]! * k
    if (!(total > 0)) continue
    btcD.push((btcT[i]! / total) * 100)
    total3.push(total - btcT[i]! - ethT[i]!)
    others.push(total - top10sum[i]!)
  }
  if (btcD.length < 10) return null

  return {
    btcD,
    total3,
    others,
    source: 'CoinGecko',
    reconstructed: k !== 1,
    builtAt: Date.now(),
  }
}

async function getMacroHistory(
  totalNow: number | null,
  kv?: KVNamespace
): Promise<MacroSeries | null> {
  const cached = await loadMacroSeries(kv)
  if (cached) return cached
  const fresh = await buildMacroSeries(totalNow)
  if (fresh) await saveMacroSeries(fresh, kv)
  return fresh
}

export async function getMarketContext(kv?: KVNamespace): Promise<MarketContext> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache

  const [fg, global, panic, lore] = await Promise.all([
    fetchJson<{
      data?: Array<{ value: string; value_classification: string }>
    }>(FG_URL),
    fetchJson<{
      data?: {
        total_market_cap?: { usd?: number }
        market_cap_percentage?: { btc?: number; eth?: number }
        market_cap_change_percentage_24h_usd?: number
      }
    }>(CG_GLOBAL),
    fetchJson<{
      results?: Array<{
        title?: string
        currencies?: Array<{ code?: string }>
      }>
    }>(CP_URL),
    fetchJson<
      Array<{
        total_mcap?: number
        btc_d?: string
        eth_d?: string
        mcap_change?: string
      }>
    >(LORE_GLOBAL),
  ])

  const fearGreed = fg?.data?.[0] ? parseInt(fg.data[0].value, 10) : null
  const fearGreedLabel = fg?.data?.[0]?.value_classification ?? 'n/a'

  const posts = panic?.results ?? []
  const titles = posts.map((r) => r.title ?? '').filter(Boolean)
  const globalScores = titles.map(toneOf)
  const newsScore =
    globalScores.length > 0
      ? globalScores.reduce((a, b) => a + b, 0) / globalScores.length
      : 0

  const coinAcc = new Map<string, { scores: number[]; headlines: string[] }>()
  for (const post of posts) {
    const title = post.title ?? ''
    if (!title) continue
    const tone = toneOf(title)
    const low = title.toLowerCase()
    const mentioned = new Set<string>()
    for (const c of post.currencies ?? []) {
      const code = (c.code ?? '').toUpperCase()
      if (code) mentioned.add(code)
    }
    for (const [sym, kws] of Object.entries(COIN_KEYWORDS)) {
      if (mentioned.has(sym)) continue
      if (kws.some((kw) => low.includes(kw.toLowerCase()))) mentioned.add(sym)
    }
    for (const sym of mentioned) {
      const row = coinAcc.get(sym) ?? { scores: [], headlines: [] }
      row.scores.push(tone)
      if (row.headlines.length < 3) row.headlines.push(title.slice(0, 90))
      coinAcc.set(sym, row)
    }
  }

  const coinNews: Record<string, CoinNewsHit> = {}
  for (const [sym, row] of coinAcc) {
    const score =
      row.scores.reduce((a, b) => a + b, 0) / Math.max(1, row.scores.length)
    coinNews[sym] = {
      score,
      label: labelOf(score),
      headlines: row.headlines,
    }
  }

  const now = Date.now()
  const loreRow = Array.isArray(lore) ? lore[0] : undefined
  const loreBtc = loreRow?.btc_d != null ? Number(loreRow.btc_d) : NaN
  const loreEth = loreRow?.eth_d != null ? Number(loreRow.eth_d) : NaN
  const loreMcap = loreRow?.total_mcap
  const loreChg = loreRow?.mcap_change != null ? Number(loreRow.mcap_change) : NaN

  let btcDominance = global?.data?.market_cap_percentage?.btc ?? null
  let ethDominance = global?.data?.market_cap_percentage?.eth ?? null
  let totalMcap = global?.data?.total_market_cap?.usd ?? null
  let totalMcapDelta24h =
    global?.data?.market_cap_change_percentage_24h_usd ?? null
  if (btcDominance == null && Number.isFinite(loreBtc)) btcDominance = loreBtc
  if (ethDominance == null && Number.isFinite(loreEth)) ethDominance = loreEth
  if (totalMcap == null && typeof loreMcap === 'number' && loreMcap > 0) {
    totalMcap = loreMcap
  }
  if (totalMcapDelta24h == null && Number.isFinite(loreChg)) {
    totalMcapDelta24h = loreChg
  }
  const total3Usd =
    totalMcap != null && btcDominance != null && ethDominance != null
      ? totalMcap * (100 - btcDominance - ethDominance) / 100
      : null

  let btcDomDelta24h: number | null = null
  let total3Delta24h: number | null = null
  if (btcDominance != null && total3Usd != null) {
    const snaps = await loadSnaps(kv)
    const ref = pickRefSnap(snaps, now)
    if (ref && ref.btcD > 0 && ref.total3 > 0) {
      btcDomDelta24h = btcDominance - ref.btcD
      total3Delta24h = ((total3Usd - ref.total3) / ref.total3) * 100
    }
    const last = snaps[snaps.length - 1]
    if (!last || now - last.at >= SNAP_MIN_GAP_MS) {
      const next = snaps
        .filter((s) => now - s.at < 40 * 3600_000)
        .concat({
          at: now,
          btcD: btcDominance,
          ethD: ethDominance ?? 0,
          total3: total3Usd,
        })
      await saveSnaps(next, kv)
    }
  }

  const macro = deriveAltMacro({
    btcDominance,
    btcDomDelta24h,
    total3Delta24h,
    totalMcapDelta24h,
  })

  const macroSeries = await getMacroHistory(totalMcap, kv)
  let othersUsd: number | null = null
  let othersDelta24h: number | null = null
  if (macroSeries && macroSeries.others.length >= 2) {
    const o = macroSeries.others
    othersUsd = o[o.length - 1]!
    const prev = o[o.length - 2]!
    if (prev > 0) othersDelta24h = ((othersUsd - prev) / prev) * 100
  }

  const lines: string[] = []
  if (fearGreed != null) lines.push(`Fear&Greed: ${fearGreed} (${fearGreedLabel})`)
  lines.push(
    `Новости (глоб.): ${labelOf(newsScore)} (${newsScore >= 0 ? '+' : ''}${newsScore.toFixed(2)})`
  )
  if (btcDominance != null) {
    lines.push(
      `BTC.D: ${btcDominance.toFixed(1)}%${
        btcDomDelta24h != null
          ? ` ${btcDomDelta24h >= 0 ? '+' : ''}${btcDomDelta24h.toFixed(2)}пп`
          : ''
      }`
    )
  }
  if (total3Usd != null) {
    lines.push(
      `TOTAL3: ${fmtTotal3(total3Usd)}${
        total3Delta24h != null
          ? ` ${total3Delta24h >= 0 ? '+' : ''}${total3Delta24h.toFixed(1)}%`
          : totalMcapDelta24h != null
            ? ` (TOTAL ${totalMcapDelta24h >= 0 ? '+' : ''}${totalMcapDelta24h.toFixed(1)}%)`
            : ''
      }`
    )
  }
  if (othersUsd != null) {
    lines.push(
      `OTHERS: ${fmtTotal3(othersUsd)}${
        othersDelta24h != null
          ? ` ${othersDelta24h >= 0 ? '+' : ''}${othersDelta24h.toFixed(1)}%`
          : ''
      }${macroSeries?.reconstructed ? ' (реконстр.)' : ''}`
    )
  }
  lines.push(macro.line)
  if (titles[0]) lines.push(`Headline: ${titles[0].slice(0, 80)}`)

  cache = {
    fearGreed: Number.isFinite(fearGreed as number) ? fearGreed : null,
    fearGreedLabel,
    newsScore,
    newsLabel: labelOf(newsScore),
    newsHeadlines: titles.slice(0, 3),
    coinNews,
    btcDominance,
    btcDomDelta24h,
    ethDominance,
    total3Usd,
    total3Delta24h,
    totalMcapDelta24h,
    othersUsd,
    othersDelta24h,
    altRegime: macro.altRegime,
    altBias: macro.altBias,
    macroSeries,
    fetchedAt: now,
    lines,
  }
  return cache
}

/** Coin-specific news adj — preferred over global tone when hits exist */
export function coinNewsProbabilityAdj(opts: {
  symbol: string
  side: 'LONG' | 'SHORT'
  ctx: MarketContext
}): { adj: number; factors: string[]; headlines: string[] } {
  const base = baseFromSymbol(opts.symbol)
  const hit = opts.ctx.coinNews[base]
  if (!hit || hit.headlines.length === 0) {
    return { adj: 0, factors: [], headlines: [] }
  }
  const factors: string[] = []
  let adj = 0
  if (hit.label === 'BULLISH') {
    if (opts.side === 'LONG') {
      adj += 4
      factors.push(`+4% новости по ${base} бычьи`)
    } else {
      adj -= 3
      factors.push(`−3% бычьи новости ${base} против шорта`)
    }
  } else if (hit.label === 'BEARISH') {
    if (opts.side === 'SHORT') {
      adj += 4
      factors.push(`+4% новости по ${base} медвежьи`)
    } else {
      adj -= 3
      factors.push(`−3% медвежьи новости ${base} против лонга`)
    }
  } else {
    factors.push(`новости ${base}: нейтральны`)
  }
  if (hit.headlines[0]) {
    factors.push(`«${hit.headlines[0].slice(0, 60)}»`)
  }
  return { adj, factors, headlines: hit.headlines }
}

export function contextProbabilityAdj(opts: {
  side: 'LONG' | 'SHORT'
  isBtc: boolean
  symbol?: string
  ctx: MarketContext
}): { adj: number; factors: string[] } {
  const factors: string[] = []
  let adj = 0
  const { ctx } = opts

  // Prefer coin-specific news; fall back to global only if no coin hits
  const coin = opts.symbol
    ? coinNewsProbabilityAdj({
        symbol: opts.symbol,
        side: opts.side,
        ctx,
      })
    : { adj: 0, factors: [] as string[], headlines: [] as string[] }

  if (coin.factors.length) {
    adj += coin.adj
    factors.push(...coin.factors)
  } else if (ctx.newsLabel === 'BULLISH') {
    if (opts.side === 'LONG') {
      adj += 2
      factors.push('+2% бычьи новости (глоб.)')
    } else {
      adj -= 2
      factors.push('−2% бычьи новости против шорта')
    }
  } else if (ctx.newsLabel === 'BEARISH') {
    if (opts.side === 'SHORT') {
      adj += 2
      factors.push('+2% медвежьи новости (глоб.)')
    } else {
      adj -= 2
      factors.push('−2% медвежьи новости против лонга')
    }
  }

  if (ctx.fearGreed != null) {
    const fg = ctx.fearGreed
    if (fg <= 25) {
      if (opts.side === 'LONG') {
        adj += 3
        factors.push('+3% Extreme Fear → лонг от зоны')
      } else {
        adj -= 2
        factors.push('−2% Extreme Fear → шорт осторожнее')
      }
    } else if (fg >= 75) {
      if (opts.side === 'SHORT') {
        adj += 3
        factors.push('+3% Extreme Greed → шорт от BSL')
      } else {
        adj -= 2
        factors.push('−2% Extreme Greed → лонг осторожнее')
      }
    } else if (fg <= 40 && opts.side === 'LONG') {
      adj += 1
      factors.push('+1% Fear зона')
    } else if (fg >= 60 && opts.side === 'SHORT') {
      adj += 1
      factors.push('+1% Greed зона')
    }
  }

  if (!opts.isBtc) {
    const regime = ctx.altRegime
    if (regime === 'ALT_ON') {
      if (opts.side === 'LONG') {
        adj += 4
        factors.push('+4% TOTAL3↑ BTC.D↓ альтсезон → лонг альтов')
      } else {
        adj -= 3
        factors.push('−3% альтсезон против шорта альта')
      }
    } else if (regime === 'ALT_OFF') {
      if (opts.side === 'SHORT') {
        adj += 4
        factors.push('+4% TOTAL3↓ BTC.D↑ → шорт альтов')
      } else {
        adj -= 4
        factors.push('−4% отток в BTC против лонга альта')
      }
    } else if (regime === 'BTC_LEAD') {
      if (opts.side === 'LONG') {
        adj -= 2
        factors.push('−2% рост ведёт BTC, альты отстают')
      }
    } else if (regime === 'RISK_OFF') {
      if (opts.side === 'LONG') {
        adj -= 3
        factors.push('−3% риск-офф, не ловить альты')
      } else {
        adj += 2
        factors.push('+2% риск-офф поддерживает шорт альта')
      }
    } else if (ctx.btcDominance != null) {
      if (ctx.btcDominance >= 55 && opts.side === 'LONG') {
        adj -= 2
        factors.push(`−2% BTC.D ${ctx.btcDominance.toFixed(0)}% давит альты`)
      } else if (ctx.btcDominance <= 48 && opts.side === 'LONG') {
        adj += 2
        factors.push(`+2% BTC.D ${ctx.btcDominance.toFixed(0)}% — пространство альтам`)
      }
    }
  } else if (opts.isBtc && ctx.btcDominance != null && ctx.btcDominance >= 54 && opts.side === 'LONG') {
    adj += 1
    factors.push('+1% высокая доминация поддерживает BTC')
  }

  return { adj: Math.max(-8, Math.min(8, adj)), factors }
}
