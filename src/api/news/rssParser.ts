import type { NewsItem, NewsSource } from '../../engine/sentiment/types'
import { analyzeText } from '../../engine/sentiment/analyzer'
import { extractMentionedCoins } from '../../engine/sentiment/relevance'

function getBase(): string {
  return (import.meta.env.VITE_MEXC_PROXY_URL as string | undefined) ?? ''
}

const RSS_SOURCES: Array<{ url: string; source: NewsSource }> = [
  {
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    source: 'coindesk',
  },
  {
    url: 'https://cointelegraph.com/rss',
    source: 'cointelegraph',
  },
]

function parseRSS(xml: string, source: NewsSource): NewsItem[] {
  const items: NewsItem[] = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  let match: RegExpExecArray | null

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    const title = extractTag(block, 'title')
    const link = extractTag(block, 'link')
    const description = extractTag(block, 'description')
    const pubDate = extractTag(block, 'pubDate')

    if (!title || !link) continue

    const cleanTitle = stripHtml(title)
    const cleanSummary = stripHtml(description ?? '')
    const publishedAt = pubDate
      ? Math.floor(new Date(pubDate).getTime() / 1000)
      : Math.floor(Date.now() / 1000)

    items.push({
      id: `rss_${source}_${publishedAt}_${Math.random().toString(36).slice(2, 7)}`,
      title: cleanTitle,
      summary: cleanSummary.slice(0, 200),
      url: link.trim(),
      source,
      publishedAt,
      coins: extractMentionedCoins(cleanTitle, cleanSummary),
      sentiment: analyzeText(cleanTitle, cleanSummary, source),
    })
  }

  return items
}

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(
    `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`,
    'i'
  )
  const match = xml.match(re)
  if (!match) return null
  return (match[1] ?? match[2] ?? '').trim()
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function fetchRSSNews(): Promise<NewsItem[]> {
  const base = getBase()
  const results: NewsItem[] = []

  await Promise.allSettled(
    RSS_SOURCES.map(async ({ url, source }) => {
      try {
        const proxyUrl = `${base}/news/rss?url=${encodeURIComponent(url)}`
        const res = await fetch(proxyUrl)
        if (!res.ok) return
        const xml = await res.text()
        results.push(...parseRSS(xml, source))
      } catch {
        /* optional source */
      }
    })
  )

  return results
}
