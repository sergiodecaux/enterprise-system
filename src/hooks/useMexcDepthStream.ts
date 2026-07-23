/**
 * MEXC contract WebSocket — live depth + deal tape for the open symbol.
 * Falls back to REST when the socket is down or stale.
 *
 * Endpoint: wss://contract.mexc.com/edge
 * Channels: sub.depth.full + sub.deal
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toApiSymbol, type MexcTrade } from '../api/mexc'
import type { OrderBookLevel, OrderBookSnapshot } from '../engine/types'
import { logger } from '../utils/logger'

const DEFAULT_WS =
  (import.meta.env.VITE_MEXC_WS_URL as string | undefined)?.trim() ||
  'wss://contract.mexc.com/edge'

const PING_MS = 15_000
const STALE_MS = 4_000
const MAX_TRADES = 120

export type DepthStreamSource = 'ws' | 'rest' | 'idle'

export interface MexcDepthStreamState {
  snapshot: OrderBookSnapshot | null
  trades: MexcTrade[]
  source: DepthStreamSource
  connected: boolean
  lastWsAt: number
  error: string | null
}

function parseWsLevel(arr: unknown[]): OrderBookLevel | null {
  if (!Array.isArray(arr) || arr.length < 2) return null
  const price = Number(arr[0])
  // REST: [price, volume, orderCount]
  // WS note: [price, orderCount, volume] — detect by magnitude heuristics
  const a = Number(arr[1] ?? 0)
  const b = Number(arr[2] ?? 0)
  let volume = a
  let orderCount = b
  // If second value looks like integer order-count and third is volume
  if (
    arr.length >= 3 &&
    Number.isFinite(b) &&
    b > 0 &&
    Number.isInteger(a) &&
    a < 5000 &&
    b !== a
  ) {
    // Prefer documented WS layout when a is small integer-like
    if (a <= 200 && b >= a) {
      orderCount = a
      volume = b
    }
  }
  if (!(price > 0) || !(volume >= 0)) return null
  return { price, volume, orderCount: orderCount || 0 }
}

function levelsFromWs(
  rows: unknown[] | undefined,
  side: 'bid' | 'ask'
): OrderBookLevel[] {
  if (!rows?.length) return []
  const out: OrderBookLevel[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const lvl = parseWsLevel(row)
    if (lvl && lvl.volume > 0) out.push(lvl)
  }
  out.sort((a, b) =>
    side === 'bid' ? b.price - a.price : a.price - b.price
  )
  return out
}

function parseDealPayload(data: unknown, symbol: string): MexcTrade[] {
  const list = Array.isArray(data) ? data : data ? [data] : []
  const out: MexcTrade[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const price = Number(row.p)
    const volume = Number(row.v)
    const sideRaw = Number(row.T)
    let t = Number(row.t ?? row.cts ?? Date.now())
    if (t < 1_000_000_000_000) t *= 1000
    if (!(price > 0) || !(volume > 0)) continue
    out.push({
      timestamp: t,
      price,
      volume,
      side: sideRaw === 1 ? 'BUY' : 'SELL',
    })
    void symbol
  }
  return out
}

/**
 * Live MEXC depth + tape for one symbol. REST fallback handled by caller
 * when `connected` is false or `lastWsAt` is stale.
 */
