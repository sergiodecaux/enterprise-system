# Whale Watcher — полный снимок контекстных файлов

Дата: 2026-07-21

Ниже — полное содержимое запрошенных файлов без сокращений. Без правок и предложений.

**Примечание по п.4:** файлов useOrderBook.ts / useOrderBookData.ts нет. Загрузка depth — в OrderBookPanel (etchDepth). История imbalance — useOrderBookHistory.ts.

---

## 1. src/engine/types.ts

```typescript
import type {
  DailyBiasDirection,
  DailyAnalysis,
  DailyLevels,
  TrendDirection,
  TradeSide,
} from './smc'
import type { ChartPreferences } from './indicators/types'
import type { SessionSettings } from './sessions/types'
import type { NewsSettings, NewsIntelState } from './sentiment/types'

/** @deprecated Kept for backward-compat imports; unused in SMC path */
export interface IndicatorBucket {
  win_rate: number
  samples: number
  direction: 'LONG' | 'SHORT'
  avg_return: number
}

/** @deprecated */
export interface PairData {
  indicators: Record<string, IndicatorBucket>
  best_signal: {
    key: string
    win_rate: number
    direction: 'LONG' | 'SHORT'
  }
}

/** @deprecated */
export interface SystemCore {
  generated_at: string
  version: string
  pairs: Record<string, PairData>
  meta: {
    total_pairs: number
    timeframe: string
    lookback_days: number
    win_threshold_pct: number
    win_window_candles: number
  }
}

export interface LiveTicker {
  symbol: string // flat BTCUSDT
  price: number
  priceChange24h: number
  volume24h: number
  high24h: number
  low24h: number
  timestamp: number
}

export interface CoinSignal {
  symbol: string // flat BTCUSDT
  internalSymbol: string // BTC/USDT:USDT
  displayName: string // BTC/USDT
  price: number
  priceChange24h: number
  currentRSI: number | null
  /** Probability 0-100 from confluence weights */
  probabilityPct: number
  score: number
  direction: TradeSide | null
  zones: string[]
  sl: number | null
  tp1: number | null
  tp2: number | null
  tpDaily: number | null
  coinTrend: TrendDirection | null
  btcTrend: TrendDirection | null
  dailyBias: string | null
  dailyConfidence: number | null
  dailyPattern: string | null
  isLocked: boolean
  hasActiveSetup: boolean
  /** Legacy shim for old UI that read activeSignal.win_rate */
  activeSignal: IndicatorBucket | null
  activeSignalKey: string | null
  /** Результат анализа дивергенции с BTC (null если не вычислялся) */
  btcDivergence: BtcDivergenceResult | null
}

export interface MarketContext {
  dailyDirection: DailyBiasDirection
  dailyBias: string
  dailyConfidence: number
  dailyPattern: string
  dailyDetails: string
  dailyAnalysis: DailyAnalysis | null
  dailyLevels: DailyLevels | null
  btcTrend: TrendDirection
  emaConfirms: boolean
  lastScanAt: number | null
  watchlistSize: number
  scanProgress: string
}

export interface AppState {
  liveTickets: Record<string, LiveTicker>
  signals: CoinSignal[]
  marketContext: MarketContext | null
  isScanning: boolean
  /** Extra symbols added via search (internal format) */
  extraWatchlist: string[]
  chartPreferences: ChartPreferences
  sessionSettings: SessionSettings
  newsSettings: NewsSettings
  newsIntel: NewsIntelState
  /** Карты ликвидности по символу (internalSymbol → LiquidityMap) */
  liquidityMaps: Record<string, LiquidityMap>

  selectedCoin: string | null
  isDrawerOpen: boolean
  isProUser: boolean
  isConnected: boolean
  connectionStatus: 'ONLINE' | 'POLLING' | 'OFFLINE'
  lastUpdate: number

  updateTicker: (ticker: LiveTicker) => void
  updateSignals: (signals: CoinSignal[]) => void
  upsertSignal: (signal: CoinSignal) => void
  setMarketContext: (ctx: MarketContext | null) => void
  setScanning: (scanning: boolean) => void
  addToWatchlist: (internalSymbol: string) => boolean
  removeFromWatchlist: (internalSymbol: string) => void
  selectCoin: (symbol: string | null) => void
  setDrawerOpen: (open: boolean) => void
  setProUser: (isPro: boolean) => void
  setConnected: (connected: boolean) => void
  setConnectionStatus: (status: 'ONLINE' | 'POLLING' | 'OFFLINE') => void
  setChartPreferences: (prefs: Partial<ChartPreferences>) => void
  setSessionSettings: (settings: Partial<SessionSettings>) => void
  setNewsSettings: (settings: Partial<NewsSettings>) => void
  setNewsIntel: (partial: Partial<NewsIntelState>) => void
  setLiquidityMap: (internalSymbol: string, map: LiquidityMap) => void
}

// ============================================================================
// OrderBook Types
// ============================================================================

export interface OrderBookLevel {
  price: number
  volume: number
  orderCount: number
  total?: number
}

export interface OrderBookSnapshot {
  symbol: string
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  version: number
  timestamp: number
}

export interface OrderBookWall {
  side: 'BID' | 'ASK'
  price: number
  volume: number
  ratio: number
}

export interface OrderBookMetrics {
  imbalance: number
  bidVolume: number
  askVolume: number
  bidOrders: number
  askOrders: number
  walls: OrderBookWall[]
  midPrice: number | null
  spread: number | null
  spreadPercent: number | null
  pressure: 'BUYERS' | 'SELLERS' | 'NEUTRAL'
}

export interface OrderBookState {
  snapshot: OrderBookSnapshot | null
  metrics: OrderBookMetrics | null
  isLoading: boolean
  error: string | null
  lastUpdate: number
}

// ============================================================================
// OrderBook History Types
// ============================================================================

export interface ImbalanceSnapshot {
  timestamp: number
  imbalance: number
  bidVolume: number
  askVolume: number
  pressure: 'BUYERS' | 'SELLERS' | 'NEUTRAL'
  spread: number | null
}

export interface OrderBookHistory {
  imbalanceHistory: ImbalanceSnapshot[]
  maxHistorySize: number
  startTime: number
}

export interface ImbalanceStats {
  current: number
  avg5min: number
  trend: 'RISING' | 'FALLING' | 'STABLE'
  volatility: number
  peakBuyers: number
  peakSellers: number
}

// ============================================================================
// Wall Tracking Types
// ============================================================================

export interface TrackedWall {
  id: string
  side: 'BID' | 'ASK'
  price: number
  initialVolume: number
  currentVolume: number
  firstSeen: number
  lastSeen: number
  isActive: boolean
}

export type WallEventType = 'APPEARED' | 'EATEN' | 'REDUCED' | 'INCREASED'

export interface WallEvent {
  type: WallEventType
  wall: TrackedWall
  timestamp: number
  reduction?: number
}

export interface WallTrackerState {
  walls: Map<string, TrackedWall>
  events: WallEvent[]
  maxEventsHistory: number
}

// ============================================================================
// Heatmap Types
// ============================================================================

export interface PriceLevel {
  price: number
  totalVolume: number
  appearances: number
  firstSeen: number
  lastSeen: number
}

export interface HeatmapState {
  levels: Map<number, PriceLevel>
  maxVolume: number
  priceStep: number
}

// ============================================================================
// BTC Correlation Divergence Types
// ============================================================================

/**
 * Тип дивергенции силы альткоина относительно BTC.
 *
 * BULL_DIV  — BTC падает / стоит, альт растёт или держится:
 *             сила альта выше рынка → буст к LONG
 *
 * BEAR_DIV  — BTC растёт / стоит, альт падает или стоит:
 *             слабость альта хуже рынка → буст к SHORT
 *
 * CORRELATED — движутся синхронно (норма), нет дивергенции
 *
 * NONE       — недостаточно данных
 */
export type DivergenceType = 'BULL_DIV' | 'BEAR_DIV' | 'CORRELATED' | 'NONE'

/** Результат анализа дивергенции силы */
export interface BtcDivergenceResult {
  type: DivergenceType
  /** Изменение BTC за период (%) */
  btcChangePct: number
  /** Изменение альта за тот же период (%) */
  altChangePct: number
  /** Разница силы: altChangePct − btcChangePct */
  relativeStrength: number
  /** Итоговый буст к score: −1.5 .. +1.5 */
  scoreBoost: number
  /** Человекочитаемое описание для UI */
  label: string
  /** Период сравнения в свечах (1H) */
  lookbackCandles: number
}

// ============================================================================
// Liquidity Map Types (Equal Highs / Equal Lows)
// ============================================================================

/** Один кластер равных максимумов или минимумов */
export interface EqualLevel {
  /** Средняя цена кластера */
  price: number
  /** 'HIGH' = равные максимумы (BSL — Buy-Side Liquidity) */
  /** 'LOW'  = равные минимумы (SSL — Sell-Side Liquidity) */
  type: 'HIGH' | 'LOW'
  /** Количество касаний в кластере */
  touches: number
  /** Индексы свечей, входящих в кластер */
  indices: number[]
  /** Сила притяжения: 'WEAK' <3, 'MEDIUM' 3-4, 'STRONG' >=5 */
  strength: 'WEAK' | 'MEDIUM' | 'STRONG'
  /** true если цена ещё не дошла до уровня (нетронутая ликвидность) */
  isActive: boolean
  /** Расстояние от текущей цены в % */
  distancePct: number
}

/** Полная карта ликвидности для одного символа и таймфрейма */
export interface LiquidityMap {
  symbol: string
  timeframe: string
  equalHighs: EqualLevel[]
  equalLows: EqualLevel[]
  /** Ближайший уровень BSL выше текущей цены */
  nearestBSL: EqualLevel | null
  /** Ближайший уровень SSL ниже текущей цены */
  nearestSSL: EqualLevel | null
  /** Суммарный score-буст от ликвидности (0..2) */
  liquidityBoost: number
  computedAt: number
}
```

