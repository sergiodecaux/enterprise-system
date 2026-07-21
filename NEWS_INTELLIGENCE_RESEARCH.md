# NEWS_INTELLIGENCE_RESEARCH.md

Снимок кодовой базы для планирования **News Intelligence** (дата: 2026-07-20).  
Ниже — полный запрошенный код + краткие заметки для интеграции.

---

## 1. `src/store/useAppStore.ts` — ПОЛНЫЙ КОД

### State fields
| Поле | Тип | Persist |
|------|-----|---------|
| `liveTickets` | `Record<string, LiveTicker>` | нет |
| `signals` | `CoinSignal[]` | нет |
| `marketContext` | `MarketContext \| null` | нет |
| `isScanning` | `boolean` | нет |
| `extraWatchlist` | `string[]` | `enterprise_extra_watchlist` (load/save вручную) |
| `chartPreferences` | `ChartPreferences` | `enterprise_chart_preferences` (subscribe) |
| `sessionSettings` | `SessionSettings` | `enterprise_session_settings` (в action) |
| `selectedCoin` | `string \| null` | нет |
| `isDrawerOpen` | `boolean` | нет |
| `isProUser` | `boolean` | нет (default `true`) |
| `isConnected` | `boolean` | нет |
| `connectionStatus` | `'ONLINE' \| 'POLLING' \| 'OFFLINE'` | нет |
| `lastUpdate` | `number` | нет |

### Actions
`updateTicker`, `updateSignals`, `upsertSignal`, `setMarketContext`, `setScanning`, `addToWatchlist`, `removeFromWatchlist`, `selectCoin`, `setDrawerOpen`, `setProUser`, `setConnected`, `setConnectionStatus`, `setChartPreferences`, `setSessionSettings`

### localStorage persistence
1. **extraWatchlist** — load при init (`loadExtraWatchlist`), save в `addToWatchlist` / `removeFromWatchlist`
2. **chartPreferences** — load при init; save через `useAppStore.subscribe(state => chartPreferences, …)`
3. **sessionSettings** — load при init; save внутри `setSessionSettings`

**Для News Intelligence:** нового поля в store ещё нет — логично добавить `newsIntel` / `newsSettings` по тому же паттерну, что `sessionSettings`.

```typescript
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { AppState, LiveTicker, CoinSignal, MarketContext } from '../engine/types'
import type { ChartPreferences } from '../engine/indicators/types'
import { DEFAULT_CHART_PREFERENCES } from '../engine/indicators/types'
import type { SessionSettings } from '../engine/sessions/types'
import { DEFAULT_SESSION_SETTINGS } from '../engine/sessions/types'
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

export const useAppStore = create<AppState>()(
  subscribeWithSelector((set, get) => ({
    liveTickets: {},
    signals: [],
    marketContext: defaultMarketContext,
    isScanning: false,
    extraWatchlist: loadExtraWatchlist(),
    chartPreferences: loadChartPreferences(),
    sessionSettings: loadSessionSettings(),

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

## 2. `src/components/tactical/TacticalDrawer.tsx` — ПОЛНЫЙ КОД

### Порядок компонентов в drawer
1. Backdrop (`fixed inset-0`)
2. Drawer shell (`bottom sheet`, max 85vh)
3. Handle bar
4. **Header:** `displayName`, `price`, `priceChange24h`, badge `hasActiveSetup`, close
5. **ProbabilityGauge** (`probabilityPct`, `direction`)
6. **Grid 2×N полей signal**
7. **LiveChart**
8. **OrderBookPanel**
9. **DataLog**

### Какие поля `CoinSignal` реально показываются
| UI | Поле |
|----|------|
| Title | `displayName` |
| Price row | `price`, `priceChange24h`, `hasActiveSetup` |
| Gauge | `probabilityPct`, `direction` |
| Cards | `currentRSI`, `direction`, `score`, `coinTrend`, `sl?`, `tp1?`, `tp2?`, `dailyBias` + `dailyConfidence` |
| LiveChart | `internalSymbol`, `symbol`, весь `signal` |
| OrderBook | `internalSymbol` |
| DataLog | весь `signal` |

**Не в header UI напрямую:** `zones`, `tpDaily`, `btcTrend`, `dailyPattern`, `isLocked`, `activeSignal`, `activeSignalKey` (часть уходит в DataLog).

**Для News Intelligence:** слот после ProbabilityGauge / перед LiveChart или внутри DataLog; глобальный баннер лучше в RadarView/App.

```tsx
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import ProbabilityGauge from './ProbabilityGauge'
import LiveChart from './LiveChart'
import OrderBookPanel from './OrderBookPanel'
import DataLog from './DataLog'
import type { CoinSignal } from '../../engine/types'

