import { useEffect, useCallback, useRef } from 'react'
import type {
  NewsItem,
  FearGreedData,
  CoinSentiment,
} from '../engine/sentiment/types'
import { EMPTY_NEWS_INTEL } from '../engine/sentiment/types'
import { fetchAllNews, fetchFearGreed, fearGreedToBoost } from '../api/news'
import { aggregateSentiment } from '../engine/sentiment/analyzer'
import { isRelevantForCoin } from '../engine/sentiment/relevance'
import { useAppStore } from '../store/useAppStore'
import { CORE_WATCHLIST } from '../api/mexc'

const REFRESH_INTERVAL = 5 * 60 * 1000

function extractSymbol(internalSymbol: string): string {
  return internalSymbol.split('/')[0]
}

export function useNewsIntelligence() {
  const signals = useAppStore((s) => s.signals)
  const extraWatchlist = useAppStore((s) => s.extraWatchlist)
  const newsSettings = useAppStore((s) => s.newsSettings)
  const setNewsIntel = useAppStore((s) => s.setNewsIntel)
  const newsIntel = useAppStore((s) => s.newsIntel)

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    if (!newsSettings.enabled) {
      setNewsIntel(EMPTY_NEWS_INTEL)
      return
    }

    setNewsIntel({ isLoading: true, error: null })

    try {
      const [newsResult, fgResult] = await Promise.allSettled([
        fetchAllNews(),
        fetchFearGreed(),
      ])

      const items: NewsItem[] =
        newsResult.status === 'fulfilled' ? newsResult.value : []

      const fearGreed: FearGreedData | null =
        fgResult.status === 'fulfilled' ? fgResult.value : null

      const symbols = Array.from(
        new Set([
          ...CORE_WATCHLIST.map(extractSymbol),
          ...extraWatchlist.map(extractSymbol),
          ...signals.map((s) => extractSymbol(s.internalSymbol)),
        ])
      )

      const coinSentiments: Record<string, CoinSentiment> = {}
      const fgBoost = fearGreed ? fearGreedToBoost(fearGreed.value) : 0

      for (const sym of symbols) {
        const relevant = items.filter((item) =>
          isRelevantForCoin(sym, item.coins, item.title)
        )

        const { score, label, scoreBoost } = aggregateSentiment(
          relevant.map((item) => ({
            sentiment: item.sentiment,
            publishedAt: item.publishedAt,
          }))
        )

        coinSentiments[sym] = {
          symbol: sym,
          score,
          label,
          newsCount: relevant.length,
          items: relevant.slice(0, 5),
          scoreBoost: newsSettings.scoreInfluence
            ? scoreBoost + fgBoost * 0.5
            : 0,
          lastUpdate: Date.now(),
        }
      }

      setNewsIntel({
        items: items.slice(0, newsSettings.maxItems),
        fearGreed,
        coinSentiments,
        isLoading: false,
        lastUpdate: Date.now(),
        error: null,
      })
    } catch (err) {
      setNewsIntel({
        isLoading: false,
        error: err instanceof Error ? err.message : 'News fetch failed',
      })
    }
  }, [signals, extraWatchlist, newsSettings, setNewsIntel])

  useEffect(() => {
    refresh()
    timerRef.current = setInterval(refresh, REFRESH_INTERVAL)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [refresh])

  return newsIntel
}
