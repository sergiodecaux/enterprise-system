# Price Prediction + Multi-TF Analysis — Research Brief

**Дата:** 2026-07-20  
**Цель:** подготовка к прогнозированию цены на графике и мультитаймфреймовому анализу  
**Статус:** только исследование, без реализации

---

## Краткие ответы (Q1–Q7)

| # | Вопрос | Ответ |
|---|--------|--------|
| **Q1** | Есть ли `ISeriesApi.createLineTool()`? | **Нет.** В LWC v4.1.3 есть только `createPriceLine()` / `removePriceLine()`. Нет drawing tools / trend lines API. Прогнозные линии — через `addLineSeries` или HTML overlay |
| **Q2** | Как swing high/low в `detectMarketStructure`? | Fractal 5-bar: индекс `i` — swing high если `high[i]` > high[i±1] и high[i±2]; swing low симметрично по low. Хранятся как `[index, price][]`. Trend = HH+HL → BULLISH, LH+LL → BEARISH (по последним 4 swings) |
| **Q3** | Сколько 4H свечей: сканер vs LiveChart? | **Сканер:** `fetchOhlcv(symbol, '4h', 100)`. **LiveChart:** `CANDLE_LIMIT['4h'] = 100`. Одинаково **100**. BTC 4H в сканере тоже 100 |
| **Q4** | Multi-TF closes в CoinSignal? | **Нет.** Нет полей `close4h` / `close1h` / `close1d`. Есть только `price` (последний close 1H), `coinTrend` (из 4H structure), `dailyBias` (строка) |
| **Q5** | Где «куда идёт цена»? | Не только dailyBias. Цепочка: **dailyBias** (1D BTC) → **btcTrend** (4H BTC structure + EMA200 1H confirm) → **coinTrend** (4H монеты) → **direction** (confluence OB/FVG/Fib на 1H + rejection + RSI). Также ML в OrderBook (отдельно) |
| **Q6** | Volume profile / POC в движке? | **Да, упрощённо** в `src/engine/zones/liquidity.ts`: `calculatePocLevel` (свеча max volume → mid high/low), `calculateValueArea` (70% объёма). Не классический VP по price buckets. UI toggle в chart settings |
| **Q7** | Как signal в LiveChart? | **Ни props signal, ни store.** LiveChart получает только `symbol` + `flatSymbol`. Signal живёт в drawer (`signals.find`), в LiveChart не передаётся. SL/TP с сигнала на график **не рисуются** |

---

## 1. LiveChart — актуальная архитектура

**Файл:** `src/components/tactical/LiveChart.tsx` (386 строк)

### Refs

| Ref | Тип | Назначение |
|-----|-----|------------|
| `containerRef` | `HTMLDivElement` | DOM контейнер LWC |
| `chartRef` | `IChartApi \| null` | экземпляр `createChart()` из **lightweight-charts ^4.1.3** |
| `candleRef` | `ISeriesApi<'Candlestick'> \| null` | основная свечная серия |
| `lineRefs` | `Record<string, ISeriesApi<'Line'>>` | EMA/SMA/BB/VWAP линии |
| `priceLineRefs` | `IPriceLine[]` | Fib / daily levels через `createPriceLine` |

**Да — `lineRefs` и `priceLineRefs` уже есть.**

### Props

```ts
interface LiveChartProps {
  symbol: string      // internal BTC/USDT:USDT
  flatSymbol: string  // BTCUSDT для ticker store
}
```

### Локальный state (не store)

- `timeframe: MexcTimeframe` — default `'1h'`
- `candles: OhlcvCandle[]` — сырые данные для индикаторов/зон
- `lwcData: CandlestickData[]` — для series
- `chartReady` — tick после mount chart (для overlay)

### Candle limits

```ts
const CANDLE_LIMIT = {
  '1m': 120, '5m': 120, '15m': 120,
  '1h': 120, '4h': 100, '1d': 90,
}
```

### Что уже есть / чего нет для прогноза

| Есть | Нет |
|------|-----|
| Line series overlays | Trendline / ray / scenario path |
| Price lines (Fib, daily) | Signal SL/TP на графике |
| Zone HTML overlay (OB/FVG) | Multi-TF sync panel |
| Chart preferences store | Forecast markers / projected candles |

### Полный код LiveChart

См. актуальный файл в репозитории: `src/components/tactical/LiveChart.tsx`  
Ключевые фрагменты refs:

```ts
const chartRef = useRef<IChartApi | null>(null)
const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
const lineRefs = useRef<Record<string, ISeriesApi<'Line'>>>({})
const priceLineRefs = useRef<IPriceLine[]>([])
```

Тип `chartRef.current` = `IChartApi | null` из пакета `lightweight-charts@^4.1.3` (API v4: `addCandlestickSeries`, `addLineSeries`, `createPriceLine` на series).

---

## 2. SMC — ключевые функции и типы

