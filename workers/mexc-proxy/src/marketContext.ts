/**
 * Shared market context: Fear&Greed, coin-relevant news, BTC dominance.
 * Cached ~8 min per Worker isolate.
 */

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
  btcDomDelta24h: number | null
  fetchedAt: number
  lines: string[]
}

const FG_URL = 'https://api.alternative.me/fng/?limit=2'
const CG_GLOBAL = 'https://api.coingecko.com/api/v3/global'
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

export async function getMarketContext(): Promise<MarketContext> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache

  const [fg, global, panic] = await Promise.all([
    fetchJson<{
      data?: Array<{ value: string; value_classification: string }>
    }>(FG_URL),
    fetchJson<{
      data?: {
        market_cap_percentage?: { btc?: number }
      }
    }>(CG_GLOBAL),
    fetchJson<{
      results?: Array<{
        title?: string
        currencies?: Array<{ code?: string }>
      }>
    }>(CP_URL),
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

  const btcDominance = global?.data?.market_cap_percentage?.btc ?? null
  const lines: string[] = []
  if (fearGreed != null) lines.push(`Fear&Greed: ${fearGreed} (${fearGreedLabel})`)
  lines.push(
    `Новости (глоб.): ${labelOf(newsScore)} (${newsScore >= 0 ? '+' : ''}${newsScore.toFixed(2)})`
  )
  if (btcDominance != null) lines.push(`BTC.D: ${btcDominance.toFixed(1)}%`)
  if (titles[0]) lines.push(`Headline: ${titles[0].slice(0, 80)}`)

  cache = {
    fearGreed: Number.isFinite(fearGreed as number) ? fearGreed : null,
    fearGreedLabel,
    newsScore,
    newsLabel: labelOf(newsScore),
    newsHeadlines: titles.slice(0, 3),
    coinNews,
    btcDominance,
    btcDomDelta24h: null,
    fetchedAt: Date.now(),
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

  if (ctx.btcDominance != null) {
    if (!opts.isBtc) {
      if (ctx.btcDominance >= 55 && opts.side === 'LONG') {
        adj -= 2
        factors.push(`−2% BTC.D ${ctx.btcDominance.toFixed(0)}% давит альты`)
      } else if (ctx.btcDominance <= 48 && opts.side === 'LONG') {
        adj += 2
        factors.push(`+2% BTC.D ${ctx.btcDominance.toFixed(0)}% — пространство альтам`)
      }
    } else if (opts.isBtc && ctx.btcDominance >= 54 && opts.side === 'LONG') {
      adj += 1
      factors.push('+1% высокая доминация поддерживает BTC')
    }
  }

  return { adj: Math.max(-8, Math.min(8, adj)), factors }
}
