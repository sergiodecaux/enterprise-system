# TECHNICAL FILTERS — Source Dump

> Сгенерировано автоматически. Полные выписки без сокращений.

---

## 1. src/engine/smc/index.ts

### Типы и интерфейсы в файле

```typescript
import type { OhlcvCandle } from '../../api/mexc'

export type TrendDirection = 'BULLISH' | 'BEARISH' | 'RANGING'
export type TradeSide = 'LONG' | 'SHORT'
export type DailyBiasDirection = 'LONG_ONLY' | 'SHORT_ONLY' | 'BOTH' | 'NO_TRADE'

export interface MarketStructure {
  trend: TrendDirection
  lastBos: 'UP' | 'DOWN' | null
  swingHighs: Array<[number, number]>
  swingLows: Array<[number, number]>
  lastSwingHigh: number | null
  lastSwingLow: number | null
}

export interface OrderBlock {
  type: 'BULLISH' | 'BEARISH'
  top: number
  bottom: number
  low?: number
  high?: number
  index: number
  strength: number
  volume: number
}

export interface FairValueGap {
  type: 'BULLISH' | 'BEARISH'
  top: number
  bottom: number
  index: number
}

export interface FibLevels {
  '0.236': number
  '0.382': number
  '0.5': number
  '0.618': number
  '0.705': number
  '0.786': number
  '1.0': number
  ote_top: number
  ote_bottom: number
}

export interface RejectionResult {
  rejected: boolean
  wickRatio: number
  bodyInZone: boolean
}

export interface ConfluenceResult {
  score: number
  zones: string[]
  bestZone: {
    top: number | null
    bottom: number | null
    sl: number | null
  }
}

export interface DailyAnalysis {
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: number
  pattern: string
  details: string
}

export interface DailyLevels {
  pdh: number
  pdl: number
  pdo: number
  pdc: number
  pwh: number
  pwl: number
  nearestResistance: number | null
  nearestSupport: number | null
  keyLevels: Array<{ price: number; touches: number }>
}

export interface DailyBiasResult {
  direction: DailyBiasDirection
  confidence: number
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  dailyAnalysis: DailyAnalysis | null
  dailyLevels: DailyLevels | null
}
```

### detectMarketStructure

```typescript
export function detectMarketStructure(
  candles: OhlcvCandle[],
  lookback = 50
): MarketStructure {
  const empty: MarketStructure = {
    trend: 'RANGING',
    lastBos: null,
    swingHighs: [],
    swingLows: [],
    lastSwingHigh: null,
    lastSwingLow: null,
  }

  if (candles.length < lookback) return empty

  const highs = candles.map((c) => c[2])
  const lows = candles.map((c) => c[3])
  const closes = candles.map((c) => c[4])

  const swingHighs: Array<[number, number]> = []
  const swingLows: Array<[number, number]> = []

  for (let i = 2; i < candles.length - 2; i++) {
    if (
      highs[i] > highs[i - 1] &&
      highs[i] > highs[i - 2] &&
      highs[i] > highs[i + 1] &&
      highs[i] > highs[i + 2]
    ) {
      swingHighs.push([i, highs[i]])
    }
    if (
      lows[i] < lows[i - 1] &&
      lows[i] < lows[i - 2] &&
      lows[i] < lows[i + 1] &&
      lows[i] < lows[i + 2]
    ) {
      swingLows.push([i, lows[i]])
    }
  }

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return {
      ...empty,
      swingHighs,
      swingLows,
      lastSwingHigh: swingHighs.length ? swingHighs[swingHighs.length - 1][1] : null,
      lastSwingLow: swingLows.length ? swingLows[swingLows.length - 1][1] : null,
    }
  }

  const lastHighs = swingHighs.slice(-4).map((sh) => sh[1])
  const lastLows = swingLows.slice(-4).map((sl) => sl[1])

  const higherHighs =
    lastHighs.length > 1 && lastHighs.every((v, i) => i === 0 || v >= lastHighs[i - 1])
  const higherLows =
    lastLows.length > 1 && lastLows.every((v, i) => i === 0 || v >= lastLows[i - 1])
  const lowerHighs =
    lastHighs.length > 1 && lastHighs.every((v, i) => i === 0 || v <= lastHighs[i - 1])
  const lowerLows =
    lastLows.length > 1 && lastLows.every((v, i) => i === 0 || v <= lastLows[i - 1])

  let trend: TrendDirection = 'RANGING'
  if (higherHighs && higherLows) trend = 'BULLISH'
  else if (lowerHighs && lowerLows) trend = 'BEARISH'

  let lastBos: 'UP' | 'DOWN' | null = null
  const currentPrice = closes[closes.length - 1]
  if (swingHighs.length && currentPrice > swingHighs[swingHighs.length - 1][1]) lastBos = 'UP'
  if (swingLows.length && currentPrice < swingLows[swingLows.length - 1][1]) lastBos = 'DOWN'

  return {
    trend,
    lastBos,
    swingHighs,
    swingLows,
    lastSwingHigh: swingHighs[swingHighs.length - 1][1],
    lastSwingLow: swingLows[swingLows.length - 1][1],
  }
}
```

### findOrderBlocks

```typescript
export function findOrderBlocks(
  candles: OhlcvCandle[],
  _structure: MarketStructure,
  maxBlocks = 5
): OrderBlock[] {
  if (candles.length < 20) return []

  const opens = candles.map((c) => c[1])
  const highs = candles.map((c) => c[2])
  const lows = candles.map((c) => c[3])
  const closes = candles.map((c) => c[4])
  const volumes = candles.map((c) => c[5])

  const orderBlocks: OrderBlock[] = []

  for (let i = 2; i < candles.length - 3; i++) {
    const isRed = closes[i] < opens[i]
    const isGreen = closes[i] > opens[i]
    const candleBody = Math.abs(closes[i] - opens[i])
    if (candleBody === 0) continue

    const avgCandleSize =
      i >= 10
        ? Array.from({ length: 10 }, (_, k) => Math.abs(closes[i - 10 + k] - opens[i - 10 + k])).reduce(
            (a, b) => a + b,
            0
          ) / 10
        : candleBody

    if (isRed && avgCandleSize > 0) {
      let impulseUp = 0
      for (let j = 1; j < Math.min(4, candles.length - i); j++) {
        impulseUp += Math.max(0, closes[i + j] - opens[i + j])
      }
      if (impulseUp > avgCandleSize * 2.5) {
        const strength = Math.min(10, Math.floor(impulseUp / avgCandleSize))
        const obBottom = Math.min(opens[i], closes[i])
        const obTop = Math.max(opens[i], closes[i])
        let zoneValid = true
        for (let k = i + 1; k < candles.length; k++) {
          if (closes[k] < obBottom) {
            zoneValid = false
            break
          }
        }
        if (zoneValid) {
          orderBlocks.push({
            type: 'BULLISH',
            top: obTop,
            bottom: obBottom,
            low: lows[i],
            index: i,
            strength,
            volume: volumes[i],
          })
        }
      }
    }

    if (isGreen && avgCandleSize > 0) {
      let impulseDown = 0
      for (let j = 1; j < Math.min(4, candles.length - i); j++) {
        impulseDown += Math.max(0, opens[i + j] - closes[i + j])
      }
      if (impulseDown > avgCandleSize * 2.5) {
        const strength = Math.min(10, Math.floor(impulseDown / avgCandleSize))
        const obBottom = Math.min(opens[i], closes[i])
        const obTop = Math.max(opens[i], closes[i])
        let zoneValid = true
        for (let k = i + 1; k < candles.length; k++) {
          if (closes[k] > obTop) {
            zoneValid = false
            break
          }
        }
        if (zoneValid) {
          orderBlocks.push({
            type: 'BEARISH',
            top: obTop,
            bottom: obBottom,
            high: highs[i],
            index: i,
            strength,
            volume: volumes[i],
          })
        }
      }
    }
  }

  return orderBlocks.sort((a, b) => b.strength - a.strength).slice(0, maxBlocks)
}
```

### findFvg

```typescript
export function findFvg(candles: OhlcvCandle[], maxGaps = 5): FairValueGap[] {
  if (candles.length < 5) return []

  const highs = candles.map((c) => c[2])
  const lows = candles.map((c) => c[3])
  const fvgList: FairValueGap[] = []

  for (let i = 2; i < candles.length; i++) {
    if (lows[i] > highs[i - 2]) {
      const gapTop = lows[i]
      const gapBottom = highs[i - 2]
      let filled = false
      for (let k = i + 1; k < candles.length; k++) {
        if (lows[k] <= gapBottom) {
          filled = true
          break
        }
      }
      if (!filled) {
        fvgList.push({ type: 'BULLISH', top: gapTop, bottom: gapBottom, index: i })
      }
    }

    if (highs[i] < lows[i - 2]) {
      const gapTop = lows[i - 2]
      const gapBottom = highs[i]
      let filled = false
      for (let k = i + 1; k < candles.length; k++) {
        if (highs[k] >= gapTop) {
          filled = true
          break
        }
      }
      if (!filled) {
        fvgList.push({ type: 'BEARISH', top: gapTop, bottom: gapBottom, index: i })
      }
    }
  }

  return fvgList.slice(-maxGaps)
}
```

