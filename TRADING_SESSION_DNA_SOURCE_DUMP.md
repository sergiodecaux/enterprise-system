# Trading Session DNA Source Dump

Ниже приведены полные актуальные содержимые запрошенных файлов без правок.

## 1. `src/engine/sessions/sessionMap.ts`

```ts
import type { SessionDefinition, SessionName } from './types'

export const SESSION_DEFINITIONS: Record<SessionName, SessionDefinition> = {
  ASIA: {
    name: 'ASIA',
    label: 'Азия',
    startHour: 0,
    endHour: 9,
    color: 'rgba(99, 102, 241, 0.16)',
    lineColor: 'rgba(99, 102, 241, 0.55)',
    textColor: 'rgba(165, 180, 252, 1)',
  },
  LONDON: {
    name: 'LONDON',
    label: 'Лондон',
    startHour: 7,
    endHour: 16,
    color: 'rgba(245, 158, 11, 0.16)',
    lineColor: 'rgba(245, 158, 11, 0.55)',
    textColor: 'rgba(252, 211, 77, 1)',
  },
  NEW_YORK: {
    name: 'NEW_YORK',
    label: 'Нью-Йорк',
    startHour: 13,
    endHour: 22,
    color: 'rgba(34, 197, 94, 0.16)',
    lineColor: 'rgba(34, 197, 94, 0.55)',
    textColor: 'rgba(134, 239, 172, 1)',
  },
  OVERLAP: {
    name: 'OVERLAP',
    label: 'Лондон + NY',
    startHour: 13,
    endHour: 16,
    color: 'rgba(239, 68, 68, 0.20)',
    lineColor: 'rgba(239, 68, 68, 0.70)',
    textColor: 'rgba(254, 202, 202, 1)',
  },
  CLOSED: {
    name: 'CLOSED',
    label: 'Закрыто',
    startHour: 22,
    endHour: 24,
    color: 'rgba(100, 100, 100, 0.10)',
    lineColor: 'rgba(100, 100, 100, 0.30)',
    textColor: 'rgba(148, 163, 184, 0.9)',
  },
}

export function getSessionAtHour(utcHour: number): SessionName {
  if (utcHour >= 13 && utcHour < 16) return 'OVERLAP'
  if (utcHour >= 7 && utcHour < 13) return 'LONDON'
  if (utcHour >= 16 && utcHour < 22) return 'NEW_YORK'
  if (utcHour >= 0 && utcHour < 7) return 'ASIA'
  return 'CLOSED'
}

/** Непересекающиеся сегменты дня (UTC midnight) для отрисовки */
export function getSessionSegmentsForDay(
  dayStartTs: number
): Array<{ name: SessionName; startTs: number; endTs: number }> {
  const h = (hours: number) => dayStartTs + hours * 3600

  // Без наложений: иначе цвета смешиваются и сессии неразличимы
  return [
    { name: 'ASIA', startTs: h(0), endTs: h(7) },
    { name: 'LONDON', startTs: h(7), endTs: h(13) },
    { name: 'OVERLAP', startTs: h(13), endTs: h(16) },
    { name: 'NEW_YORK', startTs: h(16), endTs: h(22) },
    { name: 'CLOSED', startTs: h(22), endTs: h(24) },
  ]
}
```

## 2. `src/engine/sessions/types.ts`

```ts
export type SessionName =
  | 'ASIA'
  | 'LONDON'
  | 'NEW_YORK'
  | 'OVERLAP'
  | 'CLOSED'

export interface SessionDefinition {
  name: SessionName
  label: string
  startHour: number
  endHour: number
  color: string
  lineColor: string
  textColor: string
}

export interface SessionSegment {
  session: SessionName
  label: string
  startTs: number
  endTs: number
  color: string
  lineColor: string
  textColor: string
  isOverlap: boolean
}

export type NewsImportance = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface NewsEvent {
  id: string
  name: string
  fullName: string
  timestamp: number
  importance: NewsImportance
  currency: string
  actual?: string
  forecast?: string
  previous?: string
}

export interface WeekendSegment {
  startTs: number
  endTs: number
  label: string
}

export interface SessionSettings {
  enabled: boolean
  showAsia: boolean
  showLondon: boolean
  showNewYork: boolean
  showOverlap: boolean
  showWeekends: boolean
  showNews: boolean
  showSessionLines: boolean
  opacity: number
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  enabled: true,
  showAsia: true,
  showLondon: true,
  showNewYork: true,
  showOverlap: true,
  showWeekends: true,
  showNews: true,
  showSessionLines: true,
  opacity: 100,
}
```

