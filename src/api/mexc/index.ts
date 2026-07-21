import type { OrderBookLevel, OrderBookSnapshot } from '../../engine/types'

/** Candle in ccxt-compatible format: [timestamp_ms, open, high, low, close, volume] */
export type OhlcvCandle = [number, number, number, number, number, number]

export interface MexcTrade {
  /** Unix timestamp в миллисекундах */
  timestamp: number
  /** Цена сделки */
  price: number
  /** Объём в базовой валюте */
  volume: number
  /** Направление: BUY = рыночная покупка, SELL = рыночная продажа */
  side: 'BUY' | 'SELL'
}

export type MexcTimeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

export interface MexcTicker {
  symbol: string // internal: BTC/USDT:USDT
  apiSymbol: string // BTC_USDT
  lastPrice: number
  priceChangePercent: number
  volume24h: number
  high24h: number
  low24h: number
  timestamp: number
  /** Open Interest (holdVol) — контракты */
  openInterest?: number
  /** Текущая ставка финансирования (доля, не %) */
  fundingRate?: number
}

const TIMEFRAME_MAP: Record<MexcTimeframe, string> = {
  '1m': 'Min1',
  '5m': 'Min5',
  '15m': 'Min15',
  '1h': 'Min60',
  '4h': 'Hour4',
  '1d': 'Day1',
}

/** Chart UI timeframes */
export const CHART_TIMEFRAMES: Array<{ id: MexcTimeframe; label: string }> = [
  { id: '1m', label: '1м' },
  { id: '5m', label: '5м' },
  { id: '15m', label: '15м' },
  { id: '1h', label: '1ч' },
  { id: '4h', label: '4ч' },
  { id: '1d', label: '1д' },
]

const STABLE_BLACKLIST = new Set([
  'USDC_USDT',
  'BUSD_USDT',
  'DAI_USDT',
  'TUSD_USDT',
  'USDP_USDT',
])

/** 10 основных пар — лёгкий старт без перегрузки TMA */
export const CORE_WATCHLIST = [
  'BTC/USDT:USDT',
  'ETH/USDT:USDT',
  'SOL/USDT:USDT',
  'XRP/USDT:USDT',
  'BNB/USDT:USDT',
  'ADA/USDT:USDT',
  'DOGE/USDT:USDT',
  'AVAX/USDT:USDT',
  'LINK/USDT:USDT',
  'LTC/USDT:USDT',
] as const

/** @deprecated use CORE_WATCHLIST */
export const LITE_WATCHLIST = CORE_WATCHLIST

export function getMexcBaseUrl(): string {
  const envUrl = import.meta.env.VITE_MEXC_PROXY_URL as string | undefined
  if (envUrl && envUrl.trim()) {
    // Worker routes MEXC under /mexc → contract.mexc.com
    return `${envUrl.replace(/\/$/, '')}/mexc`
  }
  // Dev: Vite proxy; prod without worker still tries relative /mexc (will fail CORS unless proxied)
  return '/mexc'
}

export function toApiSymbol(internal: string): string {
  // BTC/USDT:USDT → BTC_USDT
  return internal.replace('/USDT:USDT', '_USDT').replace('/', '_')
}

export function toInternalSymbol(apiSymbol: string): string {
  // BTC_USDT → BTC/USDT:USDT
  if (apiSymbol.endsWith('_USDT')) {
    const base = apiSymbol.slice(0, -5)
    return `${base}/USDT:USDT`
  }
  return apiSymbol
}

export function toDisplayName(internal: string): string {
  // BTC/USDT:USDT → BTC/USDT
  return internal.replace(':USDT', '')
}

export function toFlatSymbol(internal: string): string {
  // BTC/USDT:USDT → BTCUSDT
  return internal.replace('/USDT:USDT', 'USDT').replace('/', '')
}

async function mexcGet<T>(path: string): Promise<T> {
  const base = getMexcBaseUrl()
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`MEXC HTTP ${res.status}: ${path}`)
  }
  const json = await res.json()
  if (json && typeof json === 'object' && 'success' in json && json.success === false) {
    throw new Error(`MEXC API error: ${json.message ?? json.code ?? 'unknown'}`)
  }
  return json as T
}