**Файл:** `src/engine/smc/index.ts` (~850 строк)

### Типы направления / структуры

```ts
export type TrendDirection = 'BULLISH' | 'BEARISH' | 'RANGING'
export type TradeSide = 'LONG' | 'SHORT'
export type DailyBiasDirection = 'LONG_ONLY' | 'SHORT_ONLY' | 'BOTH' | 'NO_TRADE'

export interface MarketStructure {
  trend: TrendDirection
  lastBos: 'UP' | 'DOWN' | null
  swingHighs: Array<[number, number]>  // [candleIndex, price]
  swingLows: Array<[number, number]>
  lastSwingHigh: number | null
  lastSwingLow: number | null
}
```

### `detectMarketStructure()` — полный код

```ts
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

**Для прогнозных сценариев:** есть индексы и цены swings → можно строить path до следующего HH/LL / BOS-level. `lookback` проверяет `candles.length < lookback`, но fractal сканирует **весь** массив (не только последние N).

### `calculateFibonacciLevels()` — полный код

```ts
export function calculateFibonacciLevels(
  swingHigh: number,
  swingLow: number,
  direction: 'UP' | 'DOWN'
): FibLevels {
  const diff = swingHigh - swingLow

  if (direction === 'UP') {
    const levels = {
      '0.236': swingHigh - diff * 0.236,
      '0.382': swingHigh - diff * 0.382,
      '0.5': swingHigh - diff * 0.5,
      '0.618': swingHigh - diff * 0.618,
      '0.705': swingHigh - diff * 0.705,
      '0.786': swingHigh - diff * 0.786,
      '1.0': swingLow,
    }
    return { ...levels, ote_top: levels['0.618'], ote_bottom: levels['0.786'] }
  }

  const levels = {
    '0.236': swingLow + diff * 0.236,
    '0.382': swingLow + diff * 0.382,
    '0.5': swingLow + diff * 0.5,
    '0.618': swingLow + diff * 0.618,
    '0.705': swingLow + diff * 0.705,
    '0.786': swingLow + diff * 0.786,
    '1.0': swingHigh,
  }
  return { ...levels, ote_top: levels['0.786'], ote_bottom: levels['0.618'] }
}
```

### `analyzeDailyCandle()` / `getDailyLevels()` / `resolveDailyBias()`

Полный код — в `src/engine/smc/index.ts` строки ~527–844.

Кратко:

| Функция | Вход | Выход |
|---------|------|-------|
| `analyzeDailyCandle` | 1D candles (≥21) | `{ bias, confidence, pattern, details }` по паттернам prev-day + EMA + volume |
| `getDailyLevels` | 1D (≥10) | PDH/PDL/PDO/PDC, PWH/PWL, nearest S/R, keyLevels |
| `resolveDailyBias` | 1D | `direction`: confidence≥70 → LONG_ONLY/SHORT_ONLY; ≥55 → BOTH; else NO_TRADE |

---

## 3. `useMexcScanner` — multi-TF данные

**Файл:** `src/hooks/useMexcScanner.ts`

### Сколько свечей грузится

| Контекст | TF | Limit |
|----------|-----|-------|
| BTC daily bias | 1d | **60** |
| BTC structure | 4h | **100** |
| BTC EMA200 | 1h | **300** |
| Каждая монета | 4h | **100** |
| Каждая монета | 1h | **100** |
| Каждая монета | 15m | **50** |

### Есть ли multi-TF анализ «закрытых» свечей?

**Частично / косвенно:**

- Daily bias смотрит **предыдущую** дневную свечу (`candles1d[length-2]`) — да, closed-day analysis
- Structure на 4H использует swings на всех свечах включая формирующуюся
- Confluence / rejection на **последней 1H** свече (`ohlcv1h[length-1]`) — может быть незакрытая
- **Нет** отдельного модуля «сравнить close 4H vs close 1H vs close 1D» как MTF alignment score

### Что уходит в store

```ts
updateSignals(results: CoinSignal[])   // radar rows
setMarketContext(MarketContext)        // daily + btcTrend + progress
updateTicker(LiveTicker)               // prices
```

OHLCV массивы **не** сохраняются в store — только результат анализа.

---

## 4. ProbabilityEngine — `analyzeSymbol`

### Direction (LONG/SHORT)

1. `dailyBias.direction` → `longPermitted` / `shortPermitted`
2. `coinTrend` из `detectMarketStructure(ohlcv4h)` + fallback на `btcTrend` если RANGING
3. `trySide(LONG)` затем `trySide(SHORT)`:
   - confluence ≥ 5
   - `bestZone` top/bottom есть
   - candle rejection на зоне
   - RSI < 45 для LONG, > 55 для SHORT
4. Если setup не сработал → soft direction = сторона с большим confluence score

### dailyBias

Считается **один раз на цикл** в сканере (`resolveDailyBias(BTC 1D)`), передаётся в `analyzeSymbol` как `DailyBiasResult`. Не пересчитывается per-coin.

### `bestZone`

```ts
bestZone: {
  top: number | null      // верх зоны OB или FVG
  bottom: number | null   // низ зоны
  sl: number | null       // ob.low (LONG) или ob.high (SHORT)
}
```

Используется в `buildLevels` для SL/TP1/TP2 (R:R 1:2 / 1:3) и `tpDaily` из PDH/PDL.

**Важно:** `ohlcv15m` принимается в input и проверяется `length < 20`, но **нигде дальше не используется** в анализе.

---

## 5. `types.ts` — сводка интерфейсов

Полный файл: `src/engine/types.ts`

### Реэкспорт SMC-типов

`TradeSide`, `TrendDirection`, `DailyBiasDirection`, `DailyAnalysis`, `DailyLevels` — из `./smc`.

### `CoinSignal` (нет multi-TF closes)

```ts
export interface CoinSignal {
  symbol: string
  internalSymbol: string
  displayName: string
  price: number                 // 1H last close
  priceChange24h: number
  currentRSI: number | null     // 1H RSI
  probabilityPct: number
  score: number
  direction: TradeSide | null
  zones: string[]
  sl / tp1 / tp2 / tpDaily: number | null
  coinTrend: TrendDirection | null   // from 4H
  btcTrend: TrendDirection | null
  dailyBias: string | null
  dailyConfidence: number | null
  dailyPattern: string | null
  isLocked: boolean
  hasActiveSetup: boolean
  activeSignal: IndicatorBucket | null
  activeSignalKey: string | null
}
```

### `MarketContext`

```ts
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
```

Также: OrderBook / History / Wall / Heatmap типы (см. файл).

---

## 6. `useAppStore` — state & actions

### State fields

| Field | Тип |
|-------|-----|
| `liveTickets` | `Record<string, LiveTicker>` |
| `signals` | `CoinSignal[]` |
| `marketContext` | `MarketContext \| null` |
| `isScanning` | `boolean` |
| `extraWatchlist` | `string[]` |
| `chartPreferences` | `ChartPreferences` |
| `selectedCoin` | `string \| null` |
| `isDrawerOpen` | `boolean` |
| `isProUser` | `boolean` |
| `isConnected` | `boolean` |
| `connectionStatus` | `ONLINE \| POLLING \| OFFLINE` |
| `lastUpdate` | `number` |

### Actions

`updateTicker`, `updateSignals`, `upsertSignal`, `setMarketContext`, `setScanning`, `addToWatchlist`, `removeFromWatchlist`, `selectCoin`, `setDrawerOpen`, `setProUser`, `setConnected`, `setConnectionStatus`, `setChartPreferences`

Persistence: `extraWatchlist` + `chartPreferences` → localStorage.

---

## 7. TacticalDrawer — разметка и signal

```tsx
// signal из store:
const signal = selectedCoin
  ? signals.find((s) => s.symbol === selectedCoin) ?? null
  : null