## 3. `src/components/tactical/SessionOverlay.tsx`

```tsx
import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type {
  SessionSegment,
  WeekendSegment,
  NewsEvent,
  SessionSettings,
} from '../../engine/sessions/types'
import { SESSION_DEFINITIONS, getSessionAtHour } from '../../engine/sessions/sessionMap'
import { getNewsColor } from '../../engine/sessions/newsCalendar'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  sessions: SessionSegment[]
  weekends: WeekendSegment[]
  news: NewsEvent[]
  settings: SessionSettings
  timeframe: string
}

const SHOW_SESSIONS_ON = new Set(['1m', '5m', '15m', '1h'])
const RIBBON_H = 18

function solidFromRgba(rgba: string, alpha = 0.92): string {
  const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!m) return rgba
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`
}

const SessionOverlay = ({
  chart,
  series,
  containerRef,
  sessions,
  weekends,
  news,
  settings,
  timeframe,
}: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || !chart || !series) return

    const draw = () => {
      const W = container.clientWidth
      const H = container.clientHeight
      if (W <= 0 || H <= 0) return

      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)

      if (!SHOW_SESSIONS_ON.has(timeframe) || !settings.enabled) return

      const timeScale = chart.timeScale()
      const tsToX = (ts: number): number | null => {
        const coord = timeScale.timeToCoordinate(ts as Time)
        return coord !== null && coord !== undefined ? (coord as number) : null
      }

      const nowTs = Math.floor(Date.now() / 1000)
      const nowSession = getSessionAtHour(new Date().getUTCHours())
      const nowDef = SESSION_DEFINITIONS[nowSession]
      const opFactor = Math.max(0.55, settings.opacity / 100)

      weekends.forEach((wknd) => {
        const x1 = tsToX(wknd.startTs)
        const x2 = tsToX(wknd.endTs)
        if (x1 === null && x2 === null) return

        const left = x1 ?? 0
        const right = x2 ?? W
        if (right <= 0 || left >= W) return

        const rectLeft = Math.max(0, left)
        const rectRight = Math.min(W, right)
        const rectW = rectRight - rectLeft
        if (rectW <= 0) return

        ctx.save()
        ctx.beginPath()
        ctx.rect(rectLeft, 0, rectW, H)
        ctx.clip()

        ctx.fillStyle = `rgba(30, 30, 40, ${0.18 * opFactor})`
        ctx.fillRect(rectLeft, 0, rectW, H)

        ctx.strokeStyle = `rgba(80, 80, 100, ${0.18 * opFactor})`
        ctx.lineWidth = 1
        const step = 12
        for (let x = rectLeft - H; x < rectRight + H; x += step) {
          ctx.beginPath()
          ctx.moveTo(x, 0)
          ctx.lineTo(x + H, H)
          ctx.stroke()
        }
        ctx.restore()

        ctx.fillStyle = 'rgba(71, 85, 105, 0.85)'
        ctx.fillRect(rectLeft, 0, rectW, RIBBON_H)
        if (rectW > 36) {
          ctx.font = 'bold 10px monospace'
          ctx.fillStyle = 'rgba(226, 232, 240, 0.95)'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(wknd.label, rectLeft + rectW / 2, RIBBON_H / 2)
          ctx.textBaseline = 'alphabetic'
        }
      })

      sessions.forEach((seg) => {
        const x1 = tsToX(seg.startTs)
        const x2 = tsToX(seg.endTs)
        if (x1 === null && x2 === null) return

        const left = x1 ?? 0
        const right = x2 ?? W
        if (right <= 0 || left >= W) return

        const rectLeft = Math.max(0, left)
        const rectRight = Math.min(W, right)
        const rectW = rectRight - rectLeft
        if (rectW <= 1) return

        const isCurrent =
          nowTs >= seg.startTs && nowTs < seg.endTs && seg.session === nowSession

        // Фон сессии
        ctx.fillStyle = seg.color
        ctx.fillRect(rectLeft, RIBBON_H, rectW, H - RIBBON_H)

        // Цветная лента сверху — главный визуальный якорь
        const ribbon = solidFromRgba(seg.lineColor, isCurrent ? 0.95 : 0.78)
        ctx.fillStyle = ribbon
        ctx.fillRect(rectLeft, 0, rectW, RIBBON_H)

        if (isCurrent) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.22)'
          ctx.fillRect(rectLeft, 0, rectW, 3)
        }

        if (settings.showSessionLines && x1 !== null && x1 >= 0 && x1 <= W) {
          ctx.beginPath()
          ctx.strokeStyle = solidFromRgba(seg.lineColor, 0.75 * opFactor)
          ctx.lineWidth = seg.isOverlap || isCurrent ? 1.5 : 1
          ctx.setLineDash(seg.isOverlap ? [] : [4, 6])
          ctx.moveTo(x1, RIBBON_H)
          ctx.lineTo(x1, H)
          ctx.stroke()
          ctx.setLineDash([])
        }

        // Подпись на ленте
        if (rectW > 42) {
          ctx.font = `bold ${isCurrent ? 11 : 10}px monospace`
          ctx.fillStyle = '#0a0a0a'
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          const label = isCurrent
            ? `● ${seg.label.toUpperCase()}`
            : seg.label.toUpperCase()
          ctx.fillText(label, rectLeft + 6, RIBBON_H / 2 + 0.5)
          ctx.textBaseline = 'alphabetic'
        }
      })

      // Бейдж текущей сессии (правый верхний угол)
      {
        const badge = `СЕЙЧАС · ${nowDef.label.toUpperCase()}`
        ctx.font = 'bold 10px monospace'
        const padX = 8
        const tw = ctx.measureText(badge).width + padX * 2
        const bh = 18
        const bx = Math.max(6, W - tw - 6)
        const by = RIBBON_H + 6

        ctx.fillStyle = solidFromRgba(nowDef.lineColor, 0.92)
        ctx.beginPath()
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(bx, by, tw, bh, 4)
        } else {
          ctx.rect(bx, by, tw, bh)
        }
        ctx.fill()

        ctx.strokeStyle = 'rgba(0,0,0,0.35)'
        ctx.lineWidth = 1
        ctx.stroke()

        ctx.fillStyle = '#0a0a0a'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(badge, bx + tw / 2, by + bh / 2)
        ctx.textBaseline = 'alphabetic'
      }

      if (settings.showNews) {
        news.forEach((event) => {
          const x = tsToX(event.timestamp)
          if (x === null || x < 0 || x > W) return

          const colors = getNewsColor(event.importance)

          ctx.beginPath()
          ctx.strokeStyle = colors.line
          ctx.lineWidth = 1.5
          ctx.setLineDash(
            event.importance === 'CRITICAL' ? [3, 3] : [4, 6]
          )
          ctx.moveTo(x, RIBBON_H + 4)
          ctx.lineTo(x, H)
          ctx.stroke()
          ctx.setLineDash([])

          const dotY = RIBBON_H + 12
          const dotR = event.importance === 'CRITICAL' ? 5 : 4

          ctx.beginPath()
          ctx.arc(x, dotY, dotR, 0, Math.PI * 2)
          ctx.fillStyle = colors.dot
          ctx.fill()
          ctx.strokeStyle = '#111'
          ctx.lineWidth = 1
          ctx.stroke()

          if (
            event.importance === 'CRITICAL' ||
            event.importance === 'HIGH'
          ) {
            ctx.font = 'bold 6px monospace'
            ctx.fillStyle = '#111'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(
              event.importance === 'CRITICAL' ? '!' : '↑',
              x,
              dotY
            )
            ctx.textBaseline = 'alphabetic'
          }

          const badgeText = event.name
          ctx.font = 'bold 8px monospace'
          const tw = ctx.measureText(badgeText).width + 6
          const bx = x - tw / 2
          const by = H - 22
          const bh = 13

          ctx.fillStyle = colors.bg
          ctx.beginPath()
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(bx, by, tw, bh, 2)
          } else {
            ctx.rect(bx, by, tw, bh)
          }
          ctx.fill()

          ctx.fillStyle = '#000'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(badgeText, x, by + bh / 2)
          ctx.textBaseline = 'alphabetic'
        })
      }
    }

    draw()

    const onRange = () => draw()
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)
    chart.subscribeCrosshairMove(onRange)

    const ro = new ResizeObserver(draw)
    ro.observe(container)

    // Обновлять бейдж «СЕЙЧАС» раз в минуту
    const tick = window.setInterval(draw, 60_000)

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
      chart.unsubscribeCrosshairMove(onRange)
      ro.disconnect()
      window.clearInterval(tick)
    }
  }, [
    chart,
    series,
    sessions,
    weekends,
    news,
    settings,
    timeframe,
    containerRef,
  ])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: 0 }}
    />
  )
}