interface MexcKlineResponse {
  success: boolean
  code: number
  data: {
    time: number[]
    open: number[]
    high: number[]
    low: number[]
    close: number[]
    vol: number[]
  }
}

interface MexcTickerRow {
  symbol: string
  lastPrice: number
  riseFallRate: number
  volume24: number
  amount24?: number
  high24Price: number
  lower24Price: number
  timestamp: number
  holdVol?: number
  fundingRate?: number
}

interface MexcTickerResponse {
  success: boolean
  data: MexcTickerRow | MexcTickerRow[]
}

/**
 * Fetch OHLCV candles (ccxt-compatible array).
 * MEXC returns parallel arrays; time is unix seconds.
 */
export async function fetchOhlcv(
  symbol: string,
  timeframe: MexcTimeframe,
  limit = 100
): Promise<OhlcvCandle[]> {
  const apiSymbol = toApiSymbol(symbol)
  const interval = TIMEFRAME_MAP[timeframe]
  const json = await mexcGet<MexcKlineResponse>(
    `/api/v1/contract/kline/${apiSymbol}?interval=${interval}&limit=${limit}`
  )

  const d = json.data
  if (!d?.time?.length) return []

  const candles: OhlcvCandle[] = []
  for (let i = 0; i < d.time.length; i++) {
    candles.push([
      d.time[i] * 1000,
      Number(d.open[i]),
      Number(d.high[i]),
      Number(d.low[i]),
      Number(d.close[i]),
      Number(d.vol[i] ?? 0),
    ])
  }
  return candles
}

/**
 * Order Book / Market Depth
 * @param symbol Internal format (BTC/USDT:USDT)
 * @param limit Levels per side (5, 10, 20, 50, 100)
 */
export async function fetchDepth(
  symbol: string,
  limit = 20
): Promise<OrderBookSnapshot> {
  const apiSymbol = toApiSymbol(symbol)

  interface MexcDepthResponse {
    success: boolean
    code: number
    data: {
      asks: [number, number, number][]
      bids: [number, number, number][]
      version: number
      timestamp: number
    }
  }

  const res = await mexcGet<MexcDepthResponse>(
    `/api/v1/contract/depth/${apiSymbol}?limit=${limit}`
  )

  const parseLevel = (arr: [number, number, number]): OrderBookLevel => ({
    price: Number(arr[0]),
    volume: Number(arr[1]),
    orderCount: Number(arr[2]),
  })

  const asks = (res.data?.asks ?? []).map(parseLevel)
  const bids = (res.data?.bids ?? []).map(parseLevel)

  return {
    symbol,
    bids,
    asks,
    version: Number(res.data?.version ?? 0),
    timestamp: Number(res.data?.timestamp ?? Date.now()),
  }
}

export async function fetchTickers(): Promise<MexcTicker[]> {
  const json = await mexcGet<MexcTickerResponse>('/api/v1/contract/ticker')
  const rows = Array.isArray(json.data) ? json.data : json.data ? [json.data] : []

  return rows
    .filter((row) => row.symbol?.endsWith('_USDT') && !STABLE_BLACKLIST.has(row.symbol))
    .map((row) => ({
      symbol: toInternalSymbol(row.symbol),
      apiSymbol: row.symbol,
      lastPrice: Number(row.lastPrice),
      // riseFallRate is fraction (e.g. -0.0028 → -0.28%)
      priceChangePercent: Number(row.riseFallRate) * 100,
      volume24h: Number(row.amount24 ?? row.volume24 ?? 0),
      high24h: Number(row.high24Price),
      low24h: Number(row.lower24Price),
      timestamp: Number(row.timestamp),
      openInterest: row.holdVol != null ? Number(row.holdVol) : undefined,
      fundingRate: row.fundingRate != null ? Number(row.fundingRate) : undefined,
    }))
}