export function useMexcDepthStream(
  symbol: string,
  depthLimit = 20,
  enabled = true
): MexcDepthStreamState & {
  ingestRestSnapshot: (snap: OrderBookSnapshot) => void
  ingestRestTrades: (trades: MexcTrade[]) => void
  isWsFresh: boolean
} {
  const [snapshot, setSnapshot] = useState<OrderBookSnapshot | null>(null)
  const [trades, setTrades] = useState<MexcTrade[]>([])
  const [connected, setConnected] = useState(false)
  const [lastWsAt, setLastWsAt] = useState(0)
  const [source, setSource] = useState<DepthStreamSource>('idle')
  const [error, setError] = useState<string | null>(null)
  const [nowTick, setNowTick] = useState(0)

  const wsRef = useRef<WebSocket | null>(null)
  const pingRef = useRef<number | null>(null)
  const symbolRef = useRef(symbol)
  const lastWsAtRef = useRef(0)

  const ingestRestSnapshot = useCallback((snap: OrderBookSnapshot) => {
    setSnapshot(snap)
    setSource((prev) =>
      prev === 'ws' && Date.now() - lastWsAtRef.current < STALE_MS ? prev : 'rest'
    )
  }, [])

  const ingestRestTrades = useCallback((next: MexcTrade[]) => {
    if (!next.length) return
    setTrades((prev) => {
      const merged = [...next, ...prev]
      const seen = new Set<string>()
      const out: MexcTrade[] = []
      for (const t of merged) {
        const k = `${t.timestamp}:${t.price}:${t.volume}:${t.side}`
        if (seen.has(k)) continue
        seen.add(k)
        out.push(t)
        if (out.length >= MAX_TRADES) break
      }
      return out
    })
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    symbolRef.current = symbol
    setSnapshot(null)
    setTrades([])
    setLastWsAt(0)
    setSource('idle')
    setError(null)
    setConnected(false)

    if (!enabled || !symbol) return

    let closed = false
    let retryMs = 1500
    let retryTimer: number | null = null

    const clearPing = () => {
      if (pingRef.current != null) {
        window.clearInterval(pingRef.current)
        pingRef.current = null
      }
    }

    const connect = () => {
      if (closed) return
      const apiSymbol = toApiSymbol(symbol)
      let ws: WebSocket
      try {
        ws = new WebSocket(DEFAULT_WS)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'WS init failed')
        setConnected(false)
        retryTimer = window.setTimeout(connect, retryMs)
        retryMs = Math.min(20_000, retryMs * 1.6)
        return
      }
      wsRef.current = ws

      ws.onopen = () => {
        if (closed || symbolRef.current !== symbol) {
          ws.close()
          return
        }
        setConnected(true)
        setError(null)
        retryMs = 1500
        // Full snapshot stream (preferred) + incremental backup + deals
        ws.send(
          JSON.stringify({
            method: 'sub.depth.full',
            param: { symbol: apiSymbol, limit: depthLimit },
          })
        )
        ws.send(
          JSON.stringify({
            method: 'sub.depth',
            param: { symbol: apiSymbol },
          })
        )
        ws.send(
          JSON.stringify({
            method: 'sub.deal',
            param: { symbol: apiSymbol },
          })
        )
        clearPing()
        pingRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ method: 'ping' }))
          }
        }, PING_MS)
      }

      ws.onmessage = (ev) => {
        if (closed || symbolRef.current !== symbol) return
        let msg: {
          channel?: string
          symbol?: string
          data?: unknown
          ts?: number
        }
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (!msg?.channel) return

        if (msg.channel === 'pong' || msg.channel === 'rs.ping') return

        const ch = msg.channel
        if (
          (ch === 'push.depth.full' || ch === 'push.depth') &&
          msg.data &&
          typeof msg.data === 'object'
        ) {
          const d = msg.data as {
            asks?: unknown[]
            bids?: unknown[]
            version?: number
            cts?: number
          }
          // Incremental pushes may be empty deltas — skip empty
          if (!d.bids?.length && !d.asks?.length) return
          // Prefer full channel; for incremental only accept if we have both sides
          if (ch === 'push.depth' && (!(d.bids?.length) || !(d.asks?.length))) {
            return
          }
          const bids = levelsFromWs(d.bids, 'bid').slice(0, depthLimit)
          const asks = levelsFromWs(d.asks, 'ask').slice(0, depthLimit)
          if (!bids.length || !asks.length) return
          const snap: OrderBookSnapshot = {
            symbol,
            bids,
            asks,
            version: Number(d.version ?? 0),
            timestamp: Number(d.cts ?? msg.ts ?? Date.now()),
          }
          setSnapshot(snap)
          setLastWsAt(Date.now())
          lastWsAtRef.current = Date.now()
          setSource('ws')
          return
        }

        if (ch === 'push.deal') {
          const batch = parseDealPayload(msg.data, symbol)
          if (!batch.length) return
          setTrades((prev) => [...batch, ...prev].slice(0, MAX_TRADES))
          setLastWsAt(Date.now())
          lastWsAtRef.current = Date.now()
          setSource('ws')
        }
      }

      ws.onerror = () => {
        setError('MEXC WS error')
        logger.warn('[MexcWS] error', apiSymbol)
      }

      ws.onclose = () => {
        setConnected(false)
        clearPing()
        if (closed) return
        retryTimer = window.setTimeout(connect, retryMs)
        retryMs = Math.min(20_000, retryMs * 1.6)
      }
    }

    connect()

    return () => {
      closed = true
      clearPing()
      if (retryTimer != null) window.clearTimeout(retryTimer)
      try {
        wsRef.current?.close()
      } catch {
        /* ignore */
      }
      wsRef.current = null
    }
  }, [symbol, depthLimit, enabled])

  void nowTick
  const isWsFresh = connected && Date.now() - lastWsAt < STALE_MS

  return {
    snapshot,
    trades,
    source: isWsFresh ? 'ws' : source === 'ws' ? 'rest' : source,
    connected,
    lastWsAt,
    error,
    ingestRestSnapshot,
    ingestRestTrades,
    isWsFresh,
  }
}
