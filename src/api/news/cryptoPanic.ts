import type { NewsItem, NewsSource } from '../../engine/sentiment/types'
import { analyzeText } from '../../engine/sentiment/analyzer'
import { extractMentionedCoins } from '../../engine/sentiment/relevance'

function getBase(): string {
  return (import.meta.env.VITE_MEXC_PROXY_URL as string | undefined) ?? ''
}

interface CPPost {
  id: number
  title: string
  published_at: string
  url: string
  source: { title: string; domain: string }
  currencies?: Array<{ code: string }>
}

interface CPResponse {
  results: CPPost[]
}

export async function fetchCryptoPanicNews(limit = 20): Promise<NewsItem[]> {
  const base = getBase()
  const url = `${base}/news/panic/api/v1/posts/?public=true&kind=news&limit=${limit}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`CryptoPanic: ${res.status}`)

  const data = (await res.json()) as CPResponse
  if (!Array.isArray(data.results)) return []

  return data.results.map((post) => {
    const source = detectSource(post.source?.domain ?? '')
    const coins =
      post.currencies?.map((c) => c.code.toUpperCase()) ??
      extractMentionedCoins(post.title, '')

    return {
      id: `cp_${post.id}`,
      title: post.title,
      url: post.url,
      source,
      publishedAt: Math.floor(new Date(post.published_at).getTime() / 1000),
      coins,
      sentiment: analyzeText(post.title, '', source),
    }
  })
}

function detectSource(domain: string): NewsSource {
  if (domain.includes('coindesk')) return 'coindesk'
  if (domain.includes('cointelegraph')) return 'cointelegraph'
  if (domain.includes('decrypt')) return 'decrypt'
  if (domain.includes('theblock')) return 'theblock'
  if (domain.includes('reuters')) return 'reuters'
  if (domain.includes('bloomberg')) return 'bloomberg'
  return 'cryptopanic'
}