export default SessionOverlay
```

## 4. `src/hooks/useSessionData.ts`

```ts
import { useState, useEffect, useCallback, useRef } from 'react'
import type { IChartApi } from 'lightweight-charts'
import type {
  SessionSegment,
  WeekendSegment,
  NewsEvent,
  SessionSettings,
} from '../engine/sessions/types'
import {
  calculateSessionSegments,
  calculateWeekendSegments,
} from '../engine/sessions/sessionCalculator'
import { getEventsInRange } from '../engine/sessions/newsCalendar'

interface SessionData {
  sessions: SessionSegment[]
  weekends: WeekendSegment[]
  news: NewsEvent[]
}

const SESSION_TIMEFRAMES = new Set(['1m', '5m', '15m', '1h'])

export function useSessionData(
  chart: IChartApi | null,
  timeframe: string,
  settings: SessionSettings
): SessionData {
  const [data, setData] = useState<SessionData>({
    sessions: [],
    weekends: [],
    news: [],
  })

  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const recalculate = useCallback(() => {
    if (!chart) return

    if (!SESSION_TIMEFRAMES.has(timeframe)) {
      setData({ sessions: [], weekends: [], news: [] })
      return
    }

    const currentSettings = settingsRef.current
    if (!currentSettings.enabled) {
      setData({ sessions: [], weekends: [], news: [] })
      return
    }

    try {
      const visible = chart.timeScale().getVisibleRange()
      if (!visible) return

      const fromTs = visible.from as number
      const toTs = visible.to as number
      const paddedFrom = fromTs - 86400
      const paddedTo = toTs + 86400

      setData({
        sessions: calculateSessionSegments(paddedFrom, paddedTo, currentSettings),
        weekends: calculateWeekendSegments(
          paddedFrom,
          paddedTo,
          currentSettings.showWeekends
        ),
        news: currentSettings.showNews
          ? getEventsInRange(paddedFrom, paddedTo)
          : [],
      })
    } catch {
      // timeScale may not be ready
    }
  }, [chart, timeframe])

  useEffect(() => {
    recalculate()
  }, [recalculate, settings])

  useEffect(() => {
    if (!chart) return
    chart.timeScale().subscribeVisibleLogicalRangeChange(recalculate)
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(recalculate)
    }
  }, [chart, recalculate])

  return data
}
```

## 5. `src/engine/types.ts`

```ts
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
  /** Whale Watcher состояния по символу (internalSymbol → WhaleWatcherState) */
  whaleWatcher: Record<string, WhaleWatcherState>

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
  setWhaleWatcher: (internalSymbol: string, state: WhaleWatcherState) => void
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
// Whale Watcher Types
// ============================================================================