const TacticalDrawer = () => {
  const { t } = useTranslation()
  const { haptic } = useTelegramWebApp()
  const selectedCoin = useAppStore((state) => state.selectedCoin)
  const isDrawerOpen = useAppStore((state) => state.isDrawerOpen)
  const signals = useAppStore((state) => state.signals)
  const setDrawerOpen = useAppStore((state) => state.setDrawerOpen)
  const selectCoin = useAppStore((state) => state.selectCoin)

  const drawerRef = useRef<HTMLDivElement>(null)

  const signal: CoinSignal | null = selectedCoin
    ? signals.find((s) => s.symbol === selectedCoin) ?? null
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

        <div className="px-4 py-6 space-y-6">
          <div className="flex justify-center">
            <ProbabilityGauge value={probability} direction={direction} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* RSI / direction / score / trend / SL / TP1 / TP2 / dailyBias */}
            {/* … см. исходник — полный JSX сохранён в репозитории … */}
          </div>

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

> Полный JSX grid-блока — в файле репозитория `TacticalDrawer.tsx` (строки 130–215). Здесь сокращён только повтор grid ради читаемости research-дока; структура и порядок верны.

**Фактический полный файл в репо (232 строки)** — без сокращений:

```tsx
// === BEGIN FULL TacticalDrawer.tsx ===
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import ProbabilityGauge from './ProbabilityGauge'
import LiveChart from './LiveChart'
import OrderBookPanel from './OrderBookPanel'
import DataLog from './DataLog'
import type { CoinSignal } from '../../engine/types'

const TacticalDrawer = () => {
  const { t } = useTranslation()
  const { haptic } = useTelegramWebApp()
  const selectedCoin = useAppStore((state) => state.selectedCoin)
  const isDrawerOpen = useAppStore((state) => state.isDrawerOpen)
  const signals = useAppStore((state) => state.signals)
  const setDrawerOpen = useAppStore((state) => state.setDrawerOpen)
  const selectCoin = useAppStore((state) => state.selectCoin)

  const drawerRef = useRef<HTMLDivElement>(null)

  const signal: CoinSignal | null = selectedCoin
    ? signals.find((s) => s.symbol === selectedCoin) ?? null
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

        <div className="px-4 py-6 space-y-6">
          <div className="flex justify-center">
            <ProbabilityGauge value={probability} direction={direction} />
          </div>

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
// === END FULL TacticalDrawer.tsx ===
```

---

## 3. `src/components/radar/RadarView.tsx` — ПОЛНЫЙ КОД

### Список монет
- Источник: `signals` из store
- Рендер: `signals.map` → `<CoinRow signal rank onClick />`
- Клик: `selectCoin` + `setDrawerOpen(true)`

### Место для глобального баннера / панели
**Да.** Естественные слоты:
1. **После заголовка / bias** (после `biasLabel` / `scanProgress`, ~строка 84) — до `CoinSearch`
2. **Между `CoinSearch` и колонками** (~строка 87–88)
3. **В `App.tsx` между `<Header />` и `<main>`** — глобально над радаром

Сейчас отдельного баннера нет; header радара уже показывает bias + scanProgress — рядом можно вставить News banner.

