import { useEffect, useRef } from 'react'
import {
  CORE_WATCHLIST,
  fetchOhlcv,
  fetchTickers,
  sleep,
  toFlatSymbol,
} from '../api/mexc'
import { useAppStore } from '../store/useAppStore'
import {
  buildRadar141Row,
  changePct,
  recordFalse141Exit,
  recordFlight,
  type Radar141Row,
  type TriggerState,
} from '../engine/radar141'
import { logger } from '../utils/logger'

const BTC = 'BTC/USDT:USDT'
const SCAN_MS = 120_000
const COIN_DELAY = 180
const MAX_UNIVERSE = 22
const BASKET = ['ETH/USDT:USDT', 'SOL/USDT:USDT', 'BNB/USDT:USDT'] as const

const RISK_RE = /delist|делист|hack|взлом|sec\b|ban|lawsuit|halt|suspend/i

function displayOf(internal: string): string {
  return toFlatSymbol(internal).replace('_USDT', '/USDT')
}

export function useRadar141Screener() {
  const mounted = useRef(true)
  const prevTrigger = useRef<Record<string, TriggerState>>({})
  const prevPrice = useRef<Record<string, number>>({})

  useEffect(() => {
    mounted.current = true
    let cancelled = false

    const cycle = async () => {
      const store = useAppStore.getState()
      store.setRadar141Meta({
        scanning: true,
        progress: 'тикеры…',
        error: null,
      })
      try {
        const tickers = await fetchTickers()
        if (cancelled || !mounted.current) return
        const extra = store.extraWatchlist
        const bySym = new Map(tickers.map((t) => [t.symbol, t]))

        const liquid = tickers
          .filter((t) => t.volume24h >= 4_000_000 && t.lastPrice > 0)
          .sort((a, b) => b.volume24h - a.volume24h)

        const pinned = new Set<string>([...CORE_WATCHLIST, ...extra])
        const universe: string[] = []
        for (const s of pinned) {
          if (!universe.includes(s)) universe.push(s)
        }
        for (const t of liquid) {
          if (universe.length >= MAX_UNIVERSE) break
          if (!universe.includes(t.symbol)) universe.push(t.symbol)
        }

        const [btc1h, ...basket1h] = await Promise.all([
          fetchOhlcv(BTC, '1h', 80),
          ...BASKET.map((s) => fetchOhlcv(s, '1h', 40).catch(() => [])),
        ])
        if (cancelled) return
        const marketMoves = basket1h
          .filter((c) => c.length > 10)
          .map((c) => changePct(c, Math.min(24, c.length - 1)))
        const marketChange1d =
          marketMoves.length > 0
            ? marketMoves.reduce((a, b) => a + b, 0) / marketMoves.length
            : 0

        const news = store.newsIntel
        const rows: Radar141Row[] = []

        for (let i = 0; i < universe.length; i++) {
          if (cancelled || !mounted.current) return
          const internal = universe[i]
          store.setRadar141Meta({
            scanning: true,
            progress: `${i + 1}/${universe.length} ${displayOf(internal)}`,
            error: null,
          })
          const t = bySym.get(internal)
          const price = t?.lastPrice ?? store.liveTickets[toFlatSymbol(internal)]?.price ?? 0
          if (!(price > 0) && internal !== BTC) {
            await sleep(COIN_DELAY)
            continue
          }
          try {
            const [c1h, c4h, c1d] = await Promise.all([
              fetchOhlcv(internal, '1h', 80),
              fetchOhlcv(internal, '4h', 70),
              fetchOhlcv(internal, '1d', 60),
            ])
            if (c1h.length < 20 || c4h.length < 12) {
              await sleep(COIN_DELAY)
              continue
            }
            const base = displayOf(internal).replace('/USDT', '')
            const sent = news.coinSentiments[base]
            const newsHit = news.items.some((it) => {
              const blob = `${it.title} ${it.summary ?? ''}`
              const mentions =
                it.coins?.some((c) => c.toUpperCase() === base) ||
                blob.toUpperCase().includes(base)
              return mentions && RISK_RE.test(blob)
            })
            const newsRisk =
              newsHit || sent?.label === 'BEARISH' && (sent.score ?? 0) <= -0.45
            const newsNote = newsHit
              ? 'новость / делистинг-риск'
              : sent?.label === 'BEARISH'
                ? 'негатив в ленте'
                : null

            const prev = prevTrigger.current[internal] ?? null
            const row = buildRadar141Row({
              internalSymbol: internal,
              displayName: displayOf(internal),
              price: price || c1h[c1h.length - 1][4],
              change24h: t?.priceChangePercent ?? 0,
              volume24h: t?.volume24h ?? 0,
              openInterest: t?.openInterest,
              candles1h: c1h,
              candles4h: c4h,
              candles1d: c1d,
              btc1h,
              marketChange1d,
              newsRisk,
              newsNote,
              prevTrigger: prev,
            })

            const lastPx = prevPrice.current[internal]
            if (prev === 'INSIDE_141' && row.trigger === 'APPROACH_141') {
              recordFalse141Exit(internal)
            }
            if (
              (prev === 'EXIT_141' || prev === 'INSIDE_141') &&
              row.trigger === 'IN_GAP' &&
              lastPx != null &&
              lastPx > 0
            ) {
              recordFlight(internal, ((row.price - lastPx) / lastPx) * 100)
            }
            prevTrigger.current[internal] = row.trigger
            prevPrice.current[internal] = row.price
            rows.push(row)
          } catch (err) {
            logger.warn('radar141 coin failed', internal, err)
          }
          await sleep(COIN_DELAY)
        }

        if (cancelled || !mounted.current) return
        useAppStore.getState().setRadar141Rows(rows)
        useAppStore.getState().setRadar141Meta({
          scanning: false,
          progress: `${rows.length} монет`,
          lastScanAt: Date.now(),
          universeSize: universe.length,
          error: null,
        })
      } catch (err) {
        logger.warn('radar141 cycle failed', err)
        if (!cancelled) {
          useAppStore.getState().setRadar141Meta({
            scanning: false,
            error: 'скан не удался',
          })
        }
      }
    }

    void cycle()
    const id = window.setInterval(() => void cycle(), SCAN_MS)
    return () => {
      cancelled = true
      mounted.current = false
      window.clearInterval(id)
    }
  }, [])
}