---

## 2. src/components/tactical/OrderBookPanel.tsx

```tsx
import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertCircle, Brain, Layers3 } from 'lucide-react'
import { fetchDepth } from '../../api/mexc'
import { calculateOrderBookMetrics } from '../../engine/orderbook'
import { createWallTracker, updateWalls } from '../../engine/orderbook/wallTracker'
import {
  createHeatmap,
  updateHeatmap,
  suggestPriceStep,
} from '../../engine/orderbook/heatmap'
import {
  createHeatmap3D,
  addSnapshot3D,
  type Heatmap3DState,
} from '../../engine/orderbook/heatmap3d'
import { useOrderBookHistory } from '../../hooks/useOrderBookHistory'
import { useMLPredictor } from '../../hooks/useMLPredictor'
import type {
  OrderBookState,
  WallTrackerState,
  HeatmapState,
  WallEvent,
} from '../../engine/types'
import OrderBookLevelRow from './OrderBookLevel'
import OrderBookMetricsView from './OrderBookMetrics'
import ImbalanceChart from './ImbalanceChart'
import WallAlert from './WallAlert'
import DepthSettings from './DepthSettings'
import MLPredictionPanel from './MLPredictionPanel'
import { logger } from '../../utils/logger'

const Heatmap3D = lazy(() => import('./Heatmap3D'))

interface Props {
  symbol: string
}

const UPDATE_INTERVAL = 2000

const OrderBookPanel = ({ symbol }: Props) => {
  const { t } = useTranslation()

  const [depthLimit, setDepthLimit] = useState(20)
  const [showML, setShowML] = useState(true)
  const [show3D, setShow3D] = useState(false)

  const [state, setState] = useState<OrderBookState>({
    snapshot: null,
    metrics: null,
    isLoading: true,
    error: null,
    lastUpdate: 0,
  })

  const wallTrackerRef = useRef<WallTrackerState>(createWallTracker())
  const heatmapRef = useRef<HeatmapState>(createHeatmap(0.1))
  const heatmapInitedRef = useRef(false)

  const [wallTracker, setWallTracker] = useState<WallTrackerState>(() =>
    createWallTracker()
  )
  const [heatmap3D, setHeatmap3D] = useState<Heatmap3DState>(() => createHeatmap3D(60))
  const [heatmapTick, setHeatmapTick] = useState(0)
  const [activeAlerts, setActiveAlerts] = useState<WallEvent[]>([])

  const { history, stats, resetHistory } = useOrderBookHistory(state.metrics)

  const { prediction, model, isTraining } = useMLPredictor(
    history,
    stats,
    wallTracker,
    null,
    showML
  )

  const loadDepth = useCallback(async () => {
    try {
      const snapshot = await fetchDepth(symbol, depthLimit)
      const metrics = calculateOrderBookMetrics(snapshot)

      setState({
        snapshot,
        metrics,
        isLoading: false,
        error: null,
        lastUpdate: Date.now(),
      })

      const step = suggestPriceStep(metrics.midPrice)
      if (!heatmapInitedRef.current || heatmapRef.current.priceStep !== step) {
        heatmapRef.current = createHeatmap(step)
        heatmapInitedRef.current = true
      }
      heatmapRef.current = updateHeatmap(heatmapRef.current, snapshot)
      setHeatmapTick((n) => n + 1)

      setHeatmap3D((prev) => addSnapshot3D(prev, snapshot))

      const { tracker, newEvents } = updateWalls(
        wallTrackerRef.current,
        metrics.walls
      )
      wallTrackerRef.current = tracker
      setWallTracker(tracker)

      const eatenEvents = newEvents.filter((e) => e.type === 'EATEN')
      if (eatenEvents.length > 0) {
        setActiveAlerts((current) => [...current, ...eatenEvents].slice(-5))
      }
    } catch (err) {
      logger.warn('[OrderBook] Load error:', err)
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      }))
    }
  }, [symbol, depthLimit])

  useEffect(() => {
    setState({
      snapshot: null,
      metrics: null,
      isLoading: true,
      error: null,
      lastUpdate: 0,
    })
    const freshTracker = createWallTracker()
    wallTrackerRef.current = freshTracker
    setWallTracker(freshTracker)
    heatmapRef.current = createHeatmap(0.1)
    heatmapInitedRef.current = false
    setHeatmap3D(createHeatmap3D(60))
    setActiveAlerts([])
    resetHistory()
  }, [symbol, resetHistory])

  useEffect(() => {
    loadDepth()
    const interval = setInterval(loadDepth, UPDATE_INTERVAL)
    return () => clearInterval(interval)
  }, [loadDepth])

  const handleDismissAlert = (index: number) => {
    setActiveAlerts((current) => current.filter((_, i) => i !== index))
  }

  const { snapshot, metrics, isLoading, error } = state
  const heatmap = heatmapRef.current
  void heatmapTick

  if (isLoading && !snapshot) {
    return (
      <div className="flex items-center justify-center rounded-lg bg-hull-light/20 p-6">
        <Loader2 className="mr-2 h-5 w-5 animate-spin text-holo/60" />
        <span className="text-sm text-holo/60">{t('orderbook_loading')}</span>
      </div>
    )
  }

  if (error && !snapshot) {
    return (
      <div className="flex items-center justify-center rounded-lg bg-hull-light/20 p-6">
        <AlertCircle className="mr-2 h-5 w-5 text-alert" />
        <span className="text-sm text-alert">
          {t('orderbook_error')}: {error}
        </span>
      </div>
    )
  }

  if (!snapshot || !metrics) return null

  const { bids, asks } = snapshot
  const maxVolume = Math.max(
    1,
    ...bids.map((l) => l.volume),
    ...asks.map((l) => l.volume)
  )
  const wallPrices = new Set(metrics.walls.map((w) => w.price))

  const formatMid = (price: number): string => {
    if (price >= 1000) {
      return price.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
    }
    if (price >= 1) {
      return price.toLocaleString('ru-RU', { maximumFractionDigits: 4 })
    }
    return price.toLocaleString('ru-RU', { maximumFractionDigits: 6 })
  }

  return (
    <div className="space-y-3">
      {activeAlerts.length > 0 && (
        <div className="space-y-2">
          {activeAlerts.map((event, i) => (
            <WallAlert
              key={`${event.timestamp}-${event.wall.id}-${i}`}
              event={event}
              onDismiss={() => handleDismissAlert(i)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <h3 className="font-mono text-sm font-bold uppercase text-holo">
          {t('orderbook_title')}
        </h3>
        <div className="flex items-center gap-2">
          <DepthSettings currentDepth={depthLimit} onDepthChange={setDepthLimit} />
          <button
            type="button"
            onClick={() => setShowML((v) => !v)}
            className={`rounded p-1.5 transition-colors ${
              showML ? 'bg-holo/20 text-holo' : 'bg-hull-light/50 text-holo/50'
            }`}
            title={t('ml_prediction')}
          >
            <Brain className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setShow3D((v) => !v)}
            className={`rounded p-1.5 transition-colors ${
              show3D ? 'bg-holo/20 text-holo' : 'bg-hull-light/50 text-holo/50'
            }`}
            title={t('heatmap_3d')}
          >
            <Layers3 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {showML && (
        <MLPredictionPanel
          prediction={prediction}
          model={model}
          isTraining={isTraining}
        />
      )}

      {show3D && (
        <Suspense
          fallback={
            <div className="rounded-lg bg-hull-light/20 p-6 text-center">
              <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin text-holo/50" />
              <span className="text-xs text-holo/50">{t('heatmap_3d')}…</span>
            </div>
          }
        >
          <Heatmap3D heatmap3D={heatmap3D} />
        </Suspense>
      )}

      <ImbalanceChart history={history} stats={stats} />

      <OrderBookMetricsView metrics={metrics} />

      <div className="overflow-hidden rounded-lg bg-hull-light/20">
        <div className="space-y-px">
          {asks
            .slice()
            .reverse()
            .map((level, i) => (
              <OrderBookLevelRow
                key={`ask-${level.price}-${i}`}
                level={level}
                side="ASK"
                maxVolume={maxVolume}
                isWall={wallPrices.has(level.price)}
                heatmap={heatmap}
              />
            ))}
        </div>

        {metrics.midPrice != null && metrics.spread != null && (
          <div className="flex h-8 items-center justify-center border-y border-hull-border/50 bg-hull">
            <span className="font-mono text-xs text-holo/60">
              ${formatMid(metrics.midPrice)} · Δ{formatMid(metrics.spread)}
            </span>
          </div>
        )}

        <div className="space-y-px">
          {bids.map((level, i) => (
            <OrderBookLevelRow
              key={`bid-${level.price}-${i}`}
              level={level}
              side="BID"
              maxVolume={maxVolume}
              isWall={wallPrices.has(level.price)}
              heatmap={heatmap}
            />
          ))}
        </div>
      </div>

      <div className="text-center text-[10px] text-holo/40">
        {t('orderbook_update_hint_heatmap', { seconds: UPDATE_INTERVAL / 1000 })}
      </div>
    </div>
  )
}

export default OrderBookPanel
```