### checkCandleRejection

```typescript
export function checkCandleRejection(
  candle: OhlcvCandle,
  zoneTop: number,
  zoneBottom: number,
  direction: TradeSide
): RejectionResult {
  const openPrice = candle[1]
  const high = candle[2]
  const low = candle[3]
  const close = candle[4]

  const bodyTop = Math.max(openPrice, close)
  const bodyBottom = Math.min(openPrice, close)
  const totalRange = high - low

  if (totalRange === 0) {
    return { rejected: false, wickRatio: 0, bodyInZone: false }
  }

  if (direction === 'LONG') {
    const lowerWick = bodyBottom - low
    const wickRatio = lowerWick / totalRange
    const wickEnteredZone = low <= zoneTop
    const bodyAboveZone = bodyBottom >= zoneBottom
    const isGreen = close > openPrice
    const strongRejection = wickRatio > 0.4

    return {
      rejected: wickEnteredZone && bodyAboveZone && isGreen && strongRejection,
      wickRatio,
      bodyInZone: zoneBottom <= bodyBottom && bodyBottom <= zoneTop,
    }
  }

  const upperWick = high - bodyTop
  const wickRatio = upperWick / totalRange
  const wickEnteredZone = high >= zoneBottom
  const bodyBelowZone = bodyTop <= zoneTop
  const isRed = close < openPrice
  const strongRejection = wickRatio > 0.4

  return {
    rejected: wickEnteredZone && bodyBelowZone && isRed && strongRejection,
    wickRatio,
    bodyInZone: zoneBottom <= bodyTop && bodyTop <= zoneTop,
  }
}
```

## 2. src/engine/types.ts (полный файл)

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
  /** LTF Market Structure Shift */
  mss?: MSSResult | null
  /** Свежий liquidity raid / sweep */
  raid?: LiquidityRaidResult | null
  /** OTE Sniper zone */
  ote?: OTESniperZone | null
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
  /** Session DNA профили по символу (internalSymbol → SessionDNA) */
  sessionDNA: Record<string, SessionDNA>
  /** Tape Momentum по символу */
  tapeMomentum: Record<string, TapeMomentumState>
  setTapeMomentum: (symbol: string, state: TapeMomentumState) => void
  /** PO3 анализ по символу */
  po3Analysis: Record<string, PO3Analysis>
  setPO3Analysis: (symbol: string, analysis: PO3Analysis) => void

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
  setSessionDNA: (internalSymbol: string, dna: SessionDNA) => void
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
// Trading Session DNA Types
// ============================================================================

/**
 * Статистика поведения монеты в одной торговой сессии.
 * Считается по последним 30 дням 1H свечей.
 */
export interface SessionStat {
  /** Название сессии */
  session: 'ASIA' | 'LONDON' | 'NEW_YORK' | 'OVERLAP'
  /** Человекочитаемое название */
  label: string
  /** Кол-во проанализированных дней */
  totalDays: number
  /** Средний % движения (high-low) внутри сессии */
  avgRangePct: number
  /** % дней когда сессия обновляла хай предыдущей сессии */
  breaksPrevHighPct: number
  /** % дней когда сессия обновляла лоу предыдущей сессии */
  breaksPrevLowPct: number
  /** % дней когда движение в начале сессии разворачивалось (fakeout) */
  fakeoutPct: number
  /** % бычьих дней (close сессии > open сессии) */
  bullishPct: number
  /** Средний объём сессии (в базовой валюте) */
  avgVolume: number
  /** Самая активная сессия по объёму? */
  isHighestVolume: boolean
}

/**
 * "Личность" монеты — агрегированный вывод по всем сессиям.
 * Используется для бейджа в UI.
 */
export type SessionPersonality =
  | 'FAKEOUT_KING'
  | 'TREND_FOLLOWER'
  | 'ASIA_RANGER'
  | 'OVERLAP_BEAST'
  | 'LONDON_BREAKER'
  | 'NY_REVERSAL'
  | 'STEADY_MOVER'
  | 'UNKNOWN'

/**
 * Полный Session DNA профиль монеты.
 */