/**
 * Одиночный аномальный ордер в стакане (whale order).
 * Фиксируется когда объём ордера * цена >= WHALE_THRESHOLD_USD
 */
export interface WhaleOrder {
  /** BID (поддержка) или ASK (сопротивление) */
  side: 'BID' | 'ASK'
  /** Цена уровня */
  price: number
  /** Объём в базовой валюте */
  volume: number
  /** Объём в USD (volume * price) */
  volumeUsd: number
  /** Расстояние от текущей цены в % */
  distancePct: number
  /** Время обнаружения */
  detectedAt: number
}

/**
 * Алерт Whale Watcher — один активный сигнал о крупном ордере.
 * Живёт пока ордер присутствует в стакане + TTL.
 */
export interface WhaleAlert {
  id: string
  order: WhaleOrder
  /** Символ (internalSymbol) */
  symbol: string
  /**
   * 'SUPPORT'    — крупный BID ниже цены → Whale Support
   * 'RESISTANCE' — крупный ASK выше цены → Whale Resistance
   * 'IMMEDIATE'  — ордер в 0-1% от цены → немедленная угроза/опора
   */
  type: 'SUPPORT' | 'RESISTANCE' | 'IMMEDIATE'
  /** Человекочитаемое сообщение для UI */
  message: string
  /** Активен ли алерт (ордер ещё в стакане) */
  isActive: boolean
  /** Время первого обнаружения */
  firstSeen: number
  /** Время последнего подтверждения (ордер всё ещё в стакане) */
  lastSeen: number
  /** TTL истёк — ордер пропал из стакана */
  isExpired: boolean
}