---

## 3. src/engine/orderbook/scoreBooster.ts

```typescript
import type { WallTrackerState } from '../types'
import type { TradeSide } from '../smc'

export interface ScoreBoost {
  boost: number
  reason: string
}

/**
 * Бонус к SMC score на основе недавно съеденных стенок
 */
export function calculateWallBoost(
  wallTracker: WallTrackerState,
  signalDirection: TradeSide | null
): ScoreBoost {
  if (!signalDirection) {
    return { boost: 0, reason: 'Нет сигнала' }
  }

  const now = Date.now()
  const recentWindow = 60_000
  const recentEaten = wallTracker.events.filter(
    (e) => e.type === 'EATEN' && now - e.timestamp < recentWindow
  )

  if (recentEaten.length === 0) {
    return { boost: 0, reason: 'Нет съеденных стенок' }
  }

  let boost = 0
  let reason = ''

  for (const event of recentEaten) {
    const { wall, reduction } = event
    const intensity = reduction != null ? Math.min(reduction / 100, 1) : 0.5

    if (signalDirection === 'LONG' && wall.side === 'ASK') {
      boost += 1 * intensity
      reason = `ASK стенка съедена на ${wall.price.toFixed(2)} (-${reduction?.toFixed(0) ?? 0}%)`
    } else if (signalDirection === 'SHORT' && wall.side === 'BID') {
      boost += 1 * intensity
      reason = `BID стенка съедена на ${wall.price.toFixed(2)} (-${reduction?.toFixed(0) ?? 0}%)`
    } else {
      boost -= 0.5 * intensity
      reason = 'Стенка против направления сигнала'
    }
  }

  boost = Math.max(-1, Math.min(boost, 2))
  return { boost, reason }
}
```

