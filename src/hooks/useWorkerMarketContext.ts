/**
 * Cached worker market context (BTC.D, F&G, coin news) for Mini App analysis.
 */

import { useEffect, useState } from 'react'
import {
  fetchWorkerMarketContext,
  type WorkerMarketContext,
} from '../api/marketContext'

let cache: WorkerMarketContext | null = null
let cacheAt = 0
let inflight: Promise<WorkerMarketContext | null> | null = null
const TTL_MS = 6 * 60_000

export async function loadWorkerMarketContext(
  force = false
): Promise<WorkerMarketContext | null> {
  if (!force && cache && Date.now() - cacheAt < TTL_MS) return cache
  if (inflight) return inflight
  inflight = fetchWorkerMarketContext()
    .then((ctx) => {
      if (ctx) {
        cache = ctx
        cacheAt = Date.now()
      }
      return ctx
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function getCachedWorkerMarketContext(): WorkerMarketContext | null {
  return cache
}

export function useWorkerMarketContext(): WorkerMarketContext | null {
  const [ctx, setCtx] = useState<WorkerMarketContext | null>(cache)

  useEffect(() => {
    let cancelled = false
    loadWorkerMarketContext().then((c) => {
      if (!cancelled && c) setCtx(c)
    })
    const id = window.setInterval(() => {
      loadWorkerMarketContext(true).then((c) => {
        if (!cancelled && c) setCtx(c)
      })
    }, TTL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  return ctx
}