export interface SessionDNA {
  symbol: string
  /** Статистика по каждой сессии */
  sessions: SessionStat[]
  /** Итоговая "личность" монеты */
  personality: SessionPersonality
  /** Человекочитаемое описание personality для UI */
  personalityLabel: string
  /** Emoji-иконка personality */
  personalityIcon: string
  /** Самая сильная сессия (по объёму) */
  dominantSession: 'ASIA' | 'LONDON' | 'NEW_YORK' | 'OVERLAP' | null
  /** Ключевой инсайт — одна строка для Drawer */
  keyInsight: string
  /** Кол-во свечей использованных для анализа */
  candlesAnalyzed: number
  computedAt: number
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

// ============================================================================
// LTF Alignment — Market Structure Shift (MSS)
// ============================================================================

/**
 * Результат детекции MSS на младшем таймфрейме (1m / 5m).
 * MSS = пробой последнего коррекционного экстремума после захода в HTF зону.
 */
export interface MSSResult {
  /** Обнаружен ли MSS */
  detected: boolean
  /** Направление слома структуры */
  direction: 'BULLISH' | 'BEARISH' | null
  /** Цена пробоя */
  breakPrice: number | null
  /** Таймфрейм на котором обнаружен MSS */
  timeframe: '1m' | '5m' | '15m'
  /** Индекс свечи пробоя в массиве */
  breakCandleIndex: number | null
  /** Score-буст за подтверждение MSS */
  scoreBoost: number
  /** Метка для UI */
  label: string
}

// ============================================================================
// Liquidity Raid Detector — Sweep Detection
// ============================================================================

/**
 * Тип liquidity sweep (снятие ликвидности / ложный пробой).
 */
export type SweepType = 'BULL_SWEEP' | 'BEAR_SWEEP' | 'NONE'

/**
 * Результат детекции sweep ликвидности.
 */
export interface LiquidityRaidResult {
  type: SweepType
  /** Цена swept уровня */
  sweptLevel: number | null
  /** Глубина пробоя в % */
  sweepDepthPct: number
  /** Насколько свечей назад был sweep (от текущей) */
  candlesAgo: number
  /** true если sweep произошёл непосредственно перед текущей ценой (свежий) */
  isFresh: boolean
  /** Score-буст: +4 за свежий sweep в нужном направлении */
  scoreBoost: number
  /** Метка для UI */
  label: string
}

// ============================================================================
// OTE Sniper Zone
// ============================================================================

/**
 * Оптимальная зона входа (0.62-0.79 Фибо от последнего импульса после MSS).
 */
export interface OTESniperZone {
  /** Зона активна (цена ещё не прошла её) */
  isActive: boolean
  /** Верхняя граница OTE зоны (0.618 или 0.786 в зависимости от направления) */
  zoneTop: number
  /** Нижняя граница OTE зоны */
  zoneBottom: number
  /** Цена начала импульса (swing low для LONG, swing high для SHORT) */
  impulseOrigin: number
  /** Цена конца импульса */
  impulseEnd: number
  /** Текущая цена внутри OTE зоны? */
  priceInZone: boolean
  /** Направление сетапа */
  direction: 'LONG' | 'SHORT' | null
  /** Score-буст если цена в OTE */
  scoreBoost: number
  /** Метка для UI */
  label: string
}

// ============================================================================
// Tape Momentum
// ============================================================================

/**
 * Состояние индикатора Tape Momentum.
 * Анализирует скорость и направление сделок в стакане.
 */
export type TapeMomentumSignal =
  | 'STRONG_BUY'
  | 'BUY'
  | 'NEUTRAL'
  | 'SELL'
  | 'STRONG_SELL'

export interface TapeMomentumState {
  signal: TapeMomentumSignal
  /** Скорость изменения imbalance (дельта за последние N тиков) */
  imbalanceDelta: number
  /** Преобладающая сторона: BUYERS / SELLERS / NEUTRAL */
  pressure: 'BUYERS' | 'SELLERS' | 'NEUTRAL'
  /** Количество последовательных тиков в одном направлении */
  consecutiveTicks: number
  /** true если резкий всплеск (агрессия) */
  isBurst: boolean
  /** Цвет индикатора для UI */
  color: string
  /** Метка для UI */
  label: string
  lastUpdated: number
}

// ============================================================================
// Power of Three (PO3) — Asia Box + Daily Phases
// ============================================================================

/**
 * Фаза дня по концепции ICT Power of Three.
 */
export type PO3Phase =
  | 'ACCUMULATION'
  | 'MANIPULATION'
  | 'DISTRIBUTION'
  | 'UNKNOWN'

/**
 * "Коробка Азии" — диапазон цен за азиатскую сессию.
 */
export interface AsiaBox {
  /** Хай азиатской сессии */
  high: number
  /** Лой азиатской сессии */
  low: number
  /** Середина диапазона */
  mid: number
  /** Размер диапазона в % */
  rangePct: number
  /** Дата (UTC) */
  date: string
  /** Timestamp открытия азиатской сессии */
  startTs: number
  /** Timestamp закрытия азиатской сессии */
  endTs: number
}

/**
 * Полный PO3 анализ текущего дня.
 */
export interface PO3Analysis {
  /** Коробка Азии сегодняшнего дня */
  asiaBox: AsiaBox | null
  /** Текущая фаза дня */
  currentPhase: PO3Phase
  /** Произошла ли манипуляция (Лондон снёс хай/лоу Азии)? */
  manipulationDetected: boolean
  /** Направление манипуляции (вынос хая или лоя) */
  manipulationDirection: 'HIGH_SWEPT' | 'LOW_SWEPT' | 'BOTH' | null
  /** Цена возврата в коробку Азии (если была манипуляция) */
  returnIntoBox: boolean
  /** Описание фазы для UI */
  phaseLabel: string
  /** Иконка фазы */
  phaseIcon: string
  /** Торговый совет */
  tradingAdvice: string
  computedAt: number
}

```

## 3. src/engine/ProbabilityEngine.ts

### Полный код analyzeSymbol

```typescript
export function analyzeSymbol(input: AnalyzeSymbolInput): AnalyzeSymbolResult {
  const {
    internalSymbol,
    ohlcv4h,
    ohlcv1h,
    ohlcv15m,
    priceChange24h,
    dailyBias,
    btcTrend,
    wallTracker,
    newsSentimentBoost,
    liquidityMap,
    btcOhlcv1h,
    ohlcv5m,
  } = input

  const applyWallBoost = (
    score: number,
    direction: TradeSide | null,
    zones: string[]
  ): { score: number; zones: string[] } => {
    if (!wallTracker || !direction) return { score, zones }
    const wallBoost = calculateWallBoost(wallTracker, direction)
    if (wallBoost.boost === 0) return { score, zones }
    const boosted = Math.min(Math.max(score + wallBoost.boost, 0), 10)
    console.log(
      `[PE] ${internalSymbol} Wall boost: ${wallBoost.boost >= 0 ? '+' : ''}${wallBoost.boost.toFixed(2)} (${wallBoost.reason})`
    )
    return {
      score: boosted,
      zones: [...zones, `WALL_BOOST: ${wallBoost.reason}`],
    }
  }

  const applyNewsBoost = (
    score: number,
    zones: string[]
  ): { score: number; zones: string[] } => {
    if (newsSentimentBoost === undefined || newsSentimentBoost === 0) {
      return { score, zones }
    }
    const clampedBoost = Math.max(-1.5, Math.min(1.5, newsSentimentBoost))
    const finalScore = Math.min(Math.max(score + clampedBoost, 0), 10)
    if (Math.abs(clampedBoost) > 0.1) {
      logger.info(
        `[PE] ${internalSymbol} news boost: ${clampedBoost.toFixed(2)}`
      )
    }
    return {
      score: finalScore,
      zones: [...zones, `NEWS_BOOST: ${clampedBoost.toFixed(2)}`],
    }
  }

  const applyLiquidityBoost = (
    score: number,
    direction: TradeSide | null,
    zones: string[]
  ): { score: number; zones: string[] } => {
    if (!liquidityMap || !direction) return { score, zones }
    const boost = liquidityMap.liquidityBoost
    if (boost === 0) return { score, zones }

    const relevantLevel =
      direction === 'LONG' ? liquidityMap.nearestSSL : liquidityMap.nearestBSL
    if (!relevantLevel || !relevantLevel.isActive) return { score, zones }

    const finalScore = Math.min(Math.max(score + boost, 0), 10)
    const tag = `LIQ_${relevantLevel.type}_${relevantLevel.strength}_${relevantLevel.distancePct.toFixed(1)}%`
    logger.info(
      `[PE] ${internalSymbol} liquidity boost: +${boost.toFixed(2)} (${tag})`
    )

    return {
      score: finalScore,
      zones: [...zones, `LIQ_BOOST: ${tag}`],
    }
  }

  const closes1h = ohlcv1h.map((c) => c[4])
  const currentPrice = closes1h[closes1h.length - 1] ?? 0
  const rsi = closes1h.length ? calculateRsi(closes1h) : null

  // ── BTC Divergence ────────────────────────────────────────────────────────
  const divergence: BtcDivergenceResult =
    btcOhlcv1h && btcOhlcv1h.length >= 25
      ? calculateBtcDivergence(btcOhlcv1h, ohlcv1h, 24)
      : {
          type: 'NONE',
          btcChangePct: 0,
          altChangePct: 0,
          relativeStrength: 0,
          scoreBoost: 0,
          label: '',
          lookbackCandles: 24,
        }

  const applyDivergenceBoost = (
    score: number,
    direction: TradeSide | null,
    zones: string[]
  ): { score: number; zones: string[] } => {
    if (
      !direction ||
      divergence.type === 'NONE' ||
      divergence.type === 'CORRELATED'
    ) {
      return { score, zones }
    }

    let boost = 0
    let tag = ''

    if (direction === 'LONG' && divergence.type === 'BULL_DIV') {
      boost = divergence.scoreBoost
      tag = `DIV_BULL: +${boost.toFixed(2)}`
    } else if (direction === 'SHORT' && divergence.type === 'BEAR_DIV') {
      boost = divergence.scoreBoost
      tag = `DIV_BEAR: +${boost.toFixed(2)}`
    } else if (direction === 'LONG' && divergence.type === 'BEAR_DIV') {
      boost = -(divergence.scoreBoost * 0.5)
      tag = `DIV_CONTRA: ${boost.toFixed(2)}`
    } else if (direction === 'SHORT' && divergence.type === 'BULL_DIV') {
      boost = -(divergence.scoreBoost * 0.5)
      tag = `DIV_CONTRA: ${boost.toFixed(2)}`
    }

    if (boost === 0) return { score, zones }

    const finalScore = Math.min(Math.max(score + boost, 0), 10)
    logger.info(
      `[PE] ${internalSymbol} divergence boost: ${boost >= 0 ? '+' : ''}${boost.toFixed(2)} | ${divergence.label}`
    )

    return {
      score: finalScore,
      zones: [...zones, tag],
    }
  }

  // ── Pre-compute LTF signals (используются в trySide) ─────────────────────
  // MSS, Raid, OTE вычисляются один раз и используются в обоих направлениях
  const _mssLong =
    ohlcv5m && ohlcv5m.length >= 15 ? detectMSS(ohlcv5m, 'LONG', 30) : null
  const _mssShort =
    ohlcv5m && ohlcv5m.length >= 15 ? detectMSS(ohlcv5m, 'SHORT', 30) : null
  const _raidLong = detectLiquidityRaid(ohlcv1h, 'LONG', 20, 5)
  const _raidShort = detectLiquidityRaid(ohlcv1h, 'SHORT', 20, 5)

  const applyLTFBoost = (
    score: number,
    direction: TradeSide | null,
    zones: string[]
  ): {
    score: number
    zones: string[]
    mss: MSSResult | null
    raid: LiquidityRaidResult | null
    ote: OTESniperZone | null
  } => {
    if (!direction) return { score, zones, mss: null, raid: null, ote: null }

    let s = score
    const z = [...zones]
    let mssResult: MSSResult | null = null
    let raidResult: LiquidityRaidResult | null = null
    let oteResult: OTESniperZone | null = null

    const mss = direction === 'LONG' ? _mssLong : _mssShort
    if (mss?.detected) {
      s = Math.min(s + mss.scoreBoost, 10)
      z.push(`MSS_${direction}: ${mss.label}`)
      mssResult = mss
      logger.info(`[PE] ${internalSymbol} MSS boost: +${mss.scoreBoost}`)
    }

    const raid = direction === 'LONG' ? _raidLong : _raidShort
    if (raid.type !== 'NONE' && raid.isFresh) {
      s = Math.min(s + raid.scoreBoost, 10)
      z.push(`RAID_${raid.type}: ${raid.label}`)
      raidResult = raid
      logger.info(`[PE] ${internalSymbol} Raid boost: +${raid.scoreBoost}`)
    }

    const ote = calculateOTEZone(ohlcv1h, currentPrice, direction)
    if (ote.priceInZone) {
      s = Math.min(s + ote.scoreBoost, 10)
      z.push(`OTE_${direction}: ${ote.label}`)
      oteResult = ote
      logger.info(`[PE] ${internalSymbol} OTE boost: +${ote.scoreBoost}`)
    }

    return { score: s, zones: z, mss: mssResult, raid: raidResult, ote: oteResult }
  }

  if (
    ohlcv4h.length < 50 ||
    ohlcv1h.length < 50 ||
    ohlcv15m.length < 20 ||
    !currentPrice
  ) {
    return {
      signal: emptySignal(
        internalSymbol,
        currentPrice,
        priceChange24h,
        rsi,
        null,
        btcTrend,
        dailyBias
      ),
      triggered: false,
    }
  }

  const coinStructure = detectMarketStructure(ohlcv4h, 50)
  const coinTrend = coinStructure.trend

  if (coinTrend === 'RANGING' && btcTrend === 'RANGING') {
    return {
      signal: emptySignal(
        internalSymbol,
        currentPrice,
        priceChange24h,
        rsi,
        coinTrend,
        btcTrend,
        dailyBias
      ),
      triggered: false,
    }
  }

  const orderBlocks = findOrderBlocks(ohlcv1h, coinStructure)
  const fvgList = findFvg(ohlcv1h)

  let fibLevels = null
  if (coinStructure.lastSwingHigh && coinStructure.lastSwingLow) {
    const fibDirection = coinTrend === 'BULLISH' ? 'UP' : 'DOWN'
    fibLevels = calculateFibonacciLevels(
      coinStructure.lastSwingHigh,
      coinStructure.lastSwingLow,
      fibDirection
    )
  }

  const dailyDirection = dailyBias.direction
  const longPermitted = dailyDirection === 'LONG_ONLY' || dailyDirection === 'BOTH'
  const shortPermitted = dailyDirection === 'SHORT_ONLY' || dailyDirection === 'BOTH'

  const longAllowed =
    longPermitted &&
    (coinTrend === 'BULLISH' || (coinTrend === 'RANGING' && btcTrend === 'BULLISH'))
  const shortAllowed =
    shortPermitted &&
    (coinTrend === 'BEARISH' || (coinTrend === 'RANGING' && btcTrend === 'BEARISH'))

  const trySide = (side: TradeSide): AnalyzeSymbolResult | null => {
    const confluence = calculateConfluence(
      currentPrice,
      orderBlocks,
      fvgList,
      fibLevels,
      side
    )
    if (confluence.score < CONFLUENCE_THRESHOLD) return null
    if (!confluence.bestZone.top || !confluence.bestZone.bottom) return null

    const rejection = checkCandleRejection(
      ohlcv1h[ohlcv1h.length - 1],
      confluence.bestZone.top,
      confluence.bestZone.bottom,
      side
    )
    if (!rejection.rejected) return null

    if (side === 'LONG' && (rsi === null || rsi >= 45)) return null
    if (side === 'SHORT' && (rsi === null || rsi <= 55)) return null

    const levels = buildLevels(side, currentPrice, confluence, dailyBias.dailyLevels)
    const wallBoosted = applyWallBoost(confluence.score, side, confluence.zones)
    const newsBoosted = applyNewsBoost(wallBoosted.score, wallBoosted.zones)
    const liqBoosted = applyLiquidityBoost(
      newsBoosted.score,
      side,
      newsBoosted.zones
    )
    const divBoosted = applyDivergenceBoost(
      liqBoosted.score,
      side,
      liqBoosted.zones
    )
    const ltfResult = applyLTFBoost(divBoosted.score, side, divBoosted.zones)
    const boosted = { score: ltfResult.score, zones: ltfResult.zones }
    const probabilityPct = scoreToProbability(boosted.score)
    const flat = toFlatSymbol(internalSymbol)

    const signal: CoinSignal = {
      symbol: flat,
      internalSymbol,
      displayName: toDisplayName(internalSymbol),
      price: currentPrice,
      priceChange24h,
      currentRSI: rsi,
      probabilityPct,
      score: boosted.score,
      direction: side,
      zones: boosted.zones,
      sl: levels.sl,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tpDaily: levels.tpDaily,
      coinTrend,
      btcTrend,
      dailyBias: dailyBias.bias,
      dailyConfidence: dailyBias.confidence,
      dailyPattern: dailyBias.dailyAnalysis?.pattern ?? null,
      isLocked: false,
      hasActiveSetup: true,
      activeSignal: {
        win_rate: probabilityPct,
        samples: boosted.score,
        direction: side,
        avg_return: 0,
      },
      activeSignalKey: `SMC_${boosted.score}`,
      btcDivergence: divergence.type !== 'NONE' ? divergence : null,
      mss: ltfResult.mss,
      raid: ltfResult.raid,
      ote: ltfResult.ote,
    }

    return { signal, triggered: true }
  }

  if (longAllowed) {
    const longResult = trySide('LONG')
    if (longResult) return longResult
  }
  if (shortAllowed) {
    const shortResult = trySide('SHORT')
    if (shortResult) return shortResult
  }

  // No full trigger — still show best confluence as soft probability for radar
  let softScore = 0
  let softDirection: TradeSide | null = null
  let softZones: string[] = []

  if (longAllowed) {
    const c = calculateConfluence(currentPrice, orderBlocks, fvgList, fibLevels, 'LONG')
    if (c.score > softScore) {
      softScore = c.score
      softDirection = 'LONG'
      softZones = c.zones
    }
  }
  if (shortAllowed) {
    const c = calculateConfluence(currentPrice, orderBlocks, fvgList, fibLevels, 'SHORT')
    if (c.score > softScore) {
      softScore = c.score
      softDirection = 'SHORT'
      softZones = c.zones
    }
  }

  const softWall = applyWallBoost(softScore, softDirection, softZones)
  const softNews = applyNewsBoost(softWall.score, softWall.zones)
  const softLiq = applyLiquidityBoost(
    softNews.score,
    softDirection,
    softNews.zones
  )
  const softDiv = applyDivergenceBoost(softLiq.score, softDirection, softLiq.zones)
  const softLTF = applyLTFBoost(softDiv.score, softDirection, softDiv.zones)
  const softBoosted = { score: softLTF.score, zones: softLTF.zones }
  const flat = toFlatSymbol(internalSymbol)
  const probabilityPct = scoreToProbability(softBoosted.score)

  return {
    signal: {
      symbol: flat,
      internalSymbol,
      displayName: toDisplayName(internalSymbol),
      price: currentPrice,
      priceChange24h,
      currentRSI: rsi,
      probabilityPct,
      score: softBoosted.score,
      direction: softBoosted.score > 0 ? softDirection : null,
      zones: softBoosted.zones,
      sl: null,
      tp1: null,
      tp2: null,
      tpDaily: null,
      coinTrend,
      btcTrend,
      dailyBias: dailyBias.bias,
      dailyConfidence: dailyBias.confidence,
      dailyPattern: dailyBias.dailyAnalysis?.pattern ?? null,
      isLocked: false,
      hasActiveSetup: false,
      activeSignal:
        softBoosted.score > 0 && softDirection
          ? {
              win_rate: probabilityPct,
              samples: softBoosted.score,
              direction: softDirection,
              avg_return: 0,
            }
          : null,
      activeSignalKey: softBoosted.score > 0 ? `SOFT_${softBoosted.score}` : null,
      btcDivergence: divergence.type !== 'NONE' ? divergence : null,
      mss: softLTF.mss,
      raid: softLTF.raid,
      ote: softLTF.ote,
    },
    triggered: false,
  }
}
```

### AnalyzeSymbolInput

```typescript
export interface AnalyzeSymbolInput {
  internalSymbol: string
  ohlcv4h: OhlcvCandle[]
  ohlcv1h: OhlcvCandle[]
  ohlcv15m: OhlcvCandle[]
  priceChange24h: number
  dailyBias: DailyBiasResult
  btcTrend: TrendDirection
  /** Optional live wall tracker (open coin) for score boost */
  wallTracker?: WallTrackerState
  /** News sentiment boost from News Intelligence (−1.5…+1.5) */
  newsSentimentBoost?: number
  /** Опциональная карта ликвидности для score-буста */
  liquidityMap?: LiquidityMap
  /**
   * 1H свечи BTC для расчёта дивергенции силы.
   * Передаётся из scanner где BTC OHLCV уже загружен.
   */
  btcOhlcv1h?: OhlcvCandle[]
  /** 1m или 5m свечи для LTF MSS детекции */
  ohlcv5m?: OhlcvCandle[]
}
```

### AnalyzeSymbolResult

```typescript
export interface AnalyzeSymbolResult {
  signal: CoinSignal
  triggered: boolean
}
```

### Итоговый объект сигнала

Возвращает `{ signal: CoinSignal, triggered: boolean }`.

- **triggered: true** — полный сетап (confluence >= 5, rejection, RSI); `hasActiveSetup: true`, SL/TP заполнены.
- **triggered: false** — soft radar; `hasActiveSetup: false`, SL/TP = null.
- Поля CoinSignal: symbol, internalSymbol, displayName, price, probabilityPct, score, direction, zones, sl/tp1/tp2/tpDaily, coinTrend, btcTrend, dailyBias, mss/raid/ote, btcDivergence и др.

## 4. src/api/mexc/index.ts

### fetchOhlcv

```typescript
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
```

### Trade history / recent trades

**Нет.** В файле отсутствуют функции для ленты сделок, trade history или recent trades.
Доступны: OHLCV (kline), order book depth, tickers.

### Все экспорты

- **Константы:** CHART_TIMEFRAMES, CORE_WATCHLIST, LITE_WATCHLIST
- **Типы:** OhlcvCandle, MexcTimeframe, MexcTicker
- **Функции:** getMexcBaseUrl, toApiSymbol, toInternalSymbol, toDisplayName, toFlatSymbol, fetchOhlcv, fetchDepth, fetchTickers, fetchTicker, getTopVolumeCoins, normalizeSearchQuery, filterTickersByQuery, sleep

### Полный файл

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

## 5. src/hooks/useMexcScanner.ts (полный файл)

```typescript
import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  CORE_WATCHLIST,
  fetchOhlcv,
  fetchTickers,
  sleep,
  toFlatSymbol,
} from '../api/mexc'
import {
  buildLiquidityMap,
  analyzePO3,
  calculateEma,
  detectMarketStructure,
  resolveDailyBias,
  type TrendDirection,
} from '../engine/smc'
import { analyzeSessionDNA } from '../engine/sessions/dnaAnalyzer'
import { analyzeSymbol, COOLDOWN_MS } from '../engine/ProbabilityEngine'
import type {
  CoinSignal,
  LiveTicker,
  LiquidityMap,
  MarketContext,
} from '../engine/types'
import { logger } from '../utils/logger'