---

## 4. src/hooks/useOrderBookHistory.ts (существует; useOrderBook.ts / useOrderBookData.ts отсутствуют — стакан грузит OrderBookPanel через fetchDepth)

```typescript
import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  OrderBookMetrics,
  OrderBookHistory,
  ImbalanceStats,
} from '../engine/types'
import {
  createHistory,
  addSnapshot,
  calculateImbalanceStats,
} from '../engine/orderbook/history'

export function useOrderBookHistory(metrics: OrderBookMetrics | null) {
  const [history, setHistory] = useState<OrderBookHistory>(createHistory)
  const [stats, setStats] = useState<ImbalanceStats | null>(null)
  const lastMetricsRef = useRef<OrderBookMetrics | null>(null)

  useEffect(() => {
    if (!metrics) return

    if (
      lastMetricsRef.current &&
      lastMetricsRef.current.imbalance === metrics.imbalance &&
      lastMetricsRef.current.bidVolume === metrics.bidVolume &&
      lastMetricsRef.current.askVolume === metrics.askVolume
    ) {
      return
    }

    lastMetricsRef.current = metrics

    setHistory((prev) => {
      const updated = addSnapshot(prev, metrics)
      setStats(calculateImbalanceStats(updated))
      return updated
    })
  }, [metrics])

  const resetHistory = useCallback(() => {
    lastMetricsRef.current = null
    setHistory(createHistory())
    setStats(null)
  }, [])

  return { history, stats, resetHistory }
}
```

---

## 5. src/api/mexc/index.ts (полный файл — включает fetchDepth)

```typescript
import type { OrderBookLevel, OrderBookSnapshot } from '../../engine/types'

/** Candle in ccxt-compatible format: [timestamp_ms, open, high, low, close, volume] */
export type OhlcvCandle = [number, number, number, number, number, number]

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
    return envUrl.replace(/\/$/, '')
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
```

---

## 6. src/store/useAppStore.ts

