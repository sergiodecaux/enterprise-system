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
import type {
  VolumeSpikeResult,
  LiquidityGapResult,
  MeanReversionResult,
  SpreadPressureResult,
} from './meme'

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
  /** Поглощение объёма — Stopping Volume */
  absorption?: AbsorptionCandle | null
  /** LTF CHoCH на 1m + Surgical Entry */
  ltfChoCH?: LTFChoCHResult | null
  /** Buyer Aggression из ленты сделок */
  buyerAggression?: BuyerAggressionResult | null
  /** Meme Pulse данные (если сигнал из мем-сканера) */
  memePulse?: MemeSignal | null
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
  /** Buyer Aggression по символу (живые данные) */
  buyerAggression: Record<string, BuyerAggressionResult>
  setBuyerAggression: (symbol: string, result: BuyerAggressionResult) => void

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

  /** Активные сделки пользователя */
  activeTrades: ActiveTrade[]
  addTrade: (
    trade: Omit<ActiveTrade, 'id' | 'createdAt' | 'updatedAt' | 'events'>
  ) => void
  updateTrade: (id: string, updates: Partial<ActiveTrade>) => void
  closeTrade: (id: string, reason: 'WIN' | 'LOSS' | 'MANUAL', price: number) => void
  addTradeEvent: (
    id: string,
    event: Omit<TradeEvent, 'timestamp'>
  ) => void

  /** Сигналы мем-коинов */
  memeSignals: MemeSignal[]
  updateMemeSignal: (signal: MemeSignal) => void
  updateMemeSignals: (signals: MemeSignal[]) => void
}

// ============================================================================
// Meme Pulse
// ============================================================================

export interface MemeSignal {
  symbol: string
  internalSymbol: string
  displayName: string
  price: number
  priceChange24h: number
  volumeSpike: VolumeSpikeResult
  liquidityGap: LiquidityGapResult
  meanReversion: MeanReversionResult
  spreadPressure: SpreadPressureResult
  heatScore: number
  quality: 'CRITICAL' | 'STRONG' | 'MODERATE' | 'WEAK'
  recommendation: 'QUICK_ENTRY' | 'MONITOR' | 'WAIT'
  updatedAt: number
}

// ============================================================================
// Tactical Copilot — Active Trades
// ============================================================================

export type TradeStatus =
  | 'ACTIVE'
  | 'BREAKEVEN'
  | 'PARTIAL_CLOSE'
  | 'CLOSED_WIN'
  | 'CLOSED_LOSS'
  | 'INVALIDATED'

export interface TradeEvent {
  type:
    | 'ENTRY'
    | 'BREAKEVEN_REACHED'
    | 'WALL_DETECTED'
    | 'INVALIDATION'
    | 'TP1_HIT'
    | 'TP2_HIT'
    | 'SL_HIT'
    | 'MANUAL_CLOSE'
  timestamp: number
  price: number
  message: string
}

export interface ActiveTrade {
  id: string
  symbol: string
  internalSymbol: string
  direction: 'LONG' | 'SHORT'
  entryPrice: number
  entryTime: number
  sl: number
  tp1: number
  tp2: number | null
  status: TradeStatus
  currentPrice: number
  pnlPercent: number
  pnlUsd: number | null
  confidenceScore: number
  confidenceFactors: string[]
  positionSizeUsd: number | null
  breakevenAlertShown: boolean
  invalidationAlertShown: boolean
  wallAlertShown: boolean
  events: TradeEvent[]
  createdAt: number
  updatedAt: number
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
// Stopping Volume / Absorption (VSA)
// ============================================================================

export interface AbsorptionCandle {
  /** Обнаружено ли поглощение */
  detected: boolean
  /** Индекс свечи в массиве */
  candleIndex: number | null
  /** Цена свечи (low) */
  price: number | null
  /** Объём свечи */
  volume: number
  /** Отношение тела к диапазону (0..1) */
  bodyRatio: number
  /** Отношение нижнего фитиля к диапазону (0..1) */
  lowerWickRatio: number
  /** Насколько объём превышает средний (множитель) */
  volumeMultiplier: number
  /** Score-буст: +2 если detected */
  scoreBoost: number
  /** Метка для UI и DataLog */
  label: string
}

// ============================================================================
// LTF CHoCH — Change of Character (1m)
// ============================================================================

/**
 * LTF CHoCH — Change of Character на 1m графике.
 * Пробой последнего Lower High = смена инициативы с медвежьей на бычью.
 */
export interface LTFChoCHResult {
  detected: boolean
  breakLevel: number | null
  breakPrice: number | null
  breakCandleIndex: number | null
  surgicalEntryDetected: boolean
  surgicalEntryPrice: number | null
  candlesAgo: number
  scoreBoost: number
  label: string
}

// ============================================================================
// Buyer Aggression
// ============================================================================

/**
 * Buyer Aggression — анализ агрессии покупателей через ленту сделок.
 */
export interface BuyerAggressionResult {
  detected: boolean
  buyVolume: number
  sellVolume: number
  buyToSellRatio: number
  threshold: number
  largeBuyCount: number
  windowSec: number
  scoreBoost: number
  label: string
  color: 'GREEN' | 'YELLOW' | 'NEUTRAL'
  updatedAt: number
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
