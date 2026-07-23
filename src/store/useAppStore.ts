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
  BuyerAggressionResult,
  ActiveTrade,
  TradeEvent,
  TradeStatus,
  MemeSignal,
  MemeUniverseMeta,
  MmIntentSnapshot,
  SpoofAlertSnapshot,
  IcebergAlertSnapshot,
  ObDeltaStoreSnapshot,
} from '../engine/types'
import type { WatchedSetup } from '../engine/setups'
import type { ChartPreferences } from '../engine/indicators/types'
import { DEFAULT_CHART_PREFERENCES } from '../engine/indicators/types'
import type { SessionSettings } from '../engine/sessions/types'
import { DEFAULT_SESSION_SETTINGS } from '../engine/sessions/types'
import type { NewsSettings } from '../engine/sentiment/types'
import {
  DEFAULT_NEWS_SETTINGS,
  EMPTY_NEWS_INTEL,
} from '../engine/sentiment/types'
import {
  DEFAULT_TELEGRAM_ALERT_SETTINGS,
  TELEGRAM_ALERT_SETTINGS_KEY,
  type TelegramAlertSettings,
} from '../engine/telegram/types'
import {
  linkTradeToJournal,
  resolveJournalByTrade,
} from '../engine/journal'
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
const ACTIVE_TRADES_KEY = 'enterprise_active_trades'
const WATCHED_SETUPS_KEY = 'enterprise_watched_setups'

function loadWatchedSetups(): WatchedSetup[] {
  try {
    const saved = localStorage.getItem(WATCHED_SETUPS_KEY)
    if (!saved) return []
    const parsed = JSON.parse(saved) as WatchedSetup[]
    const now = Date.now()
    return parsed.filter((w) => w.expiresAt > now)
  } catch {
    return []
  }
}

function saveWatchedSetups(watches: WatchedSetup[]) {
  try {
    localStorage.setItem(WATCHED_SETUPS_KEY, JSON.stringify(watches))
  } catch {
    /* ignore */
  }
}

function loadActiveTrades(): ActiveTrade[] {
  try {
    const saved = localStorage.getItem(ACTIVE_TRADES_KEY)
    if (!saved) return []
    const parsed = JSON.parse(saved) as ActiveTrade[]
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    return parsed.filter((t) => t.createdAt > weekAgo)
  } catch {
    return []
  }
}

function saveActiveTrades(trades: ActiveTrade[]) {
  try {
    localStorage.setItem(ACTIVE_TRADES_KEY, JSON.stringify(trades))
  } catch {
    /* ignore */
  }
}

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

