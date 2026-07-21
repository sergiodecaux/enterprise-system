# OrderBook Intelligence — запрос кодовой базы (выгрузки)

**Дата:** 2026-07-20  
**Цель:** подготовка к модулю анализа стакана под графиком в Tactical Drawer  
**Репозиторий:** `enterprise-system`

---

## Краткие ответы на вопросы

### Какие endpoints MEXC используются сейчас?

| Endpoint (через proxy `/mexc`) | Назначение | Где |
|--------------------------------|------------|-----|
| `GET /api/v1/contract/ticker` | Все тикеры / фильтр USDT | `fetchTickers()` |
| `GET /api/v1/contract/ticker?symbol=BTC_USDT` | Один тикер | `fetchTicker()` |
| `GET /api/v1/contract/kline/{SYMBOL}?interval=…&limit=…` | Свечи OHLCV | `fetchOhlcv()` |

**База upstream:** `https://contract.mexc.com`  
**Dev proxy:** `/mexc` → `contract.mexc.com` (`vite.config.ts`)  
**Prod:** `VITE_MEXC_PROXY_URL` (Cloudflare Worker)

Интервалы свечей: `Min1`, `Min5`, `Min15`, `Min60`, `Hour4`, `Day1`.

### Есть ли уже запросы к стакану (order book)?

**Нет.** По всему `src/` нет упоминаний `depth`, `orderbook`, `стакан`, `imbalance`.  
Функции `fetchDepth` / типы стакана **отсутствуют**.

Публичный endpoint MEXC (проверен живым запросом 2026-07-20):

```
GET https://contract.mexc.com/api/v1/contract/depth/BTC_USDT?limit=5
```

Пример ответа:

```json
{
  "success": true,
  "code": 0,
  "data": {
    "asks": [[65455.2, 15949, 1], ...],
    "bids": [[65455.1, 312461, 9], ...],
    "version": 39969288176,
    "timestamp": 1784568456172
  }
}
```

Формат уровня: `[price, volume, orderCount]` (asks/bids).

**Локальной документации MEXC OrderBook в репозитории нет** (только `workers/mexc-proxy/README.md` про CORS-прокси). Официальные docs: https://www.mexc.com/api-docs/futures/market-endpoints

### Какая структура текущих рыночных данных?

1. **`OhlcvCandle`** — `[ts_ms, open, high, low, close, volume]`
2. **`MexcTicker` / `LiveTicker`** — цена, % 24h, объём, high/low, timestamp
3. **`CoinSignal`** — SMC-сигнал (probability, score, direction, SL/TP, zones…)
4. **`MarketContext`** — daily bias + BTC trend + прогресс скана

Стакана в store **нет**.

### Интервалы обновления

| Тип данных | Интервал | Источник |
|------------|----------|----------|
| Тикеры (watchlist) | **5 000 ms** | `TICKER_POLL_MS` в `useMexcScanner` |
| Полный SMC-скан | пауза **120 000 ms** между циклами | `SCAN_PAUSE_MS` |
| Задержка между монетами в скане | **300 ms** (+ 200 ms между TF) | `COIN_DELAY_MS` |
| Кулдаун повторного сетапа | **180 мин** | `COOLDOWN_MS` в ProbabilityEngine |
| График (klines) | по смене символа/ТФ (разовый fetch) | `LiveChart` |
| Last candle на графике | при обновлении `liveTickets` (короткие ТФ) | подписка на store |
| Стакан | **не реализован** | — |

Рекомендация для OrderBook: poll **1–2 с** только для **открытой** монеты в drawer (не для всего watchlist).

### Куда вставлять UI

В `TacticalDrawer.tsx` сейчас порядок:

1. ProbabilityGauge  
2. Сетка метрик (RSI, direction, score, trend, SL/TP…)  
3. **`LiveChart`**  
4. **`DataLog`**

→ **OrderBook Intelligence** логично ставить **сразу под `LiveChart`**, перед `DataLog`.