const BTC = 'BTC/USDT:USDT'
const SCAN_PAUSE_MS = 120_000
const COIN_DELAY_MS = 300
const TICKER_POLL_MS = 5_000

/**
 * MEXC scanner — CORE_WATCHLIST + монеты из поиска (extraWatchlist).
 */
export const useMexcScanner = () => {
  const isMountedRef = useRef(true)
  const cooldownRef = useRef<Record<string, number>>({})
  const watchlistRef = useRef<string[]>([...CORE_WATCHLIST])
  const btc1hRef = useRef<import('../api/mexc').OhlcvCandle[]>([])

  const {
    updateTicker,
    updateSignals,
    setMarketContext,
    setScanning,
    setConnectionStatus,
    setLiquidityMap,
    setSessionDNA,
    setPO3Analysis,
  } = useAppStore()

  const syncWatchlist = useCallback(() => {
    const extra = useAppStore.getState().extraWatchlist
    const merged = Array.from(new Set<string>([...CORE_WATCHLIST, ...extra]))
    watchlistRef.current = merged
    return merged
  }, [])

  const refreshTickers = useCallback(async () => {
    try {
      const tickers = await fetchTickers()
      const watch = new Set(watchlistRef.current)
      let updated = 0
      for (const t of tickers) {
        if (!watch.has(t.symbol)) continue
        const live: LiveTicker = {
          symbol: toFlatSymbol(t.symbol),
          price: t.lastPrice,
          priceChange24h: t.priceChangePercent,
          volume24h: t.volume24h,
          high24h: t.high24h,
          low24h: t.low24h,
          timestamp: t.timestamp,
        }
        updateTicker(live)
        updated++
      }
      if (updated > 0) {
        setConnectionStatus('POLLING')
      }
    } catch (err) {
      logger.warn('Ticker poll failed', err)
      setConnectionStatus('OFFLINE')
    }
  }, [updateTicker, setConnectionStatus])

  const runScanCycle = useCallback(async () => {
    setScanning(true)
    syncWatchlist()

    try {
      // 0. Daily bias BTC 1D
      const candles1d = await fetchOhlcv(BTC, '1d', 60)
      const dailyBias = resolveDailyBias(candles1d)

      if (dailyBias.direction === 'NO_TRADE') {
        setMarketContext({
          dailyDirection: dailyBias.direction,
          dailyBias: dailyBias.bias,
          dailyConfidence: dailyBias.confidence,
          dailyPattern: dailyBias.dailyAnalysis?.pattern ?? '',
          dailyDetails: dailyBias.dailyAnalysis?.details ?? '',
          dailyAnalysis: dailyBias.dailyAnalysis,
          dailyLevels: dailyBias.dailyLevels,
          btcTrend: 'RANGING',
          emaConfirms: false,
          lastScanAt: Date.now(),
          watchlistSize: watchlistRef.current.length,
          scanProgress: 'Нет торговли — низкая уверенность дня',
        })
        logger.info('Daily bias NO_TRADE — skipping coin scan')
        return
      }

      await sleep(COIN_DELAY_MS)

      // 1. BTC structure 4H + EMA200 1H
      const btc4h = await fetchOhlcv(BTC, '4h', 100)
      await sleep(COIN_DELAY_MS)
      const btc1h = await fetchOhlcv(BTC, '1h', 300)
      // Сохраняем в ref чтобы передать в analyzeSymbol каждой монеты
      btc1hRef.current = btc1h

      const btcStructure = detectMarketStructure(btc4h, 50)
      const btcTrend: TrendDirection = btcStructure.trend
      const btcCloses1h = btc1h.map((c) => c[4])
      const btcEma200 = calculateEma(btcCloses1h, 200)
      const currentBtc = btcCloses1h[btcCloses1h.length - 1]
      let emaConfirms = false
      if (btcTrend === 'BULLISH' && btcEma200 && currentBtc > btcEma200) emaConfirms = true
      if (btcTrend === 'BEARISH' && btcEma200 && currentBtc < btcEma200) emaConfirms = true

      const ctxBase: Omit<MarketContext, 'scanProgress'> = {
        dailyDirection: dailyBias.direction,
        dailyBias: dailyBias.bias,
        dailyConfidence: dailyBias.confidence,
        dailyPattern: dailyBias.dailyAnalysis?.pattern ?? '',
        dailyDetails: dailyBias.dailyAnalysis?.details ?? '',
        dailyAnalysis: dailyBias.dailyAnalysis,
        dailyLevels: dailyBias.dailyLevels,
        btcTrend,
        emaConfirms,
        lastScanAt: Date.now(),
        watchlistSize: watchlistRef.current.length,
      }

      setMarketContext({ ...ctxBase, scanProgress: 'Сканирование...' })
      setConnectionStatus('POLLING')

      // Price map for 24h change
      const tickerMap = new Map<string, number>()
      try {
        const allTickers = await fetchTickers()
        for (const t of allTickers) {
          tickerMap.set(t.symbol, t.priceChangePercent)
          if (watchlistRef.current.includes(t.symbol)) {
            updateTicker({
              symbol: toFlatSymbol(t.symbol),
              price: t.lastPrice,
              priceChange24h: t.priceChangePercent,
              volume24h: t.volume24h,
              high24h: t.high24h,
              low24h: t.low24h,
              timestamp: t.timestamp,
            })
          }
        }
      } catch {
        /* non-fatal */
      }

      const results: CoinSignal[] = []
      const now = Date.now()

      for (let i = 0; i < watchlistRef.current.length; i++) {
        if (!isMountedRef.current) break
        const symbol = watchlistRef.current[i]

        setMarketContext({
          ...ctxBase,
          scanProgress: `${i + 1}/${watchlistRef.current.length} ${symbol}`,
        })

        const lastCd = cooldownRef.current[symbol] ?? 0
        const onCooldown = now - lastCd < COOLDOWN_MS

        try {
          await sleep(COIN_DELAY_MS)
          const ohlcv4h = await fetchOhlcv(symbol, '4h', 100)
          await sleep(200)
          const ohlcv1h = await fetchOhlcv(symbol, '1h', 720)
          await sleep(200)
          const ohlcv15m = await fetchOhlcv(symbol, '15m', 50)
          await sleep(150)
          const ohlcv5m = await fetchOhlcv(symbol, '5m', 120)

          const baseSym = symbol.split('/')[0]
          const newsBoost =
            useAppStore.getState().newsSettings.scoreInfluence
              ? useAppStore.getState().newsIntel.coinSentiments[baseSym]
                  ?.scoreBoost
              : undefined

          const currentPrice1h = ohlcv1h[ohlcv1h.length - 1]?.[4] ?? 0
          let liquidityMap: LiquidityMap | undefined
          try {
            if (ohlcv1h.length >= 30 && currentPrice1h > 0) {
              liquidityMap = buildLiquidityMap(
                ohlcv1h,
                currentPrice1h,
                symbol,
                '1h'
              )
            }
          } catch (liqErr) {
            logger.warn(`LiquidityMap error ${symbol}`, liqErr)
          }

          if (liquidityMap) {
            setLiquidityMap(symbol, liquidityMap)
          }

          // ── Session DNA ──────────────────────────────────────────────────
          try {
            if (ohlcv1h.length >= 200) {
              const dna = analyzeSessionDNA(ohlcv1h, symbol)
              setSessionDNA(symbol, dna)
            }
          } catch (dnaErr) {
            logger.warn(`SessionDNA error ${symbol}`, dnaErr)
          }

          // ── PO3 Analysis ─────────────────────────────────────────────────
          try {
            if (ohlcv1h.length >= 24 && currentPrice1h > 0) {
              const po3 = analyzePO3(ohlcv1h, currentPrice1h)
              setPO3Analysis(symbol, po3)
            }
          } catch (po3Err) {
            logger.warn(`PO3 error ${symbol}`, po3Err)
          }

          const { signal, triggered } = analyzeSymbol({
            internalSymbol: symbol,
            ohlcv4h,
            ohlcv1h,
            ohlcv15m,
            priceChange24h: tickerMap.get(symbol) ?? 0,
            dailyBias,
            btcTrend,
            newsSentimentBoost: newsBoost,
            liquidityMap,
            btcOhlcv1h:
              btc1hRef.current.length > 25 ? btc1hRef.current : undefined,
            ohlcv5m: ohlcv5m.length >= 15 ? ohlcv5m : undefined,
          })

          // Respect cooldown for triggered setups (still show soft rows)
          if (triggered && !onCooldown) {
            cooldownRef.current[symbol] = Date.now()
            logger.info(`Signal ${signal.direction} ${symbol} score=${signal.score}`)
          } else if (triggered && onCooldown) {
            signal.hasActiveSetup = false
          }

          results.push(signal)

          updateTicker({
            symbol: signal.symbol,
            price: signal.price,
            priceChange24h: signal.priceChange24h,
            volume24h: 0,
            high24h: signal.price,
            low24h: signal.price,
            timestamp: Date.now(),
          })
        } catch (err) {
          logger.warn(`Scan error ${symbol}`, err)
        }
      }

      // Sort: active setups first, then by probability
      results.sort((a, b) => {
        if (a.hasActiveSetup !== b.hasActiveSetup) return a.hasActiveSetup ? -1 : 1
        return b.probabilityPct - a.probabilityPct
      })

      updateSignals(results)
      setMarketContext({
        ...ctxBase,
        lastScanAt: Date.now(),
        scanProgress: `Готово — ${results.filter((r) => r.hasActiveSetup).length} сетапов`,
      })
      setConnectionStatus('POLLING')
    } catch (err) {
      logger.error('Scan cycle failed', err)
      setConnectionStatus('OFFLINE')
    } finally {
      setScanning(false)
    }
  }, [
    setScanning,
    setMarketContext,
    setConnectionStatus,
    updateSignals,
    updateTicker,
    syncWatchlist,
    setLiquidityMap,
    setSessionDNA,
    setPO3Analysis,
  ])

  useEffect(() => {
    isMountedRef.current = true
    let cancelled = false

    const boot = async () => {
      syncWatchlist()
      await refreshTickers()
      if (cancelled) return

      while (isMountedRef.current && !cancelled) {
        await runScanCycle()
        if (cancelled || !isMountedRef.current) break
        for (let s = 0; s < SCAN_PAUSE_MS / 1000; s++) {
          if (!isMountedRef.current || cancelled) break
          await sleep(1000)
        }
      }
    }

    boot()

    const tickerInterval = setInterval(() => {
      if (isMountedRef.current) {
        syncWatchlist()
        refreshTickers()
      }
    }, TICKER_POLL_MS)

    // When user adds a coin via search — include it ASAP on next ticker poll
    const unsub = useAppStore.subscribe(
      (s) => s.extraWatchlist,
      () => {
        syncWatchlist()
      }
    )

    return () => {
      cancelled = true
      isMountedRef.current = false
      clearInterval(tickerInterval)
      unsub()
    }
  }, [refreshTickers, runScanCycle, syncWatchlist])

  return {
    isScanning: useAppStore((s) => s.isScanning),
  }
}