export async function fetchTicker(symbol: string): Promise<MexcTicker | null> {
  const apiSymbol = toApiSymbol(symbol)
  const json = await mexcGet<MexcTickerResponse>(
    `/api/v1/contract/ticker?symbol=${apiSymbol}`
  )
  const row = Array.isArray(json.data) ? json.data[0] : json.data
  if (!row) return null
  return {
    symbol: toInternalSymbol(row.symbol),
    apiSymbol: row.symbol,
    lastPrice: Number(row.lastPrice),
    priceChangePercent: Number(row.riseFallRate) * 100,
    volume24h: Number(row.amount24 ?? row.volume24 ?? 0),
    high24h: Number(row.high24Price),
    low24h: Number(row.lower24Price),
    timestamp: Number(row.timestamp),
    openInterest: row.holdVol != null ? Number(row.holdVol) : undefined,
    fundingRate: row.fundingRate != null ? Number(row.fundingRate) : undefined,
  }
}

export interface MexcFundingRate {
  symbol: string
  fundingRate: number
  maxFundingRate: number | null
  minFundingRate: number | null
  nextSettleTime: number | null
  timestamp: number
}

/**
 * Текущая ставка финансирования контракта.
 * GET /api/v1/contract/funding_rate/{symbol}
 */
export async function fetchFundingRate(
  symbol: string
): Promise<MexcFundingRate | null> {
  const apiSymbol = toApiSymbol(symbol)
  try {
    const json = await mexcGet<{
      success: boolean
      data: {
        symbol: string
        fundingRate: number
        maxFundingRate?: number
        minFundingRate?: number
        nextSettleTime?: number
        timestamp: number
      }
    }>(`/api/v1/contract/funding_rate/${apiSymbol}`)

    if (!json.data) return null
    return {
      symbol: json.data.symbol,
      fundingRate: Number(json.data.fundingRate),
      maxFundingRate:
        json.data.maxFundingRate != null
          ? Number(json.data.maxFundingRate)
          : null,
      minFundingRate:
        json.data.minFundingRate != null
          ? Number(json.data.minFundingRate)
          : null,
      nextSettleTime: json.data.nextSettleTime ?? null,
      timestamp: Number(json.data.timestamp ?? Date.now()),
    }
  } catch {
    return null
  }
}

/** Top N by quote volume (amount24), like SniperBot get_top_coins */
export async function getTopVolumeCoins(limit = 30): Promise<string[]> {
  const tickers = await fetchTickers()
  return tickers
    .slice()
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, limit)
    .map((t) => t.symbol)
}

/** Normalize user query to match against ticker symbols */
export function normalizeSearchQuery(query: string): string {
  return query
    .trim()
    .toUpperCase()
    .replace(/[/:_-]/g, '')
    .replace(/USDT$/, '')
}

/**
 * Filter USDT perpetual tickers by search query (base asset).
 * Returns up to `limit` matches sorted by volume.
 */
export function filterTickersByQuery(
  tickers: MexcTicker[],
  query: string,
  limit = 12
): MexcTicker[] {
  const q = normalizeSearchQuery(query)
  if (q.length < 1) return []

  return tickers
    .filter((t) => {
      const base = t.apiSymbol.replace(/_USDT$/, '')
      const flat = toFlatSymbol(t.symbol)
      const display = toDisplayName(t.symbol).toUpperCase().replace(/[/:_-]/g, '')
      return base.includes(q) || flat.includes(q) || display.includes(q)
    })
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, limit)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface MexcDealItem {
  p: number
  v: number
  T: number
  t: number
}

interface MexcDealsResponse {
  success: boolean
  code: number
  data: {
    resultList: MexcDealItem[]
  }
}

/**
 * Получить последние сделки (tape/лента) по фьючерсному контракту.
 * Эндпоинт: GET /api/v1/contract/deals/{symbol}
 */
export async function fetchRecentTrades(
  symbol: string,
  limit = 100
): Promise<MexcTrade[]> {
  const apiSymbol = toApiSymbol(symbol)

  const json = await mexcGet<MexcDealsResponse>(
    `/api/v1/contract/deals/${apiSymbol}?limit=${limit}`
  )

  const list = json.data?.resultList ?? []

  return list.map(
    (item): MexcTrade => ({
      timestamp: item.t < 1_000_000_000_000 ? item.t * 1000 : item.t,
      price: Number(item.p),
      volume: Number(item.v),
      side: item.T === 1 ? 'BUY' : 'SELL',
    })
  )
}