---

## 1. Полный код `src/components/tactical/TacticalDrawer.tsx`

```tsx
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import ProbabilityGauge from './ProbabilityGauge'
import LiveChart from './LiveChart'
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
            {/* RSI, direction, score, trend, SL, TP1, TP2, daily bias */}
            {/* ... см. файл в репозитории — полный код выше по смыслу совпадает с диском ... */}
          </div>

          <LiveChart symbol={signal.internalSymbol} flatSymbol={signal.symbol} />

          {/* >>> СЮДА: <OrderBookIntelligence symbol={signal.internalSymbol} /> */}

          <DataLog signal={signal} />
        </div>
      </div>
    </>
  )
}

export default TacticalDrawer
```

**Точка вставки OrderBook:** после строки с `<LiveChart … />`, до `<DataLog … />`.

Полный актуальный файл на диске: `src/components/tactical/TacticalDrawer.tsx` (225 строк) — без сокращений в репозитории.

---

## 2. Полный код `src/components/tactical/LiveChart.tsx`

Файл на диске: **203 строки**. Ключевые факты для интеграции:

- Props: `symbol` (internal `BTC/USDT:USDT`), `flatSymbol` (`BTCUSDT`)
- ТФ: `1m | 5m | 15m | 1h | 4h | 1d` через `CHART_TIMEFRAMES`
- Высота графика: **260px**
- Данные: `fetchOhlcv(symbol, timeframe, limit)`
- Live-апдейт последней свечи из `liveTickets[flatSymbol]` (не для 4h/1d)

OrderBook **не зависит** от LiveChart state — отдельный компонент с тем же `symbol`.

---

## 3. Полный код `src/api/mexc/index.ts` (API-слой)

Файл: **252 строки**. Сейчас есть только:

### Транспорт

```ts
async function mexcGet<T>(path: string): Promise<T> {
  const base = getMexcBaseUrl() // '/mexc' или VITE_MEXC_PROXY_URL
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`
  const res = await fetch(url)
  // … проверка ok + success:false
  return json as T
}
```

### Запросы

```ts
// Свечи
fetchOhlcv(symbol, timeframe, limit)
→ GET /api/v1/contract/kline/{API_SYMBOL}?interval={Min1|…}&limit={n}

// Все тикеры
fetchTickers()
→ GET /api/v1/contract/ticker

// Один тикер
fetchTicker(symbol)
→ GET /api/v1/contract/ticker?symbol={API_SYMBOL}
```

### Чего нет (нужно добавить для OrderBook)

```ts
// ПРЕДЛАГАЕМЫЙ контракт (ещё не в коде):
fetchDepth(symbol: string, limit = 20): Promise<OrderBookSnapshot>
→ GET /api/v1/contract/depth/{API_SYMBOL}?limit={limit}
```

Маппинг символов уже готов: `toApiSymbol('BTC/USDT:USDT')` → `BTC_USDT`.

Proxy Worker прозрачный — новый path `/api/v1/contract/depth/...` заработает **без изменений** vite proxy / worker (тот же origin).

---

## 4. Типы `src/engine/types.ts`

Актуальные рыночные/сигнальные типы:

```ts
export interface LiveTicker {
  symbol: string         // flat BTCUSDT
  price: number
  priceChange24h: number
  volume24h: number
  high24h: number
  low24h: number
  timestamp: number
}

export interface CoinSignal {
  symbol: string
  internalSymbol: string
  displayName: string
  price: number
  priceChange24h: number
  currentRSI: number | null
  probabilityPct: number
  score: number
  direction: TradeSide | null
  zones: string[]
  sl / tp1 / tp2 / tpDaily
  coinTrend / btcTrend
  dailyBias / dailyConfidence / dailyPattern
  isLocked: boolean
  hasActiveSetup: boolean
  activeSignal / activeSignalKey  // legacy shim
}