```tsx
import { Radar, Radio } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import CoinRow from './CoinRow'
import CoinSearch from './CoinSearch'

const RadarView = () => {
  const { t } = useTranslation()
  const signals = useAppStore((state) => state.signals)
  const connectionStatus = useAppStore((state) => state.connectionStatus)
  const isScanning = useAppStore((state) => state.isScanning)
  const marketContext = useAppStore((state) => state.marketContext)
  const extraWatchlist = useAppStore((state) => state.extraWatchlist)
  const selectCoin = useAppStore((state) => state.selectCoin)
  const setDrawerOpen = useAppStore((state) => state.setDrawerOpen)

  const handleCoinClick = (symbol: string) => {
    selectCoin(symbol)
    setDrawerOpen(true)
  }

  const getRelativeTime = (): string => {
    if (!marketContext?.lastScanAt) return ''
    try {
      const diffMs = Date.now() - marketContext.lastScanAt
      const diffMins = Math.floor(diffMs / (1000 * 60))
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
      if (diffHours > 0) return `${diffHours} ${t('time_ago_hours')}`
      if (diffMins > 0) return `${diffMins} ${t('time_ago_minutes')}`
      return `0 ${t('time_ago_minutes')}`
    } catch {
      return ''
    }
  }

  const translateBias = (bias: string) => {
    if (bias === 'BULLISH') return t('bias_bullish')
    if (bias === 'BEARISH') return t('bias_bearish')
    return t('bias_neutral')
  }

  const translateTrend = (trend: string) => {
    if (trend === 'BULLISH') return t('trend_bullish')
    if (trend === 'BEARISH') return t('trend_bearish')
    return t('trend_ranging')
  }

  const SkeletonRow = () => (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-hull-border/50">
      <div className="w-6 h-4 bg-hull-light rounded animate-pulse" />
      <div className="flex-1 space-y-2">
        <div className="h-4 bg-hull-light rounded w-24 animate-pulse" />
        <div className="h-3 bg-hull-light rounded w-16 animate-pulse" />
      </div>
      <div className="h-6 w-16 bg-hull-light rounded animate-pulse" />
      <div className="h-2 w-20 bg-hull-light rounded animate-pulse" />
      <div className="w-4 h-4 bg-hull-light rounded animate-pulse" />
    </div>
  )

  const biasLabel = marketContext
    ? `${translateBias(marketContext.dailyBias)} ${marketContext.dailyConfidence}% · ${translateTrend(marketContext.btcTrend)}`
    : ''

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-6 pb-4">
        <div className="flex items-center gap-2 mb-1">
          <Radar className="w-5 h-5 text-matrix" />
          <h1 className="text-lg font-mono font-bold text-holo uppercase tracking-wide">
            {t('radar_title')}
          </h1>
          {isScanning && <div className="w-2 h-2 bg-matrix rounded-full pulse-dot" />}
        </div>
        <p className="text-xs text-holo/40 font-mono ml-7">{t('radar_subtitle')}</p>
        {biasLabel && (
          <p className="text-xs text-matrix/70 font-mono ml-7 mt-1">{biasLabel}</p>
        )}
        {marketContext?.scanProgress && (
          <p className="text-xs text-holo/30 font-mono ml-7 mt-0.5">
            {marketContext.scanProgress}
          </p>
        )}
        {/* ★ SLOT: глобальный News banner */}
      </div>

      <CoinSearch />
      {/* ★ SLOT: компактная News strip */}

      <div className="px-4 py-2 border-b border-hull-border/30">
        <div className="flex items-center gap-3 text-xs text-holo/30 font-mono uppercase">
          <div className="w-6 text-right">#</div>
          <div className="flex-1">{t('column_asset')}</div>
          <div className="w-20">{t('column_signal')}</div>
          <div className="w-32">{t('column_probability')}</div>
          <div className="w-4" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isScanning && signals.length === 0 ? (
          <div>
            {[1, 2, 3, 4].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : connectionStatus === 'OFFLINE' && signals.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <p className="text-sm text-alert font-mono uppercase tracking-wider mb-2">
              {t('status_offline')}
            </p>
            <p className="text-xs text-holo/60 font-mono text-center max-w-xs">
              {t('connection_unavailable')}
            </p>
          </div>
        ) : signals.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <div className="relative">
              <Radio className="w-12 h-12 text-matrix/30 mb-4 animate-pulse" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-12 h-12 border-2 border-matrix/30 rounded-full animate-ping" />
              </div>
            </div>
            <p className="text-sm text-holo/40 font-mono uppercase tracking-wider">
              {t('status_scanning')}
            </p>
          </div>
        ) : (
          <div>
            {signals.map((signal, index) => (
              <CoinRow
                key={signal.symbol}
                signal={signal}
                rank={index + 1}
                onClick={() => handleCoinClick(signal.symbol)}
              />
            ))}
          </div>
        )}
      </div>

      {marketContext?.lastScanAt && (
        <div className="px-4 py-4 text-center border-t border-hull-border/30">
          <p className="text-xs text-holo/20 font-mono">
            {t('footer_data_age')} {getRelativeTime()}
          </p>
          <p className="text-xs text-holo/20 font-mono mt-1">
            {(marketContext.watchlistSize || 10) +
              (extraWatchlist.length ? ` (+${extraWatchlist.length})` : '')}{' '}
            {t('footer_pairs')}
          </p>
        </div>
      )}
    </div>
  )
}

export default RadarView
```