```typescript
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type {
  AppState,
  LiveTicker,
  CoinSignal,
  LiquidityMap,
  MarketContext,
} from '../engine/types'
import type { ChartPreferences } from '../engine/indicators/types'
import { DEFAULT_CHART_PREFERENCES } from '../engine/indicators/types'
import type { SessionSettings } from '../engine/sessions/types'
import { DEFAULT_SESSION_SETTINGS } from '../engine/sessions/types'
import type { NewsSettings } from '../engine/sentiment/types'
import {
  DEFAULT_NEWS_SETTINGS,
  EMPTY_NEWS_INTEL,
} from '../engine/sentiment/types'
import { CORE_WATCHLIST } from '../api/mexc'

const defaultMarketContext: MarketContext = {
  dailyDirection: 'BOTH',
  dailyBias: 'NEUTRAL',
  dailyConfidence: 0,
  dailyPattern: '',
  dailyDetails: '',
  dailyAnalysis: null,
  dailyLevels: null,
  btcTrend: 'RANGING',
  emaConfirms: false,
  lastScanAt: null,
  watchlistSize: CORE_WATCHLIST.length,
  scanProgress: '',
}

const EXTRA_KEY = 'enterprise_extra_watchlist'
const CHART_PREFS_KEY = 'enterprise_chart_preferences'
const SESSION_SETTINGS_KEY = 'enterprise_session_settings'
const NEWS_SETTINGS_KEY = 'enterprise_news_settings'

function loadExtraWatchlist(): string[] {
  try {
    const raw = localStorage.getItem(EXTRA_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as string[]
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : []
  } catch {
    return []
  }
}

function saveExtraWatchlist(list: string[]) {
  try {
    localStorage.setItem(EXTRA_KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

function loadChartPreferences(): ChartPreferences {
  try {
    const raw = localStorage.getItem(CHART_PREFS_KEY)
    if (!raw) return DEFAULT_CHART_PREFERENCES
    const parsed = JSON.parse(raw) as Partial<ChartPreferences>
    return {
      ...DEFAULT_CHART_PREFERENCES,
      ...parsed,
      indicators: {
        ...DEFAULT_CHART_PREFERENCES.indicators,
        ...(parsed.indicators ?? {}),
      },
      zones: {
        ...DEFAULT_CHART_PREFERENCES.zones,
        ...(parsed.zones ?? {}),
      },
    }
  } catch {
    return DEFAULT_CHART_PREFERENCES
  }
}

function loadSessionSettings(): SessionSettings {
  try {
    const saved = localStorage.getItem(SESSION_SETTINGS_KEY)
    return saved
      ? { ...DEFAULT_SESSION_SETTINGS, ...JSON.parse(saved) }
      : DEFAULT_SESSION_SETTINGS
  } catch {
    return DEFAULT_SESSION_SETTINGS
  }
}

function loadNewsSettings(): NewsSettings {
  try {
    const saved = localStorage.getItem(NEWS_SETTINGS_KEY)
    return saved
      ? { ...DEFAULT_NEWS_SETTINGS, ...JSON.parse(saved) }
      : DEFAULT_NEWS_SETTINGS
  } catch {
    return DEFAULT_NEWS_SETTINGS
  }
}

export const useAppStore = create<AppState>()(
  subscribeWithSelector((set, get) => ({
    liveTickets: {},
    signals: [],
    marketContext: defaultMarketContext,
    isScanning: false,
    extraWatchlist: loadExtraWatchlist(),
    chartPreferences: loadChartPreferences(),
    sessionSettings: loadSessionSettings(),
    newsSettings: loadNewsSettings(),
    newsIntel: EMPTY_NEWS_INTEL,
    liquidityMaps: {},

    selectedCoin: null,
    isDrawerOpen: false,
    isProUser: true,
    isConnected: false,
    connectionStatus: 'OFFLINE',
    lastUpdate: Date.now(),

    updateTicker: (ticker: LiveTicker) => {
      set((state) => ({
        liveTickets: {
          ...state.liveTickets,
          [ticker.symbol]: ticker,
        },
        lastUpdate: Date.now(),
      }))
    },

    updateSignals: (signals: CoinSignal[]) => {
      set({ signals, lastUpdate: Date.now() })
    },

    upsertSignal: (signal: CoinSignal) => {
      set((state) => {
        const idx = state.signals.findIndex((s) => s.symbol === signal.symbol)
        const next =
          idx >= 0
            ? state.signals.map((s, i) => (i === idx ? signal : s))
            : [signal, ...state.signals]
        next.sort((a, b) => {
          if (a.hasActiveSetup !== b.hasActiveSetup) return a.hasActiveSetup ? -1 : 1
          return b.probabilityPct - a.probabilityPct
        })
        return { signals: next, lastUpdate: Date.now() }
      })
    },

    setMarketContext: (ctx: MarketContext | null) => {
      set({ marketContext: ctx })
    },

    setScanning: (scanning: boolean) => {
      set({ isScanning: scanning })
    },

    addToWatchlist: (internalSymbol: string) => {
      const core = new Set<string>(CORE_WATCHLIST)
      if (core.has(internalSymbol)) return false
      const current = get().extraWatchlist
      if (current.includes(internalSymbol)) return false
      const next = [...current, internalSymbol]
      saveExtraWatchlist(next)
      set({ extraWatchlist: next })
      return true
    },

    removeFromWatchlist: (internalSymbol: string) => {
      const next = get().extraWatchlist.filter((s) => s !== internalSymbol)
      saveExtraWatchlist(next)
      set({
        extraWatchlist: next,
        signals: get().signals.filter((s) => s.internalSymbol !== internalSymbol),
      })
    },

    selectCoin: (symbol: string | null) => {
      set({ selectedCoin: symbol })
    },

    setDrawerOpen: (open: boolean) => {
      set({ isDrawerOpen: open })
    },

    setProUser: (isPro: boolean) => {
      set({ isProUser: isPro })
    },

    setConnected: (connected: boolean) => {
      set({ isConnected: connected })
    },

    setConnectionStatus: (status: 'ONLINE' | 'POLLING' | 'OFFLINE') => {
      set({ connectionStatus: status, isConnected: status !== 'OFFLINE' })
    },

    setChartPreferences: (prefs) =>
      set((state) => ({
        chartPreferences: {
          ...state.chartPreferences,
          ...prefs,
          indicators: {
            ...state.chartPreferences.indicators,
            ...(prefs.indicators ?? {}),
          },
          zones: {
            ...state.chartPreferences.zones,
            ...(prefs.zones ?? {}),
          },
        },
      })),

    setSessionSettings: (partial) =>
      set((state) => {
        const next = { ...state.sessionSettings, ...partial }
        try {
          localStorage.setItem(SESSION_SETTINGS_KEY, JSON.stringify(next))
        } catch {
          /* ignore */
        }
        return { sessionSettings: next }
      }),

    setNewsSettings: (partial) =>
      set((state) => {
        const next = { ...state.newsSettings, ...partial }
        try {
          localStorage.setItem(NEWS_SETTINGS_KEY, JSON.stringify(next))
        } catch {
          /* ignore */
        }
        return { newsSettings: next }
      }),

    setNewsIntel: (partial) =>
      set((state) => ({
        newsIntel: { ...state.newsIntel, ...partial },
      })),

    setLiquidityMap: (internalSymbol: string, map: LiquidityMap) =>
      set((state) => ({
        liquidityMaps: { ...state.liquidityMaps, [internalSymbol]: map },
      })),
  }))
)

useAppStore.subscribe(
  (state) => state.chartPreferences,
  (prefs) => {
    try {
      localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(prefs))
    } catch {
      /* ignore */
    }
  }
)
```