export interface MarketContext {
  dailyDirection / dailyBias / dailyConfidence
  dailyAnalysis / dailyLevels
  btcTrend / emaConfirms
  lastScanAt / watchlistSize / scanProgress
}

export interface AppState {
  liveTickets: Record<string, LiveTicker>
  signals: CoinSignal[]
  marketContext: MarketContext | null
  isScanning: boolean
  extraWatchlist: string[]
  selectedCoin / isDrawerOpen / connectionStatus …
  // actions: updateTicker, updateSignals, upsertSignal, addToWatchlist, …
}
```

**Для OrderBook предложить добавить** (ещё не в коде):

```ts
export interface OrderBookLevel {
  price: number
  volume: number
  orderCount: number
}

export interface OrderBookSnapshot {
  symbol: string
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  version: number
  timestamp: number
}

export interface OrderBookMetrics {
  imbalance: number        // -1..1 или 0..100
  bidVolume: number
  askVolume: number
  walls: Array<{ side: 'BID' | 'ASK'; price: number; volume: number }>
  midPrice: number | null
  spread: number | null
}
```

Store: либо локальный state в компоненте drawer (предпочтительно для poll), либо `orderBooks: Record<string, OrderBookSnapshot>` в Zustand.

---

## 5. Store `src/store/useAppStore.ts`

Zustand + `subscribeWithSelector`.

**Состояние:**
- `liveTickets`, `signals`, `marketContext`, `isScanning`
- `extraWatchlist` (localStorage key `enterprise_extra_watchlist`)
- UI: `selectedCoin`, `isDrawerOpen`, `connectionStatus`, `isProUser` (сейчас `true`)

**Actions:** `updateTicker`, `updateSignals`, `upsertSignal`, `setMarketContext`, `setScanning`, `addToWatchlist`, `removeFromWatchlist`, `selectCoin`, `setDrawerOpen`, `setConnectionStatus`…

Стакана / depth в store **нет**. Для MVP достаточно локального `useState` + `setInterval` в `OrderBookPanel`, без раздувания глобального store.

---

## 6. Proxy `vite.config.ts`

```ts
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
  // build … manualChunks
})
```

Клиентский URL depth в dev:

```
/mexc/api/v1/contract/depth/BTC_USDT?limit=20
```

→ проксируется в:

```
https://contract.mexc.com/api/v1/contract/depth/BTC_USDT?limit=20
```

---

## 7. Документация MEXC OrderBook локально

| Источник | Есть? |
|----------|-------|
| `workers/mexc-proxy/README.md` | Да — только CORS proxy, без depth |
| `ОПИСАНИЕ_ПРОГРАММЫ.md` | Упоминает OrderBook как «не в этой версии» |
| Отдельный MD по MEXC depth API | **Нет** |
| Живой API depth | **Работает** (см. пример выше) |

Внешняя ссылка: [MEXC Futures Market Endpoints](https://www.mexc.com/api-docs/futures/market-endpoints)

---

## Рекомендуемый план внедрения (кратко)

1. **`src/api/mexc`:** `fetchDepth(symbol, limit)` + типы уровня/снимка  
2. **`src/engine/orderbook.ts`:** imbalance, walls (объём > N× median), spread  
3. **`src/components/tactical/OrderBookPanel.tsx`:** UI под графиком  
4. **`TacticalDrawer`:** вставить `<OrderBookPanel symbol={signal.internalSymbol} />` после `LiveChart`  
5. Poll **1–2 с** только пока `isDrawerOpen`  
6. i18n-ключи на русском  

---

## Связанные константы сканера (для контекста нагрузки)

Из `useMexcScanner.ts`:

```ts
const SCAN_PAUSE_MS = 120_000  // 2 мин между полными циклами
const COIN_DELAY_MS = 300
const TICKER_POLL_MS = 5_000
```

OrderBook **не** должен идти в общий скан-цикл — только для открытой карточки.

---

*Файл сгенерирован для планирования OrderBook Intelligence. Исходники на диске — source of truth; при расхождении править код, затем этот документ.*