---

## 4. `src/App.tsx` — ПОЛНЫЙ КОД

### Структура
- **Нет React Router** — один экран
- `ErrorBoundary` → `Header` + `main(RadarView)` + `TacticalDrawer`
- Хуки на корне: `useTelegramWebApp()`, `useMexcScanner()`
- Layout: `min-h-screen`, `pt-14` под fixed Header, `pb-20`

```tsx
import Header from './components/layout/Header'
import RadarView from './components/radar/RadarView'
import TacticalDrawer from './components/tactical/TacticalDrawer'
import ErrorBoundary from './components/ErrorBoundary'
import { useMexcScanner } from './hooks/useMexcScanner'
import { useTelegramWebApp } from './hooks/useTelegramWebApp'

function App() {
  useTelegramWebApp()
  useMexcScanner()

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-space text-holo font-mono">
        <Header />
        {/* ★ SLOT: глобальный News toast / sticky bar под Header */}
        <main className="pt-14 pb-20 px-0">
          <RadarView />
        </main>
        <TacticalDrawer />
      </div>
    </ErrorBoundary>
  )
}

export default App
```

---

## 5. `analyzeSymbol()` — ProbabilityEngine

### Сигнатура
```typescript
export function analyzeSymbol(input: AnalyzeSymbolInput): AnalyzeSymbolResult
```

### Вход (`AnalyzeSymbolInput`)
| Поле | Тип |
|------|-----|
| `internalSymbol` | `string` |
| `ohlcv4h` | `OhlcvCandle[]` |
| `ohlcv1h` | `OhlcvCandle[]` |
| `ohlcv15m` | `OhlcvCandle[]` |
| `priceChange24h` | `number` |
| `dailyBias` | `DailyBiasResult` |
| `btcTrend` | `TrendDirection` |
| `wallTracker?` | `WallTrackerState` |

### Выход (`AnalyzeSymbolResult`)
```typescript
{ signal: CoinSignal; triggered: boolean }
```

### Score cap `Math.min(…, 10)`
**Единственное место явного cap в `analyzeSymbol`:** внутри `applyWallBoost`:

```typescript
const boosted = Math.min(Math.max(score + wallBoost.boost, 0), 10)
```

Базовый `confluence.score` приходит из `calculateConfluence` (SMC). Порог входа: `CONFLUENCE_THRESHOLD = 5`. Soft-path тоже проходит через `applyWallBoost` → тот же cap 0…10.

### Вызов
`useMexcScanner` → `runScanCycle` → для каждой монеты watchlist:

```typescript
const { signal, triggered } = analyzeSymbol({
  internalSymbol: symbol,
  ohlcv4h, ohlcv1h, ohlcv15m,
  priceChange24h: tickerMap.get(symbol) ?? 0,
  dailyBias,
  btcTrend,
})
```

`wallTracker` из сканера **не передаётся** (только опционально при открытой монете / orderbook path).

**Для News Intelligence (score impact):** вставлять boost/penalty рядом с `applyWallBoost` или расширить его, сохраняя `Math.min(..., 10)`.

---

## 6. `useMexcScanner.ts` — первые 80 строк + цикл

### Константы
| Константа | Значение |
|-----------|----------|
| `SCAN_PAUSE_MS` | `120_000` (2 мин пауза между полными сканами) |
| `COIN_DELAY_MS` | `300` |
| `TICKER_POLL_MS` | `5_000` |
| `COOLDOWN_MS` | из PE: `180 * 60 * 1000` (3ч) |

