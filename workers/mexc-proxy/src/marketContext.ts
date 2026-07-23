/**
 * Shared market context for bot signals: Fear&Greed, news tone, BTC dominance.
 * Cached per Worker isolate to avoid hammering upstreams every 2-min cron.
 */

export interface MarketContext {
  fearGreed: number | null
  fearGreedLabel: string
  /** −1…+1 from recent headlines */
  newsScore: number
  newsLabel: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  newsHeadlines: string[]
  /** BTC market-cap dominance % */
  btcDominance: number | null
  btcDomDelta24h: number | null
  fetchedAt: number
  lines: string[]
}

const FG_URL = 'https://api.alternative.me/fng/?limit=2'
const CG_GLOBAL = 'https://api.coingecko.com/api/v3/global'
const CP_URL =
  'https://cryptopanic.com/api/v1/posts/?public=true&kind=news&limit=15'

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
]

let cache: MarketContext | null = null
const CACHE_MS = 8 * 60_000

function scoreHeadlines(titles: string[]): {
  score: number
  label: MarketContext['newsLabel']
  hits: string[]
} {
  let bull = 0
  let bear = 0
  const hits: string[] = []
  for (const t of titles) {
    const low = t.toLowerCase()
    for (const w of BULL) {
      if (low.includes(w)) {
        bull += 1
        hits.push(`+${w}`)
      }
    }
    for (const w of BEAR) {
      if (low.includes(w)) {
        bear += 1
        hits.push(`-${w.trim()}`)
      }
    }
  }
  const tot = bull + bear
  const score = tot > 0 ? (bull - bear) / tot : 0
  const label: MarketContext['newsLabel'] =
    score > 0.18 ? 'BULLISH' : score < -0.18 ? 'BEARISH' : 'NEUTRAL'
  return { score, label, hits: hits.slice(0, 6) }
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

/**
 * Fetch once per ~8 min. Soft-fail → neutral context (never blocks scan).
 */
export async function getMarketContext(): Promise<MarketContext> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache

  const [fg, global, panic] = await Promise.all([
    fetchJson<{
      data?: Array<{ value: string; value_classification: string }>
    }>(FG_URL),
    fetchJson<{
      data?: {
        market_cap_percentage?: { btc?: number }
        market_cap_change_percentage_24h_usd?: number
      }
    }>(CG_GLOBAL),
    fetchJson<{ results?: Array<{ title?: string }> }>(CP_URL),
  ])

  const fearGreed = fg?.data?.[0] ? parseInt(fg.data[0].value, 10) : null
  const fearGreedLabel = fg?.data?.[0]?.value_classification ?? 'n/a'

  const titles = (panic?.results ?? [])
    .map((r) => r.title ?? '')
    .filter(Boolean)
    .slice(0, 12)
  const news = scoreHeadlines(titles)

  const btcDominance = global?.data?.market_cap_percentage?.btc ?? null
  // CoinGecko global doesn't give BTC.D delta directly — approximate via total mcap change sign + dominance level
  const btcDomDelta24h: number | null = null

  const lines: string[] = []
  if (fearGreed != null) {
    lines.push(`Fear&Greed: ${fearGreed} (${fearGreedLabel})`)
  }
  lines.push(
    `Новости: ${news.label} (${news.score >= 0 ? '+' : ''}${news.score.toFixed(2)})`
  )
  if (btcDominance != null) {
    lines.push(`BTC.D: ${btcDominance.toFixed(1)}%`)
  }
  if (titles[0]) lines.push(`Headline: ${titles[0].slice(0, 80)}`)

  cache = {
    fearGreed: Number.isFinite(fearGreed as number) ? fearGreed : null,
    fearGreedLabel,
    newsScore: news.score,
    newsLabel: news.label,
    newsHeadlines: titles.slice(0, 3),
    btcDominance,
    btcDomDelta24h,
    fetchedAt: Date.now(),
    lines,
  }
  return cache
}

/**
 * Soft probability adjustment from macro context.
 * Extreme fear helps LONGs (contrarian); greed helps SHORTs; BTC.D rising favors BTC / hurts weak alts.
 */
export function contextProbabilityAdj(opts: {
  side: 'LONG' | 'SHORT'
  isBtc: boolean
  ctx: MarketContext
}): { adj: number; factors: string[] } {
  const factors: string[] = []
  let adj = 0
  const { ctx } = opts

  if (ctx.fearGreed != null) {
    const fg = ctx.fearGreed
    if (fg <= 25) {
      // Extreme fear — better for LONG fades / worse chase shorts
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

  if (ctx.newsLabel === 'BULLISH') {
    if (opts.side === 'LONG') {
      adj += 2
      factors.push('+2% бычьи новости')
    } else {
      adj -= 2
      factors.push('−2% бычьи новости против шорта')
    }
  } else if (ctx.newsLabel === 'BEARISH') {
    if (opts.side === 'SHORT') {
      adj += 2
      factors.push('+2% медвежьи новости')
    } else {
      adj -= 2
      factors.push('−2% медвежьи новости против лонга')
    }
  }

  if (ctx.btcDominance != null) {
    // High BTC.D = risk-off alts; low = alt season bias
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

  return { adj: Math.max(-6, Math.min(6, adj)), factors }
}
