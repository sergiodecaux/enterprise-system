import type { NewsItem } from '../../engine/sentiment/types'
import { fetchCryptoPanicNews } from './cryptoPanic'
import { fetchRSSNews } from './rssParser'

export { fetchFearGreed, fearGreedToBoost } from './fearGreed'

const NEWS_CACHE_MS = 5 * 60 * 1000

let cachedNews: NewsItem[] = []
let cacheTime = 0
let cachePromise: Promise<NewsItem[]> | null = null

export async function fetchAllNews(): Promise<NewsItem[]> {
  const now = Date.now()
  if (now - cacheTime < NEWS_CACHE_MS) return cachedNews
  if (cachePromise) return cachePromise

  cachePromise = (async () => {
    try {
      const [panicNews, rssNews] = await Promise.allSettled([
        fetchCryptoPanicNews(30),
        fetchRSSNews(),
      ])

      const all: NewsItem[] = [
        ...(panicNews.status === 'fulfilled' ? panicNews.value : []),
        ...(rssNews.status === 'fulfilled' ? rssNews.value : []),
      ]

      const seen = new Set<string>()
      const dedup = all.filter((item) => {
        const key = item.title.toLowerCase().slice(0, 50)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      dedup.sort((a, b) => b.publishedAt - a.publishedAt)
      cachedNews = dedup.slice(0, 50)
      cacheTime = now
      return cachedNews
    } finally {
      cachePromise = null
    }
  })()

  return cachePromise
}