### Главный цикл (`useEffect` boot)
1. `syncWatchlist()` + `refreshTickers()`
2. `while (mounted)`: `runScanCycle()` → sleep `SCAN_PAUSE_MS` посекундно
3. Параллельно `setInterval(refreshTickers, TICKER_POLL_MS)`
4. Subscribe на `extraWatchlist` → sync

### `analyzeSymbol` — в `runScanCycle`, строка ~182

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
  calculateEma,
  detectMarketStructure,
  resolveDailyBias,
  type TrendDirection,
} from '../engine/smc'
import { analyzeSymbol, COOLDOWN_MS } from '../engine/ProbabilityEngine'
import type { CoinSignal, LiveTicker, MarketContext } from '../engine/types'
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

  const {
    updateTicker,
    updateSignals,
    setMarketContext,
    setScanning,
    setConnectionStatus,
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
      // … BTC daily bias + per-coin OHLCV …
      // analyzeSymbol({ ... })  ← ~строка 182
      // updateSignals(results)
      // sleep SCAN_PAUSE_MS между циклами
```

---

## 7. `workers/mexc-proxy/src/index.ts` — ПОЛНЫЙ КОД

### Как устроен
- Cloudflare Worker, transparent CORS proxy → `https://contract.mexc.com`
- Только `GET` (+ `OPTIONS` preflight)
- Path: `/mexc/...` или любой path → `MEXC_ORIGIN + path + search`
- Cache-Control: `public, max-age=2`
- CORS: `Access-Control-Allow-Origin: *`

```typescript
/**
 * Cloudflare Worker — transparent CORS proxy for MEXC Contract public API.
 * Deploy: cd workers/mexc-proxy && npx wrangler deploy
 * Then set VITE_MEXC_PROXY_URL to the worker URL in production.
 */

const MEXC_ORIGIN = 'https://contract.mexc.com'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', {
        status: 405,
        headers: CORS_HEADERS,
      })
    }

    const url = new URL(request.url)
    // Worker path mirrors /api/... → https://contract.mexc.com/api/...
    const targetPath = url.pathname.replace(/^\/mexc/, '') || url.pathname
    const target = `${MEXC_ORIGIN}${targetPath}${url.search}`

    try {
      const upstream = await fetch(target, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'EnterpriseSystem-MexcProxy/1.0',
        },
      })

      const body = await upstream.arrayBuffer()
      const headers = new Headers(CORS_HEADERS)
      headers.set(
        'Content-Type',
        upstream.headers.get('Content-Type') || 'application/json'
      )
      headers.set('Cache-Control', 'public, max-age=2')

      return new Response(body, {
        status: upstream.status,
        headers,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Proxy error'
      return new Response(JSON.stringify({ success: false, message }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }
  },
}
```

**Для News API:** сейчас worker только MEXC. Внешний calendar/news API потребует либо нового path в этом worker, либо отдельного worker/прокси.

---

## 8. `vite.config.ts` — ПОЛНЫЙ КОД

### Proxy
Единственное правило: `/mexc` → `https://contract.mexc.com` (rewrite strip `/mexc`).

### Другие внешние API в proxy?
**Нет.** Только MEXC. Three.js/LWC — через `optimizeDeps` / chunks, не proxy.

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: {
      '/mexc': {
        target: 'https://contract.mexc.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/mexc/, ''),
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
          'i18n-vendor': ['i18next', 'react-i18next', 'i18next-browser-languagedetector'],
        },
      },
    },
  },
})
```

---

## Planning notes (News Intelligence)

| Точка | Рекомендация |
|-------|--------------|
| Store | Новый slice + `localStorage` как `sessionSettings` |
| Global UI | `RadarView` после header **или** `App` под `Header` |
| Per-coin UI | `TacticalDrawer` после gauge / в `DataLog` |
| Score | Hook в `applyWallBoost` / рядом, cap `0…10` уже есть |
| Scanner | Не блокировать scan cycle; news poll отдельно (как ticker interval) |
| Network | Hardcoded calendar уже есть в `engine/sessions/newsCalendar.ts`; live API → новый Vite proxy + Worker path |
| Sessions overlay | Уже рисует NFP/CPI/FOMC маркеры на графике — News Intelligence может reuse `getEventsInRange` |