```

## 6. src/store/useAppStore.ts (полный файл)

```typescript
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type {
  AppState,
  LiveTicker,
  CoinSignal,
  LiquidityMap,
  MarketContext,
  PO3Analysis,
  SessionDNA,
  TapeMomentumState,
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
    sessionDNA: {},
    tapeMomentum: {},
    po3Analysis: {},

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

    setSessionDNA: (internalSymbol: string, dna: SessionDNA) =>
      set((state) => ({
        sessionDNA: {
          ...state.sessionDNA,
          [internalSymbol]: dna,
        },
      })),

    setTapeMomentum: (symbol: string, momentum: TapeMomentumState) =>
      set((state) => ({
        tapeMomentum: { ...state.tapeMomentum, [symbol]: momentum },
      })),

    setPO3Analysis: (symbol: string, analysis: PO3Analysis) =>
      set((state) => ({
        po3Analysis: { ...state.po3Analysis, [symbol]: analysis },
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

## 7. src/components/tactical/TacticalDrawer.tsx (полный файл)

```typescript
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
  PO3Analysis,
  SessionDNA,
  TapeMomentumState,
  WhaleWatcherState,
} from '../../engine/types'
import { formatWhaleVolume } from '../../engine/orderbook/whaleDetector'
import WhaleAlertBanner from './WhaleAlertBanner'
import SessionDNAPanel from './SessionDNAPanel'
import LTFAlignmentPanel from './LTFAlignmentPanel'
import PO3Panel from './PO3Panel'
import TapeMomentumIndicator from './TapeMomentumIndicator'

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
  const sessionDNA = useAppStore((state) => state.sessionDNA)
  const po3Store = useAppStore((state) => state.po3Analysis)
  const tapeStore = useAppStore((state) => state.tapeMomentum)

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
  const dna: SessionDNA | null = signal
    ? sessionDNA[signal.internalSymbol] ?? null
    : null
  const po3: PO3Analysis | null = signal
    ? po3Store[signal.internalSymbol] ?? null
    : null
  const tape: TapeMomentumState | null = signal
    ? tapeStore[signal.internalSymbol] ?? null
    : null
  const hasLTF = !!(
    signal?.mss?.detected ||
    (signal?.raid && signal.raid.type !== 'NONE') ||
    signal?.ote?.isActive
  )

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
          {dna && <SessionDNAPanel dna={dna} />}
          {po3 && <PO3Panel analysis={po3} />}
          {tape && tape.signal !== 'NEUTRAL' && (
            <TapeMomentumIndicator momentum={tape} />
          )}
          {hasLTF && (
            <LTFAlignmentPanel
              mss={signal.mss ?? null}
              raid={signal.raid ?? null}
              ote={signal.ote ?? null}
            />
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

## 8. src/components/tactical/LiveChart.tsx (полный файл)

```typescript
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type LineData,
  type Time,
} from 'lightweight-charts'
import { useTranslation } from 'react-i18next'
import { Settings, Eye } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import type { EqualLevel } from '../../engine/types'
import {
  CHART_TIMEFRAMES,
  fetchOhlcv,
  type MexcTimeframe,
  type OhlcvCandle,
} from '../../api/mexc'
import type { CoinSignal } from '../../engine/types'
import { logger } from '../../utils/logger'
import { useChartIndicators } from '../../hooks/useChartIndicators'
import { useChartZones } from '../../hooks/useChartZones'
import { useMultiTFAnalysis } from '../../hooks/useMultiTFAnalysis'
import { usePriceForecast } from '../../hooks/usePriceForecast'
import ChartSettings from './ChartSettings'
import ChartOverlay from './ChartOverlay'
import SessionOverlay from './SessionOverlay'
import VolumePanel from './VolumePanel'
import OscillatorPanel from './OscillatorPanel'
import MultiTFPanel from './MultiTFPanel'
import PredictionOverlay from './PredictionOverlay'
import ScenarioLegend from './ScenarioLegend'
import { useSessionData } from '../../hooks/useSessionData'
import { SESSION_DEFINITIONS, getSessionAtHour } from '../../engine/sessions/sessionMap'

interface LiveChartProps {
  symbol: string
  flatSymbol: string
  signal?: CoinSignal | null
}

const CANDLE_LIMIT: Record<MexcTimeframe, number> = {
  '1m': 120,
  '5m': 120,
  '15m': 120,
  '1h': 120,
  '4h': 100,
  '1d': 90,
}

const INDICATOR_COLORS: Record<string, string> = {
  ema20: '#3b82f6',
  ema50: '#f59e0b',
  ema200: '#ef4444',
  sma9: '#8b5cf6',
  sma21: '#06b6d4',
  sma50: '#10b981',
  bb_upper: '#64748b',
  bb_middle: '#94a3b8',
  bb_lower: '#64748b',
  vwap: '#f97316',
}

const CHART_HEIGHT = 260

const LiveChart = ({ symbol, flatSymbol, signal = null }: LiveChartProps) => {
  const { t } = useTranslation()

  const ticker = useAppStore((s) => s.liveTickets[flatSymbol])
  const chartPreferences = useAppStore((s) => s.chartPreferences)
  const sessionSettings = useAppStore((s) => s.sessionSettings)
  const eqLiquidityMap = useAppStore((s) => s.liquidityMaps[symbol] ?? null)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const lineRefs = useRef<Record<string, ISeriesApi<'Line'>>>({})
  const priceLineRefs = useRef<IPriceLine[]>([])
  const liqLineRefs = useRef<IPriceLine[]>([])

  const [timeframe, setTimeframe] = useState<MexcTimeframe>('1h')
  const [candles, setCandles] = useState<OhlcvCandle[]>([])
  const [lwcData, setLwcData] = useState<CandlestickData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [chartReady, setChartReady] = useState(0)
  const [chartInstance, setChartInstance] = useState<IChartApi | null>(null)
  const [showForecast, setShowForecast] = useState(true)
  const [activeScenarios, setActiveScenarios] = useState<Set<string>>(
    () => new Set(['A', 'B', 'C'])
  )

  const currentPrice = signal?.price ?? ticker?.price ?? 0

  const indicators = useChartIndicators(candles, chartPreferences.indicators)
  const { liquidityZones, priceLevels } = useChartZones(candles, chartPreferences.zones)

  const { alignment, liquidityMap, isLoading: mtfLoading } = useMultiTFAnalysis(
    symbol,
    currentPrice,
    true
  )

  const forecast = usePriceForecast(
    candles,
    alignment,
    liquidityMap,
    currentPrice,
    symbol,
    timeframe
  )

  const { sessions, weekends, news } = useSessionData(
    chartInstance,
    timeframe,
    sessionSettings
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setCandles([])
    setLwcData([])

    const load = async () => {
      try {
        const data = await fetchOhlcv(symbol, timeframe, CANDLE_LIMIT[timeframe])
        if (cancelled) return
        if (!data.length) {
          setError(t('chart_empty'))
          return
        }

        const mapped: CandlestickData[] = data.map((c) => ({
          time: (c[0] / 1000) as Time,
          open: c[1],
          high: c[2],
          low: c[3],
          close: c[4],
        }))
        setCandles(data)
        setLwcData(mapped)
      } catch (err) {
        logger.warn('LiveChart klines failed', err)
        if (!cancelled) setError(t('chart_error'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [symbol, timeframe, t])

  useEffect(() => {
    if (!containerRef.current || chartRef.current) return

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#111111' },
        textColor: '#e0e0e080',
      },
      grid: {
        vertLines: { color: '#1a1a1a' },
        horzLines: { color: '#1a1a1a' },
      },
      crosshair: { mode: 0 },
      timeScale: {
        borderColor: '#2a2a2a',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: { borderColor: '#2a2a2a' },
      width: containerRef.current.clientWidth,
      height: CHART_HEIGHT,
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    })

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#00ff41',
      downColor: '#ff003c',
      borderUpColor: '#00ff41',
      borderDownColor: '#ff003c',
      wickUpColor: '#00ff4180',
      wickDownColor: '#ff003c80',
    })

    chartRef.current = chart
    candleRef.current = candleSeries
    setChartInstance(chart)
    setChartReady((n) => n + 1)

    const ro = new ResizeObserver((entries) => {
      if (!entries.length) return
      chart.applyOptions({
        width: entries[0].contentRect.width,
        height: CHART_HEIGHT,
      })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      Object.values(lineRefs.current).forEach((s) => {
        try {
          chart.removeSeries(s)
        } catch {
          /* ignore */
        }
      })
      lineRefs.current = {}
      priceLineRefs.current = []
      liqLineRefs.current = []
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      setChartInstance(null)
    }
  }, [])

  useEffect(() => {
    if (!candleRef.current || !lwcData.length) return
    candleRef.current.setData(lwcData)
    chartRef.current?.timeScale().fitContent()
  }, [lwcData])

  useEffect(() => {
    if (!candleRef.current || !ticker || !lwcData.length) return
    if (timeframe === '4h' || timeframe === '1d') return

    const last = lwcData[lwcData.length - 1]
    const p = ticker.price
    if (Math.abs(last.close - p) < Number.EPSILON) return

    candleRef.current.update({
      ...last,
      close: p,
      high: Math.max(last.high, p),
      low: Math.min(last.low, p),
    })
  }, [ticker?.price, lwcData, timeframe])

  const updateLineSeries = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return

    const seriesMap: Record<string, LineData[]> = {
      ema20: indicators.ema20,
      ema50: indicators.ema50,
      ema200: indicators.ema200,
      sma9: indicators.sma9,
      sma21: indicators.sma21,
      sma50: indicators.sma50,
      vwap: indicators.vwap,
      bb_upper: indicators.bollingerBands.map((p) => ({
        time: p.time,
        value: p.upper,
      })),
      bb_middle: indicators.bollingerBands.map((p) => ({
        time: p.time,
        value: p.middle,
      })),
      bb_lower: indicators.bollingerBands.map((p) => ({
        time: p.time,
        value: p.lower,
      })),
    }

    Object.entries(seriesMap).forEach(([key, data]) => {
      if (data.length === 0) {
        if (lineRefs.current[key]) {
          try {
            chart.removeSeries(lineRefs.current[key])
          } catch {
            /* ignore */
          }
          delete lineRefs.current[key]
        }
        return
      }

      if (!lineRefs.current[key]) {
        const isDashed = key.startsWith('bb_')
        lineRefs.current[key] = chart.addLineSeries({
          color: INDICATOR_COLORS[key] ?? '#fff',
          lineWidth: key === 'ema200' ? 2 : 1,
          lineStyle: isDashed ? 2 : 0,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
          priceLineVisible: false,
        })
      }

      lineRefs.current[key].setData(data)
    })
  }, [indicators])

  useEffect(() => {
    updateLineSeries()
  }, [updateLineSeries, chartReady])

  useEffect(() => {
    const series = candleRef.current
    if (!series) return

    for (const line of priceLineRefs.current) {
      try {
        series.removePriceLine(line)
      } catch {
        /* ignore */
      }
    }
    priceLineRefs.current = []

    const addLine = (
      price: number,
      color: string,
      title: string,
      lineStyle: 0 | 1 | 2 | 3 | 4 = 2
    ) => {
      try {
        const line = series.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle,
          axisLabelVisible: true,
          title: chartPreferences.showLabels ? title : '',
        })
        priceLineRefs.current.push(line)
      } catch {
        /* ignore */
      }
    }

    for (const level of priceLevels) {
      addLine(level.price, level.color, level.label, level.lineStyle ?? 2)
    }

    if (signal?.sl != null) addLine(signal.sl, 'rgba(239, 68, 68, 0.8)', 'SL')
    if (signal?.tp1 != null) addLine(signal.tp1, 'rgba(34, 197, 94, 0.8)', 'TP1')
    if (signal?.tp2 != null) addLine(signal.tp2, 'rgba(34, 197, 94, 0.6)', 'TP2')
    if (signal?.tpDaily != null) {
      addLine(signal.tpDaily, 'rgba(100, 200, 255, 0.7)', 'TP Daily')
    }
  }, [priceLevels, chartPreferences.showLabels, chartReady, lwcData, signal])

  // ── Liquidity Map: Equal Highs / Equal Lows линии ──────────────────────────
  useEffect(() => {
    const series = candleRef.current
    if (!series) return

    for (const line of liqLineRefs.current) {
      try {
        series.removePriceLine(line)
      } catch {
        /* ignore */
      }
    }
    liqLineRefs.current = []

    if (!eqLiquidityMap) return

    const drawLiqLevel = (level: EqualLevel) => {
      const isBSL = level.type === 'HIGH'

      const colorMap = {
        STRONG: isBSL ? 'rgba(251, 191, 36, 0.9)' : 'rgba(168, 85, 247, 0.9)',
        MEDIUM: isBSL ? 'rgba(251, 191, 36, 0.6)' : 'rgba(168, 85, 247, 0.6)',
        WEAK: isBSL ? 'rgba(251, 191, 36, 0.35)' : 'rgba(168, 85, 247, 0.35)',
      }

      const color = level.isActive
        ? colorMap[level.strength]
        : 'rgba(100, 100, 100, 0.3)'

      const styleMap: Record<string, 0 | 1 | 2 | 3> = {
        STRONG: 0,
        MEDIUM: 2,
        WEAK: 3,
      }
      const lineStyle = styleMap[level.strength]

      const typeLabel = isBSL ? 'BSL' : 'SSL'
      const touchLabel = `×${level.touches}`
      const distLabel = `${level.distancePct.toFixed(1)}%`
      const title = chartPreferences.showLabels
        ? `${typeLabel} ${touchLabel} ${distLabel}`
        : ''

      try {
        const line = series.createPriceLine({
          price: level.price,
          color,
          lineWidth: level.strength === 'STRONG' ? 2 : 1,
          lineStyle,
          axisLabelVisible: true,
          title,
        })
        liqLineRefs.current.push(line)
      } catch {
        /* ignore */
      }
    }

    for (const level of eqLiquidityMap.equalHighs) {
      drawLiqLevel(level)
    }
    for (const level of eqLiquidityMap.equalLows) {
      drawLiqLevel(level)
    }
  }, [eqLiquidityMap, chartPreferences.showLabels, chartReady, lwcData])

  const oscillators: Array<'rsi' | 'macd' | 'stochastic' | 'atr'> = []
  if (chartPreferences.indicators.rsi) oscillators.push('rsi')
  if (chartPreferences.indicators.macd) oscillators.push('macd')
  if (chartPreferences.indicators.stochastic) oscillators.push('stochastic')
  if (chartPreferences.indicators.atr) oscillators.push('atr')

  const toggleScenario = (id: string) => {
    setActiveScenarios((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const liveSession = SESSION_DEFINITIONS[getSessionAtHour(new Date().getUTCHours())]
  const liveSessionBg = liveSession.lineColor.replace(
    /rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)/,
    'rgba($1, $2, $3, 0.9)'
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-wider text-holo/40">
            {t('chart_title')}
          </span>
          {sessionSettings.enabled && (
            <span
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-black"
              style={{ backgroundColor: liveSessionBg }}
              title="Текущая торговая сессия (UTC)"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-black/70" />
              {liveSession.label}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {CHART_TIMEFRAMES.map((tf) => (
            <button
              key={tf.id}
              type="button"
              onClick={() => setTimeframe(tf.id)}
              className={`rounded px-2 py-1 font-mono text-xs transition-colors ${
                timeframe === tf.id
                  ? 'border border-matrix/50 bg-matrix/20 text-matrix'
                  : 'border border-transparent text-holo/40 hover:bg-hull-light hover:text-holo/70'
              }`}
            >
              {tf.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowForecast((v) => !v)}
            className={`rounded-lg p-1.5 transition-colors ${
              showForecast
                ? 'bg-holo/20 text-holo'
                : 'bg-hull-light/40 text-holo/60 hover:bg-hull-light/70 hover:text-holo'
            }`}
            title={t('forecast_toggle')}
          >
            <Eye className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg bg-hull-light/40 p-1.5 text-holo/60 transition-colors hover:bg-hull-light/70 hover:text-holo"
            title={t('chart_settings')}
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        className="relative w-full overflow-hidden rounded-lg border border-hull-border bg-hull"
        style={{ height: CHART_HEIGHT }}
      >
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-hull/60 font-mono text-xs text-holo/40">
            {t('chart_loading')}
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center font-mono text-xs text-alert/80">
            {error}
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" />
        {chartReady > 0 && sessionSettings.enabled && (
          <SessionOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            sessions={sessions}
            weekends={weekends}
            news={news}
            settings={sessionSettings}
            timeframe={timeframe}
          />
        )}
        {liquidityZones.length > 0 && chartReady > 0 && (
          <ChartOverlay
            chart={chartRef.current}
            series={candleRef.current}
            zones={liquidityZones}
            containerRef={containerRef}
            opacity={chartPreferences.opacity}
            showLabels={chartPreferences.showLabels}
          />
        )}
        {showForecast && forecast && chartReady > 0 && (
          <PredictionOverlay
            chart={chartRef.current}
            series={candleRef.current}
            forecast={forecast}
            activeScenarios={activeScenarios}
            containerRef={containerRef}
          />
        )}
      </div>

      {chartPreferences.indicators.volume && indicators.volume.length > 0 && (
        <VolumePanel volumeData={indicators.volume} height={50} />
      )}

      {oscillators.map((mode) => (
        <OscillatorPanel
          key={mode}
          mode={mode}
          rsiData={indicators.rsi}
          macdData={indicators.macd}
          stochasticData={indicators.stochastic}
          atrData={indicators.atr}
          height={80}
        />
      ))}

      <MultiTFPanel alignment={alignment} isLoading={mtfLoading} />

      {showForecast && forecast && (
        <ScenarioLegend
          scenarios={forecast.scenarios}
          dominantId={forecast.dominantScenario}
          activeScenarios={activeScenarios}
          onToggle={toggleScenario}
        />
      )}

      <ChartSettings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

export default LiveChart

```

## 9. src/components/tactical/DataLog.tsx (полный файл)

```typescript
import { useState, useEffect } from 'react'
import { Terminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CoinSignal } from '../../engine/types'

interface DataLogProps {
  signal: CoinSignal
}

const DataLog = ({ signal }: DataLogProps) => {
  const { t } = useTranslation()
  const [visibleLines, setVisibleLines] = useState(0)

  const lines: string[] = []

  if (signal.probabilityPct > 0 || signal.hasActiveSetup) {
    lines.push(`> ${t('log_score')}: ${signal.score}/10`)
    lines.push(`> ${t('log_probability')}: ${signal.probabilityPct}%`)
    if (signal.direction) {
      lines.push(
        `> ${t('log_direction')}: ${
          signal.direction === 'LONG' ? t('signal_long') : t('signal_short')
        }`
      )
    }
    if (signal.currentRSI !== null) {
      lines.push(`> RSI(14): ${signal.currentRSI.toFixed(1)}`)
    }
    if (signal.zones.length) {
      lines.push(`> ${t('log_zones')}: ${signal.zones.join(' | ')}`)
    }
    if (signal.btcDivergence && signal.btcDivergence.type !== 'NONE') {
      lines.push(`> BTC Div: ${signal.btcDivergence.label}`)
    }
    if (signal.sl != null) {
      lines.push(`> SL: ${signal.sl}`)
    }
    if (signal.tp1 != null) {
      lines.push(`> TP1: ${signal.tp1} | TP2: ${signal.tp2}`)
    }
    if (signal.dailyPattern) {
      lines.push(`> ${t('log_daily')}: ${signal.dailyPattern}`)
    }
    if (signal.hasActiveSetup) {
      lines.push(`> ${t('log_status_active')}`)
    }
  } else {
    lines.push(`> ${t('tactical_no_data')}`)
  }

  useEffect(() => {
    setVisibleLines(0)
    const timers: ReturnType<typeof setTimeout>[] = []

    lines.forEach((_, index) => {
      const timer = setTimeout(() => {
        setVisibleLines(index + 1)
      }, index * 200)
      timers.push(timer)
    })

    return () => {
      timers.forEach((timer) => clearTimeout(timer))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal.symbol, signal.score, signal.probabilityPct])

  return (
    <div className="bg-hull border border-hull-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <Terminal className="w-4 h-4 text-holo/40" />
        <span className="text-xs text-holo/40 font-mono uppercase tracking-widest">
          {t('tactical_log_title')}
        </span>
      </div>

      <div className="space-y-1 font-mono text-sm text-matrix/80">
        {lines.map((line, index) => (
          <div
            key={index}
            className={`${
              index < visibleLines ? 'opacity-100' : 'opacity-0'
            } transition-opacity duration-100`}
          >
            {line}
            {index === visibleLines - 1 && index === lines.length - 1 && (
              <span className="inline-block w-2 h-4 bg-matrix/80 ml-1 animate-pulse" />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default DataLog

```

## 10. vite.config.ts (полный файл)

```typescript
// @ts-nocheck
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const RSS_ALLOWED = [
  'coindesk.com',
  'cointelegraph.com',
  'decrypt.co',
  'theblock.co',
]

/** Dev middleware: /news/rss?url=… → whitelist fetch */
function newsRssProxy(): Plugin {
  return {
    name: 'news-rss-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? ''
        if (!rawUrl.startsWith('/news/rss')) {
          next()
          return
        }

        void (async () => {
          try {
            const full = new URL(rawUrl, 'http://localhost')
            const rssUrl = full.searchParams.get('url')
            if (!rssUrl) {
              res.statusCode = 400
              res.end('Missing url param')
              return
            }
            const parsed = new URL(rssUrl)
            if (!RSS_ALLOWED.some((d) => parsed.hostname.indexOf(d) !== -1)) {
              res.statusCode = 403
              res.end('Domain not allowed')
              return
            }
            const upstream = await fetch(rssUrl, {
              headers: {
                Accept: 'application/rss+xml, text/xml, */*',
                'User-Agent': 'EnterpriseSystem/2.0',
              },
            })
            const body = new Uint8Array(await upstream.arrayBuffer())
            res.statusCode = upstream.status
            res.setHeader(
              'Content-Type',
              upstream.headers.get('Content-Type') || 'application/xml'
            )
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(body)
          } catch (err) {
            res.statusCode = 502
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                success: false,
                message: err instanceof Error ? err.message : 'Proxy error',
              })
            )
          }
        })()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), newsRssProxy()],
  base: './',
  server: {
    proxy: {
      '/mexc': {
        target: 'https://contract.mexc.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/mexc/, ''),
      },
      '/news/panic': {
        target: 'https://cryptopanic.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/news\/panic/, ''),
      },
      '/news/fg': {
        target: 'https://api.alternative.me',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/news\/fg/, ''),
      },
    },
  },
  optimizeDeps: {
    include: [
      'three',
      '@react-three/fiber',
      '@react-three/drei',
      'lightweight-charts',
    ],
  },
  build: {
    target: 'es2020',
    minify: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'chart-vendor': ['lightweight-charts'],
          'three-vendor': ['three', '@react-three/fiber', '@react-three/drei'],
          'i18n-vendor': [
            'i18next',
            'react-i18next',
            'i18next-browser-languagedetector',
          ],
        },
      },
    },
  },
})

```

## Примечания

### useMexcScanner — передача свечей в engine/smc

1. Загрузка: ohlcv4h (100), ohlcv1h (720), ohlcv15m (50), ohlcv5m (120)
2. Прямые вызовы smc: buildLiquidityMap, analyzePO3; sessions: analyzeSessionDNA
3. analyzeSymbol({ ohlcv4h, ohlcv1h, ohlcv15m, ohlcv5m }) → detectMarketStructure, findOrderBlocks, findFvg, detectMSS, detectLiquidityRaid, calculateOTEZone
4. BTC: ohlcv1d → resolveDailyBias; btc4h/btc1h → trend; btc1hRef → calculateBtcDivergence

### useAppStore — сигналы

- signals: CoinSignal[] — полная замена через updateSignals после скана
- upsertSignal — точечное обновление с сортировкой (hasActiveSetup desc, probabilityPct desc)

### TacticalDrawer

- Store: selectedCoin, signals, liquidityMaps, whaleWatcher, sessionDNA, po3Analysis, tapeMomentum, newsSettings, newsIntel
- SL/TP: grid-карточки signal.sl / tp1 / tp2
- DataLog: внизу drawer, terminal-style лог из signal

### LiveChart — Lightweight Charts

- createChart + addCandlestickSeries из lightweight-charts
- Маркеры: createPriceLine (SL/TP/уровни/ликвидность), ChartOverlay (zones), SessionOverlay, PredictionOverlay
- setMarkers на свечах не используется

### vite.config.ts — proxy

- /mexc → https://contract.mexc.com (MEXC API)
- /news/panic → cryptopanic.com
- /news/fg → api.alternative.me
- /news/rss — dev middleware (whitelist RSS)