---

## 7. src/components/tactical/TacticalDrawer.tsx

```tsx
import { useEffect, useRef } from 'react'
import { Magnet, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import ProbabilityGauge from './ProbabilityGauge'
import LiveChart from './LiveChart'
import OrderBookPanel from './OrderBookPanel'
import DataLog from './DataLog'
import NewsPanel from '../news/NewsPanel'
import FearGreedGauge from '../news/FearGreedGauge'
import type {
  BtcDivergenceResult,
  CoinSignal,
  EqualLevel,
  LiquidityMap,
} from '../../engine/types'

/** Панель дивергенции силы альта vs BTC */
const BtcDivergencePanel = ({
  divergence,
}: {
  divergence: BtcDivergenceResult
}) => {
  if (divergence.type === 'NONE' || !divergence.label) return null

  const isBull = divergence.type === 'BULL_DIV'
  const isBear = divergence.type === 'BEAR_DIV'
  const isCorr = divergence.type === 'CORRELATED'

  const borderColor = isBull
    ? 'border-matrix/30'
    : isBear
      ? 'border-alert/30'
      : 'border-hull-border'

  const bgColor = isBull ? 'bg-matrix/5' : isBear ? 'bg-alert/5' : 'bg-hull'

  const textColor = isBull
    ? 'text-matrix'
    : isBear
      ? 'text-alert'
      : 'text-holo/40'

  const icon = isBull ? '⚡' : isBear ? '🔻' : '≈'

  return (
    <div className={`rounded-xl border ${borderColor} ${bgColor} p-3`}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm">{icon}</span>
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          Корреляция с BTC
        </span>
        {divergence.scoreBoost > 0 && !isCorr && (
          <span
            className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
              isBull ? 'bg-matrix/20 text-matrix' : 'bg-alert/20 text-alert'
            }`}
          >
            +{divergence.scoreBoost.toFixed(1)} score
          </span>
        )}
      </div>

      <p
        className={`mb-2 font-mono text-xs font-medium leading-relaxed ${textColor}`}
      >
        {divergence.label}
      </p>

      <div className="grid grid-cols-3 gap-2 rounded-lg bg-black/20 p-2">
        <div className="text-center">
          <div className="mb-0.5 font-mono text-[10px] uppercase text-holo/30">
            BTC {divergence.lookbackCandles}H
          </div>
          <div
            className={`font-mono text-sm font-bold ${
              divergence.btcChangePct >= 0 ? 'text-matrix' : 'text-alert'
            }`}
          >
            {divergence.btcChangePct >= 0 ? '+' : ''}
            {divergence.btcChangePct.toFixed(2)}%
          </div>
        </div>

        <div className="flex items-center justify-center">
          <span className="font-mono text-xs text-holo/20">vs</span>
        </div>

        <div className="text-center">
          <div className="mb-0.5 font-mono text-[10px] uppercase text-holo/30">
            Альт {divergence.lookbackCandles}H
          </div>
          <div
            className={`font-mono text-sm font-bold ${
              divergence.altChangePct >= 0 ? 'text-matrix' : 'text-alert'
            }`}
          >
            {divergence.altChangePct >= 0 ? '+' : ''}
            {divergence.altChangePct.toFixed(2)}%
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="font-mono text-[10px] text-holo/30">Сила альта:</span>
        <span
          className={`font-mono text-xs font-bold ${
            divergence.relativeStrength > 0 ? 'text-matrix' : 'text-alert'
          }`}
        >
          {divergence.relativeStrength > 0 ? '+' : ''}
          {divergence.relativeStrength.toFixed(2)}%
        </span>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-hull-border">
          <div
            className={`h-full rounded-full transition-all ${
              divergence.relativeStrength > 0 ? 'bg-matrix' : 'bg-alert'
            }`}
            style={{
              width: `${Math.min(
                (Math.abs(divergence.relativeStrength) / 10) * 100,
                100
              )}%`,
              marginLeft: divergence.relativeStrength < 0 ? 'auto' : '0',
            }}
          />
        </div>
      </div>
    </div>
  )
}

