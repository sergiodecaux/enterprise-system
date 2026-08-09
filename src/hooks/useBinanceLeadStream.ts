/**
 * Binance USDT-M lead stream (aggTrade + depth5) for cross-venue context.
 * Does not trade on Binance — feeds VenueLead into Remizov FrameBus.
 */

import { useEffect, useRef, useState } from 'react'
import {
  binanceStreamSymbol,
  shouldAttachBinanceLead,
  toBinanceFuturesSymbol,
} from '../api/binance/symbols'
import {
  getVenueLeadCache,
  setVenueLeadCache,
  type VenueLeadSnapshot,
} from '../engine/sequence/venueLead'

const WS_BASE =
  (import.meta.env.VITE_BINANCE_FUTURES_WS as string | undefined)?.trim() ||
  'wss://fstream.binance.com/stream'

const STALE_MS = 8_000

interface AggTrade {
  t: number
  price: number
  qty: number
  buyerIsMaker: boolean
}

export interface BinanceLeadState {
  lead: VenueLeadSnapshot | null
  connected: boolean
  error: string | null
}

function depthObi(
  bids: Array<[string, string]> | undefined,
  asks: Array<[string, string]> | undefined
): { mid: number | null; obi: number | null } {
  if (!bids?.length || !asks?.length) return { mid: null, obi: null }
  let bidVol = 0
  let askVol = 0
  for (const [p, q] of bids.slice(0, 5)) {
    bidVol += Number(p) * Number(q)
  }
  for (const [p, q] of asks.slice(0, 5)) {
    askVol += Number(p) * Number(q)
  }
  const mid = (Number(bids[0]![0]) + Number(asks[0]![0])) / 2
  const tot = bidVol + askVol
  const obi = tot > 0 ? ((bidVol - askVol) / tot) * 100 : 0
  return { mid: mid > 0 ? mid : null, obi }
}

/**
 * Subscribe to Binance futures lead for the open Mini App symbol.
 */
export function useBinanceLeadStream(symbol: string): BinanceLeadState {
  const [state, setState] = useState<BinanceLeadState>({
    lead: null,
    connected: false,
    error: null,
  })
  const tradesRef = useRef<AggTrade[]>([])
  const midHistRef = useRef<Array<{ at: number; mid: number }>>([])
  const lastDepthRef = useRef<{ mid: number | null; obi: number | null }>({
    mid: null,
    obi: null,
  })

  useEffect(() => {
    setVenueLeadCache(symbol, null)
    setState({ lead: null, connected: false, error: null })
    tradesRef.current = []
    midHistRef.current = []

    if (!shouldAttachBinanceLead(symbol)) {
      return
    }
    const streamSym = binanceStreamSymbol(symbol)
    const fut = toBinanceFuturesSymbol(symbol)
    if (!streamSym || !fut) return

    const streams = `${streamSym}@aggTrade/${streamSym}@depth5@100ms`
    const url = `${WS_BASE}?streams=${streams}`
    let ws: WebSocket | null = null
    let closed = false
    let watchdog: ReturnType<typeof setInterval> | null = null
    let publishTimer: ReturnType<typeof setInterval> | null = null

    const publish = () => {
      if (closed) return
      const now = Date.now()
      const trades = tradesRef.current.filter((t) => now - t.t <= 60_000)
      tradesRef.current = trades
      let buy = 0
      let sell = 0
      for (const t of trades) {
        const usd = t.price * t.qty
        if (!t.buyerIsMaker) buy += usd
        else sell += usd
      }
      const tot = buy + sell
      const buyFlowPct = tot > 0 ? (buy / tot) * 100 : 50
      const mid = lastDepthRef.current.mid
      if (mid != null && mid > 0) {
        midHistRef.current.push({ at: now, mid })
        midHistRef.current = midHistRef.current.filter((m) => now - m.at <= 45_000)
      }
      const old = midHistRef.current.find((m) => now - m.at >= 25_000)
      const moveBps30s =
        old && mid != null && old.mid > 0
          ? ((mid - old.mid) / old.mid) * 10_000
          : 0

      const snap: VenueLeadSnapshot = {
        venue: 'BINANCE',
        binanceSymbol: fut,
        at: now,
        mid,
        deltaUsd1m: buy - sell,
        moveBps30s: Number(moveBps30s.toFixed(1)),
        buyFlowPct: Number(buyFlowPct.toFixed(1)),
        obi: lastDepthRef.current.obi,
        connected: true,
      }
      setVenueLeadCache(symbol, snap)
      setState({ lead: snap, connected: true, error: null })
    }

    try {
      ws = new WebSocket(url)
    } catch (err) {
      setState({
        lead: null,
        connected: false,
        error: String(err).slice(0, 120),
      })
      return
    }

    ws.onopen = () => {
      setState((s) => ({ ...s, connected: true, error: null }))
      publishTimer = setInterval(publish, 1200)
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          stream?: string
          data?: Record<string, unknown>
        }
        const data = msg.data
        if (!data) return
        const stream = msg.stream ?? ''

        if (stream.includes('@aggTrade')) {
          const price = Number(data.p)
          const qty = Number(data.q)
          const t = Number(data.T ?? Date.now())
          const buyerIsMaker = Boolean(data.m)
          if (price > 0 && qty > 0) {
            tradesRef.current.push({ t, price, qty, buyerIsMaker })
            if (tradesRef.current.length > 400) {
              tradesRef.current = tradesRef.current.slice(-300)
            }
          }
          return
        }

        if (stream.includes('@depth')) {
          const bids = data.b as Array<[string, string]> | undefined
          const asks = data.a as Array<[string, string]> | undefined
          lastDepthRef.current = depthObi(bids, asks)
        }
      } catch {
        /* ignore parse */
      }
    }

    ws.onerror = () => {
      setState((s) => ({
        ...s,
        connected: false,
        error: 'Binance WS error',
      }))
    }

    ws.onclose = () => {
      if (closed) return
      setState((s) => ({ ...s, connected: false }))
      setVenueLeadCache(symbol, null)
    }

    watchdog = setInterval(() => {
      const cached = getVenueLeadCache(symbol, STALE_MS)
      if (!cached) {
        setState((s) => (s.connected ? { ...s, connected: false } : s))
      }
    }, 4000)

    return () => {
      closed = true
      if (watchdog) clearInterval(watchdog)
      if (publishTimer) clearInterval(publishTimer)
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
      setVenueLeadCache(symbol, null)
    }
  }, [symbol])

  return state
}
