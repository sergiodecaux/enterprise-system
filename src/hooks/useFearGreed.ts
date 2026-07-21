import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { fetchFearGreed } from '../api/news'
import type { FearGreedData } from '../engine/sentiment/types'

const REFRESH_MS = 15 * 60 * 1000

export function useFearGreed() {
  const enabled = useAppStore((s) => s.newsSettings.showFearGreed)
  const fromStore = useAppStore((s) => s.newsIntel.fearGreed)
  const [data, setData] = useState<FearGreedData | null>(fromStore)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    const load = async () => {
      try {
        const fg = await fetchFearGreed()
        if (!cancelled) {
          setData(fg)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'FearGreed failed')
        }
      }
    }

    load()
    const id = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [enabled])

  useEffect(() => {
    if (fromStore) setData(fromStore)
  }, [fromStore])

  return { data, error }
}