/** Панель "Магниты ликвидности" в Drawer */
const LiquidityMagnetPanel = ({ map }: { map: LiquidityMap }) => {
  const hasLevels = map.equalHighs.length > 0 || map.equalLows.length > 0

  if (!hasLevels) return null

  const strengthIcon = (s: string) =>
    s === 'STRONG' ? '🔴' : s === 'MEDIUM' ? '🟡' : '⚪'

  const renderLevel = (level: EqualLevel, color: string) => (
    <div
      key={`${level.type}-${level.price}`}
      className="flex items-center justify-between rounded-md border px-2 py-1.5"
      style={{ borderColor: color + '40', backgroundColor: color + '10' }}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs">{strengthIcon(level.strength)}</span>
        <span className="font-mono text-xs font-bold" style={{ color }}>
          {level.type === 'HIGH' ? 'BSL' : 'SSL'}
        </span>
        <span className="font-mono text-xs text-holo/60">
          ×{level.touches} касаний
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-holo/80">
          {level.price.toLocaleString('ru-RU', { maximumFractionDigits: 4 })}
        </span>
        <span
          className="font-mono text-[10px]"
          style={{
            color: level.isActive ? color : 'rgba(100,100,100,0.6)',
          }}
        >
          {level.distancePct.toFixed(1)}%
          {level.isActive ? ' 🧲' : ' ✓'}
        </span>
      </div>
    </div>
  )

  return (
    <div className="rounded-xl border border-hull-border bg-hull p-3">
      <div className="mb-2 flex items-center gap-2">
        <Magnet className="h-4 w-4 text-yellow-400" />
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          Магниты ликвидности
        </span>
        {map.liquidityBoost > 0 && (
          <span className="ml-auto rounded bg-yellow-400/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-yellow-400">
            +{map.liquidityBoost.toFixed(1)} score
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        {map.equalHighs
          .slice(0, 3)
          .map((l) => renderLevel(l, 'rgb(251, 191, 36)'))}
        {map.equalLows
          .slice(0, 3)
          .map((l) => renderLevel(l, 'rgb(168, 85, 247)'))}
      </div>

      {map.nearestBSL && (
        <p className="mt-2 font-mono text-[10px] text-holo/30">
          Ближайший BSL: {map.nearestBSL.distancePct.toFixed(2)}% выше
          {map.nearestSSL
            ? ` · SSL: ${map.nearestSSL.distancePct.toFixed(2)}% ниже`
            : ''}
        </p>
      )}
    </div>
  )
}

const TacticalDrawer = () => {
  const { t } = useTranslation()
  const { haptic } = useTelegramWebApp()
  const selectedCoin = useAppStore((state) => state.selectedCoin)
  const isDrawerOpen = useAppStore((state) => state.isDrawerOpen)
  const signals = useAppStore((state) => state.signals)
  const setDrawerOpen = useAppStore((state) => state.setDrawerOpen)
  const selectCoin = useAppStore((state) => state.selectCoin)
  const newsSettings = useAppStore((state) => state.newsSettings)
  const newsIntel = useAppStore((state) => state.newsIntel)
  const liquidityMaps = useAppStore((state) => state.liquidityMaps)

  const drawerRef = useRef<HTMLDivElement>(null)

  const signal: CoinSignal | null = selectedCoin
    ? signals.find((s) => s.symbol === selectedCoin) ?? null
    : null

  const liquidityMap = signal
    ? liquidityMaps[signal.internalSymbol] ?? null
    : null
  const btcDivergence = signal?.btcDivergence ?? null

  useEffect(() => {
    if (isDrawerOpen && signal) {
      haptic.impact()
    }
  }, [isDrawerOpen, signal, haptic])

  const handleClose = () => {
    setDrawerOpen(false)
    selectCoin(null)
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose()
    }
  }

  if (!signal) return null

  const probability = signal.probabilityPct
  const direction = signal.direction
  const currentRSI = signal.currentRSI ?? 0

  const formatPrice = (price: number): string => {
    if (price >= 1000) {
      return price.toLocaleString('ru-RU', {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      })
    }
    if (price >= 1) {
      return price.toLocaleString('ru-RU', {
        maximumFractionDigits: 4,
        minimumFractionDigits: 2,
      })
    }
    return price.toLocaleString('ru-RU', {
      maximumFractionDigits: 6,
      minimumFractionDigits: 2,
    })
  }

  const formatChange = (change: number): string => {
    const sign = change >= 0 ? '+' : ''
    return `${sign}${change.toFixed(2)}%`
  }

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/60 backdrop-blur-sm z-40 transition-opacity duration-300 ${
          isDrawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={handleBackdropClick}
      />

      <div
        ref={drawerRef}
        className={`fixed bottom-0 left-0 right-0 w-full max-h-[85vh] bg-space border-t border-hull-border rounded-t-2xl overflow-y-auto z-50 transition-transform duration-400 ease-out ${
          isDrawerOpen
            ? 'translate-y-0 opacity-100'
            : 'translate-y-full opacity-0 pointer-events-none'
        }`}
        style={{
          transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div className="flex justify-center my-3">
          <div className="w-12 h-1 bg-hull-border rounded-full" />
        </div>

        <div className="px-4 pb-4 border-b border-hull-border/50">
          <div className="flex items-start justify-between mb-2">
            <div className="flex-1">
              <h2 className="text-2xl font-mono font-bold text-holo mb-1">
                {signal.displayName}
              </h2>
              <div className="flex items-center gap-3 text-sm font-mono">
                <span className="text-holo/80">${formatPrice(signal.price)}</span>
                <span
                  className={signal.priceChange24h >= 0 ? 'text-matrix' : 'text-alert'}
                >
                  {formatChange(signal.priceChange24h)}
                </span>
                {signal.hasActiveSetup && (
                  <span className="text-matrix text-xs uppercase">{t('signal_setup')}</span>
                )}
              </div>
            </div>
            <button
              onClick={handleClose}
              className="p-2 hover:bg-hull-light rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-holo/60" />
            </button>
          </div>
        </div>

        <div className="space-y-6 px-4 py-6">
          <div className="flex justify-center">
            <ProbabilityGauge value={probability} direction={direction} />
          </div>

          {newsSettings.enabled && newsSettings.showInDrawer && (
            <div className="space-y-3">
              {newsSettings.showFearGreed && newsIntel.fearGreed && (
                <FearGreedGauge data={newsIntel.fearGreed} />
              )}
              <NewsPanel
                coinSentiment={
                  newsIntel.coinSentiments[signal.displayName.split('/')[0]] ??
                  null
                }
                symbol={signal.displayName.split('/')[0]}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-hull border border-hull-border rounded-lg p-3">
              <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                {t('tactical_rsi')}
              </div>
              <div className="text-lg font-mono font-bold text-holo">
                {signal.currentRSI !== null ? currentRSI.toFixed(1) : '--'}
              </div>
            </div>

            <div className="bg-hull border border-hull-border rounded-lg p-3">
              <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                {t('tactical_direction')}
              </div>
              <div className="text-lg font-mono font-bold text-holo">
                {direction || '--'}
              </div>
            </div>

            <div className="bg-hull border border-hull-border rounded-lg p-3">
              <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                {t('tactical_score')}
              </div>
              <div className="text-lg font-mono font-bold text-holo">
                {signal.score}/10
              </div>
            </div>

            <div className="bg-hull border border-hull-border rounded-lg p-3">
              <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                {t('tactical_trend')}
              </div>
              <div className="text-lg font-mono font-bold text-holo">
                {signal.coinTrend === 'BULLISH'
                  ? t('trend_bullish')
                  : signal.coinTrend === 'BEARISH'
                    ? t('trend_bearish')
                    : signal.coinTrend === 'RANGING'
                      ? t('trend_ranging')
                      : '--'}
              </div>
            </div>

            {signal.sl != null && (
              <div className="bg-hull border border-hull-border rounded-lg p-3">
                <div className="text-xs text-holo/40 font-mono uppercase mb-1">SL</div>
                <div className="text-lg font-mono font-bold text-alert">
                  {formatPrice(signal.sl)}
                </div>
              </div>
            )}

            {signal.tp1 != null && (
              <div className="bg-hull border border-hull-border rounded-lg p-3">
                <div className="text-xs text-holo/40 font-mono uppercase mb-1">TP1</div>
                <div className="text-lg font-mono font-bold text-matrix">
                  {formatPrice(signal.tp1)}
                </div>
              </div>
            )}

            {signal.tp2 != null && (
              <div className="bg-hull border border-hull-border rounded-lg p-3">
                <div className="text-xs text-holo/40 font-mono uppercase mb-1">TP2</div>
                <div className="text-lg font-mono font-bold text-matrix">
                  {formatPrice(signal.tp2)}
                </div>
              </div>
            )}

            {signal.dailyBias && (
              <div className="bg-hull border border-hull-border rounded-lg p-3">
                <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                  {t('tactical_daily_bias')}
                </div>
                <div className="text-sm font-mono font-bold text-holo">
                  {signal.dailyBias === 'BULLISH'
                    ? t('bias_bullish')
                    : signal.dailyBias === 'BEARISH'
                      ? t('bias_bearish')
                      : t('bias_neutral')}{' '}
                  {signal.dailyConfidence ?? ''}%
                </div>
              </div>
            )}
          </div>

          {liquidityMap && <LiquidityMagnetPanel map={liquidityMap} />}
          {btcDivergence && (
            <BtcDivergencePanel divergence={btcDivergence} />
          )}

          <LiveChart
            symbol={signal.internalSymbol}
            flatSymbol={signal.symbol}
            signal={signal}
          />

          <OrderBookPanel symbol={signal.internalSymbol} />

          <DataLog signal={signal} />
        </div>
      </div>
    </>
  )
}

export default TacticalDrawer
```

---

## 8. src/components/radar/CoinRow.tsx

```tsx
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CoinSignal } from '../../engine/types'
import { useAppStore } from '../../store/useAppStore'
import WinRateBar from './WinRateBar'
import SentimentBadge from './SentimentBadge'

interface CoinRowProps {
  signal: CoinSignal
  rank: number
  onClick: () => void
}

const CoinRow = ({ signal, rank, onClick }: CoinRowProps) => {
  const { t } = useTranslation()
  const newsSettings = useAppStore((s) => s.newsSettings)
  const coinSentiments = useAppStore((s) => s.newsIntel.coinSentiments)
  const liqMap = useAppStore(
    (s) => s.liquidityMaps[signal.internalSymbol] ?? null
  )
  const baseSym = signal.internalSymbol.split('/')[0]
  const sentiment =
    newsSettings.enabled && newsSettings.showSentimentBadge
      ? coinSentiments[baseSym] ?? null
      : null

  const formatPrice = (price: number): string => {
    if (price >= 1000) {
      return price.toLocaleString('ru-RU', {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      })
    }
    if (price >= 1) {
      return price.toLocaleString('ru-RU', {
        maximumFractionDigits: 4,
        minimumFractionDigits: 2,
      })
    }
    return price.toLocaleString('ru-RU', {
      maximumFractionDigits: 6,
      minimumFractionDigits: 2,
    })
  }

  const formatChange = (change: number): string => {
    const sign = change >= 0 ? '+' : ''
    return `${sign}${change.toFixed(2)}%`
  }

  const getSignalBadgeClass = () => {
    if (!signal.direction) {
      return 'border-hull-border bg-hull-light text-holo/40'
    }
    if (signal.direction === 'LONG') {
      return 'border-matrix/30 bg-matrix/10 text-matrix'
    }
    return 'border-alert/30 bg-alert/10 text-alert'
  }

  const getSignalText = (): string => {
    if (!signal.direction) {
      return signal.currentRSI === null ? t('signal_waiting') : t('signal_neutral')
    }
    const prefix = signal.hasActiveSetup ? '⚡' : ''
    return `${prefix}${signal.direction === 'LONG' ? t('signal_long') : t('signal_short')}`
  }

  return (
    <div
      className="flex cursor-pointer items-center gap-3 border-b border-hull-border/50 px-4 py-3 transition-colors duration-200 hover:bg-hull-light/50"
      onClick={onClick}
    >
      <div className="w-6 text-right font-mono text-xs text-holo/30">
        {String(rank).padStart(2, '0')}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <div className="truncate font-mono text-sm font-bold text-holo">
            {signal.displayName}
          </div>
          <SentimentBadge sentiment={sentiment} />
        </div>
        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="text-holo/60">${formatPrice(signal.price)}</span>
          <span
            className={signal.priceChange24h >= 0 ? 'text-matrix' : 'text-alert'}
          >
            {formatChange(signal.priceChange24h)}
          </span>
        </div>
      </div>

      <div
        className={`rounded border px-2 py-0.5 font-mono text-xs uppercase ${getSignalBadgeClass()}`}
      >
        {getSignalText()}
      </div>

      <div className="flex items-center gap-1">
        <WinRateBar value={signal.probabilityPct} />
        {liqMap && liqMap.liquidityBoost > 0.5 && (
          <span
            className="inline-flex items-center rounded px-1 font-mono text-[9px] font-bold text-yellow-400"
            title={`Магнит ликвидности: +${liqMap.liquidityBoost.toFixed(1)}`}
          >
            🧲
          </span>
        )}
        {signal.btcDivergence?.type === 'BULL_DIV' && (
          <span
            className="inline-flex items-center rounded px-1 font-mono text-[9px] font-bold text-matrix"
            title={signal.btcDivergence.label}
          >
            ⚡
          </span>
        )}
        {signal.btcDivergence?.type === 'BEAR_DIV' && (
          <span
            className="inline-flex items-center rounded px-1 font-mono text-[9px] font-bold text-alert"
            title={signal.btcDivergence.label}
          >
            🔻
          </span>
        )}
      </div>

      <div className="flex-shrink-0">
        <ChevronRight className="h-4 w-4 text-holo/20" />
      </div>
    </div>
  )
}

export default CoinRow
```

---