function loadTelegramAlertSettings(): TelegramAlertSettings {
  try {
    const saved = localStorage.getItem(TELEGRAM_ALERT_SETTINGS_KEY)
    return saved
      ? { ...DEFAULT_TELEGRAM_ALERT_SETTINGS, ...JSON.parse(saved) }
      : DEFAULT_TELEGRAM_ALERT_SETTINGS
  } catch {
    return DEFAULT_TELEGRAM_ALERT_SETTINGS
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
    telegramAlertSettings: loadTelegramAlertSettings(),
    liquidityMaps: {},
    whaleWatcher: {},
    sessionDNA: {},
    tapeMomentum: {},
    po3Analysis: {},
    buyerAggression: {},
    activeTrades: loadActiveTrades(),
    memeSignals: [],
    memeUniverse: null,
    journalVersion: 0,
    orderBookMetrics: {},
    mmIntent: {},
    surgicalEntries: {},
    spoofAlerts: {},
    icebergAlerts: {},
    obDelta: {},
    watchedSetups: loadWatchedSetups(),

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
      // Keep list order stable — re-sorting on every meme/live upsert makes rows jump.
      // Full scan still sorts once via updateSignals.
      set((state) => {
        const idx = state.signals.findIndex((s) => s.symbol === signal.symbol)
        const next =
          idx >= 0
            ? state.signals.map((s, i) => (i === idx ? signal : s))
            : [...state.signals, signal]
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

    setTelegramAlertSettings: (partial) =>
      set((state) => {
        const next = { ...state.telegramAlertSettings, ...partial }
        try {
          localStorage.setItem(TELEGRAM_ALERT_SETTINGS_KEY, JSON.stringify(next))
        } catch {
          /* ignore */
        }
        return { telegramAlertSettings: next }
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

    setBuyerAggression: (symbol: string, result: BuyerAggressionResult) =>
      set((state) => ({
        buyerAggression: { ...state.buyerAggression, [symbol]: result },
      })),

    addTrade: (trade) => {
      const newTrade: ActiveTrade = {
        ...trade,
        id: crypto.randomUUID(),
        events: [
          {
            type: 'ENTRY',
            timestamp: Date.now(),
            price: trade.entryPrice,
            message: `Вход в ${trade.direction} @ ${trade.entryPrice}`,
          },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      linkTradeToJournal(newTrade.id, {
        internalSymbol: newTrade.internalSymbol,
        direction: newTrade.direction,
        entryPrice: newTrade.entryPrice,
        isMeme: newTrade.isMemeTrade,
      })

      set((state) => {
        const next = [...state.activeTrades, newTrade]
        saveActiveTrades(next)
        return {
          activeTrades: next,
          journalVersion: state.journalVersion + 1,
        }
      })
    },

    updateTrade: (id, updates) => {
      set((state) => {
        const next = state.activeTrades.map((t) =>
          t.id === id ? { ...t, ...updates, updatedAt: Date.now() } : t
        )
        saveActiveTrades(next)
        return { activeTrades: next }
      })
    },

    addTradeEvent: (id, event) => {
      const fullEvent: TradeEvent = { ...event, timestamp: Date.now() }
      set((state) => {
        const next = state.activeTrades.map((t) =>
          t.id === id
            ? {
                ...t,
                events: [...t.events, fullEvent],
                updatedAt: Date.now(),
              }
            : t
        )
        saveActiveTrades(next)
        return { activeTrades: next }
      })
    },

    closeTrade: (id, reason, price) => {
      const trade = get().activeTrades.find((t) => t.id === id)
      if (!trade) return

      const status: TradeStatus =
        reason === 'WIN'
          ? 'CLOSED_WIN'
          : reason === 'LOSS'
            ? 'CLOSED_LOSS'
            : trade.pnlPercent >= 0
              ? 'CLOSED_WIN'
              : 'CLOSED_LOSS'

      const pnlPercent =
        trade.direction === 'LONG'
          ? ((price - trade.entryPrice) / trade.entryPrice) * 100
          : ((trade.entryPrice - price) / trade.entryPrice) * 100

      const eventType: TradeEvent['type'] =
        reason === 'WIN'
          ? 'TP1_HIT'
          : reason === 'LOSS'
            ? 'SL_HIT'
            : 'MANUAL_CLOSE'

      const closeEvent: TradeEvent = {
        type: eventType,
        timestamp: Date.now(),
        price,
        message: `Закрыто ${reason} @ ${price} (P&L: ${pnlPercent.toFixed(2)}%)`,
      }

      set((state) => {
        const next: ActiveTrade[] = state.activeTrades.map((t) =>
          t.id === id
            ? {
                ...t,
                status,
                currentPrice: price,
                pnlPercent,
                updatedAt: Date.now(),
                events: [...t.events, closeEvent],
              }
            : t
        )
        saveActiveTrades(next)

        resolveJournalByTrade(
          id,
          reason === 'WIN' ? 'WIN' : reason === 'LOSS' ? 'LOSS' : 'MANUAL',
          price
        )

        return {
          activeTrades: next,
          journalVersion: state.journalVersion + 1,
        }
      })
    },

    updateMemeSignal: (signal: MemeSignal) => {
      set((state) => {
        const idx = state.memeSignals.findIndex((s) => s.symbol === signal.symbol)
        const next =
          idx >= 0
            ? state.memeSignals.map((s, i) => (i === idx ? signal : s))
            : [...state.memeSignals, signal]

        next.sort((a, b) => {
          const qualityOrder = { CRITICAL: 0, STRONG: 1, MODERATE: 2, WEAK: 3 }
          if (a.quality !== b.quality) {
            return qualityOrder[a.quality] - qualityOrder[b.quality]
          }
          return b.heatScore - a.heatScore
        })

        return { memeSignals: next }
      })
    },

    updateMemeSignals: (signals: MemeSignal[]) => {
      const sorted = signals.slice().sort((a, b) => {
        const qualityOrder = { CRITICAL: 0, STRONG: 1, MODERATE: 2, WEAK: 3 }
        if (a.quality !== b.quality) {
          return qualityOrder[a.quality] - qualityOrder[b.quality]
        }
        return b.heatScore - a.heatScore
      })
      set({ memeSignals: sorted })
    },

    setMemeUniverse: (meta: MemeUniverseMeta) => {
      set({ memeUniverse: meta })
    },

    bumpJournalVersion: () => {
      set((state) => ({ journalVersion: state.journalVersion + 1 }))
    },

    setOrderBookMetrics: (symbol, metrics) => {
      set((state) => ({
        orderBookMetrics: { ...state.orderBookMetrics, [symbol]: metrics },
      }))
    },

    setMmIntent: (symbol: string, intent: MmIntentSnapshot) => {
      set((state) => ({
        mmIntent: { ...state.mmIntent, [symbol]: intent },
      }))
    },

    setSurgicalEntry: (symbol: string, entry) => {
      set((state) => ({
        surgicalEntries: { ...state.surgicalEntries, [symbol]: entry },
      }))
    },

    setSpoofAlerts: (symbol: string, alerts: SpoofAlertSnapshot[]) => {
      const now = Date.now()
      const pruned = alerts.filter((a) => now - a.updatedAt < 30_000)
      set((state) => ({
        spoofAlerts: { ...state.spoofAlerts, [symbol]: pruned },
      }))
    },

    setIcebergAlerts: (symbol: string, alerts: IcebergAlertSnapshot[]) => {
      const now = Date.now()
      const pruned = alerts.filter((a) => now - a.updatedAt < 60_000)
      set((state) => ({
        icebergAlerts: { ...state.icebergAlerts, [symbol]: pruned },
      }))
    },

    setObDelta: (symbol: string, delta: ObDeltaStoreSnapshot) => {
      set((state) => ({
        obDelta: { ...state.obDelta, [symbol]: delta },
      }))
    },

    setWatchedSetups: (watches) => {
      saveWatchedSetups(watches)
      set({ watchedSetups: watches })
    },

    upsertWatchedSetup: (watch) => {
      set((state) => {
        const idx = state.watchedSetups.findIndex(
          (w) => w.watchId === watch.watchId
        )
        const next =
          idx >= 0
            ? state.watchedSetups.map((w, i) => (i === idx ? watch : w))
            : [...state.watchedSetups, watch]
        saveWatchedSetups(next)
        return { watchedSetups: next }
      })
    },

    removeWatchedSetupLocal: (watchId) => {
      set((state) => {
        const next = state.watchedSetups.filter((w) => w.watchId !== watchId)
        saveWatchedSetups(next)
        return { watchedSetups: next }
      })
    },
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