/** Состояние Whale Watcher для одного символа */
export interface WhaleWatcherState {
  symbol: string
  alerts: WhaleAlert[]
  /** Самый крупный BID в зоне 1-5% */
  strongestSupport: WhaleOrder | null
  /** Самый крупный ASK в зоне 1-5% */
  strongestResistance: WhaleOrder | null
  /** Score-буст от whale support/resistance (0..1.5) */
  scoreBoost: number
  lastUpdated: number
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

## 6. `src/store/useAppStore.ts`

```ts
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type {
  AppState,
  LiveTicker,
  CoinSignal,
  LiquidityMap,
  MarketContext,
  WhaleWatcherState,
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
    whaleWatcher: {},

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

    setWhaleWatcher: (internalSymbol: string, whaleState: WhaleWatcherState) =>
      set((state) => ({
        whaleWatcher: {
          ...state.whaleWatcher,
          [internalSymbol]: whaleState,
        },
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

## 7. `src/components/tactical/TacticalDrawer.tsx`

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
  WhaleWatcherState,
} from '../../engine/types'
import { formatWhaleVolume } from '../../engine/orderbook/whaleDetector'
import WhaleAlertBanner from './WhaleAlertBanner'

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

/** Панель Whale Watcher в Drawer */
const WhaleWatcherPanel = ({ state }: { state: WhaleWatcherState }) => {
  const hasWhales =
    state.strongestSupport !== null || state.strongestResistance !== null

  const activeAlerts = state.alerts.filter((a) => a.isActive && !a.isExpired)

  if (!hasWhales && activeAlerts.length === 0) return null

  const formatPrice = (price: number): string => {
    if (price >= 1000)
      return price.toLocaleString('en-US', { maximumFractionDigits: 0 })
    if (price >= 1) return price.toFixed(4)
    return price.toFixed(6)
  }

  return (
    <div className="rounded-xl border border-hull-border bg-hull p-3">
      {/* Заголовок */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-base">🐋</span>
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          Whale Watcher
        </span>
        {state.scoreBoost > 0 && (
          <span className="ml-auto rounded bg-cyan-400/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-cyan-400">
            +{state.scoreBoost.toFixed(1)} score
          </span>
        )}
      </div>

      {/* Активные алерты */}
      {activeAlerts.length > 0 && (
        <div className="mb-3 space-y-2">
          {activeAlerts.slice(0, 3).map((alert) => (
            <WhaleAlertBanner key={alert.id} alert={alert} />
          ))}
        </div>
      )}

      {/* Strongest Support / Resistance */}
      <div className="grid grid-cols-2 gap-2">
        {state.strongestSupport && (
          <div className="rounded-lg border border-matrix/20 bg-matrix/5 p-2">
            <div className="mb-1 font-mono text-[10px] uppercase text-holo/40">
              Whale Support
            </div>
            <div className="font-mono text-sm font-bold text-matrix">
              {formatPrice(state.strongestSupport.price)}
            </div>
            <div className="font-mono text-[10px] text-matrix/70">
              {formatWhaleVolume(state.strongestSupport.volumeUsd)}
            </div>
            <div className="mt-1 font-mono text-[9px] text-holo/30">
              {state.strongestSupport.distancePct.toFixed(2)}% ниже
            </div>
          </div>
        )}

        {state.strongestResistance && (
          <div className="rounded-lg border border-alert/20 bg-alert/5 p-2">
            <div className="mb-1 font-mono text-[10px] uppercase text-holo/40">
              Whale Resistance
            </div>
            <div className="font-mono text-sm font-bold text-alert">
              {formatPrice(state.strongestResistance.price)}
            </div>
            <div className="font-mono text-[10px] text-alert/70">
              {formatWhaleVolume(state.strongestResistance.volumeUsd)}
            </div>
            <div className="mt-1 font-mono text-[9px] text-holo/30">
              {state.strongestResistance.distancePct.toFixed(2)}% выше
            </div>
          </div>
        )}
      </div>

      <p className="mt-2 font-mono text-[9px] text-holo/20">
        Обновляется каждые 2 сек · Порог: $1M+
      </p>
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
  const whaleWatcher = useAppStore((state) => state.whaleWatcher)

  const drawerRef = useRef<HTMLDivElement>(null)

  const signal: CoinSignal | null = selectedCoin
    ? signals.find((s) => s.symbol === selectedCoin) ?? null
    : null

  const liquidityMap = signal
    ? liquidityMaps[signal.internalSymbol] ?? null
    : null
  const btcDivergence = signal?.btcDivergence ?? null
  const whaleState = signal
    ? whaleWatcher[signal.internalSymbol] ?? null
    : null

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
          {whaleState && <WhaleWatcherPanel state={whaleState} />}

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

## 8. `src/api/mexc/index.ts`

```ts
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