// LiveChart — ПОСЛЕ gauge/stats, ПЕРЕД OrderBook:
<LiveChart symbol={signal.internalSymbol} flatSymbol={signal.symbol} />
<OrderBookPanel symbol={signal.internalSymbol} />
<DataLog signal={signal} />
```

### Данные signal, доступные в drawer (но НЕ в LiveChart)

`probabilityPct`, `direction`, `currentRSI`, `score`, `coinTrend`, `sl/tp1/tp2`, `dailyBias`, `dailyConfidence`, `price`, `priceChange24h`, `zones` (через DataLog), `hasActiveSetup`.

---

## Выводы для Price Prediction + Multi-TF

### Уже можно переиспользовать
- Swing high/low + BOS из `detectMarketStructure`
- Fib / OTE / daily levels
- Line series + price lines в LiveChart
- POC/VA (упрощённые) в zones engine
- MTF data pipeline в сканере (4H/1H/15m/1D)

### Нужно добавить для фичи
1. **Типы прогноза** (`PriceScenario`, `MtfAlignment`, projected path points)
2. **Движок сценариев** на swings + ATR + structure (bull/bear/range paths)
3. **MTF alignment score** (close vs EMA/structure на 1D/4H/1H) — сейчас нет в CoinSignal
4. **Передать signal → LiveChart** (props или selector) для SL/TP + forecast overlay
5. **Отрисовка прогноза:** `addLineSeries` (dashed path) или HTML canvas overlay — **не** `createLineTool` (его нет)
6. Опционально: сохранить last closes / structure в `CoinSignal` или отдельный chart-context cache

### Рекомендуемый минимальный план
1. `src/engine/prediction/` — scenarios from `MarketStructure` + ATR  
2. `usePriceForecast(candles, structure)` hook  
3. LiveChart: optional `signal?: CoinSignal` + forecast line series  
4. MTF badge panel под графиком (1D/4H/1H bias dots) из `marketContext` + local 4H fetch
