# LiveChart / Indicators / Liquidity Zones — Research Brief

**Дата:** 2026-07-20  
**Цель:** подготовка к добавлению индикаторов и зон ликвидности на `LiveChart`  
**Статус:** только исследование, без реализации

---

## Краткие ответы (Q1–Q5)

| # | Вопрос | Ответ |
|---|--------|--------|
| **Q1** | Версия Lightweight Charts? | `lightweight-charts`: **^4.1.3** (`package.json`) |
| **Q2** | Есть ли `createPriceLine` / `createSeries` в LiveChart? | **Нет.** Только `createChart` + `addCandlestickSeries`. Нет line series, нет price lines |
| **Q3** | Markers / shapes? | **Нет.** Нет `setMarkers`, нет rectangle/shape overlays |
| **Q4** | Где выбранный таймфрейм? | **Локальный state** в `LiveChart`: `useState<MexcTimeframe>('1h')` — **не в Zustand** |
| **Q5** | Настройки пользователя (theme, indicators)? | **Нет.** В store только ticker/signals/drawer/watchlist. Нет preferences для индикаторов/темы графика |

---

## 1. `src/components/tactical/LiveChart.tsx` (полный код)

```tsx
import { useEffect, useRef, useState } from 'react'
import { createChart, IChartApi, ISeriesApi, CandlestickData, Time } from 'lightweight-charts'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import { CHART_TIMEFRAMES, fetchOhlcv, type MexcTimeframe } from '../../api/mexc'
import { logger } from '../../utils/logger'

interface LiveChartProps {
  symbol: string
  flatSymbol: string
}

const CANDLE_LIMIT: Record<MexcTimeframe, number> = {
  '1m': 120,
  '5m': 120,
  '15m': 120,
  '1h': 120,
  '4h': 100,
  '1d': 90,
}

const LiveChart = ({ symbol, flatSymbol }: LiveChartProps) => {
  const { t } = useTranslation()
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const [timeframe, setTimeframe] = useState<MexcTimeframe>('1h')
  const [data, setData] = useState<CandlestickData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const ticker = useAppStore((state) => state.liveTickets[flatSymbol])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setData([])

    const load = async () => {
      try {
        const candles = await fetchOhlcv(symbol, timeframe, CANDLE_LIMIT[timeframe])
        if (cancelled) return
        if (!candles.length) {
          setError(t('chart_empty'))
          return
        }
        const mapped: CandlestickData[] = candles.map((c) => ({
          time: (c[0] / 1000) as Time,
          open: c[1],
          high: c[2],
          low: c[3],
          close: c[4],
        }))
        setData(mapped)
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
    if (!chartContainerRef.current) return
    if (chartRef.current) return

    const chart = createChart(chartContainerRef.current, {
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
      rightPriceScale: {
        borderColor: '#2a2a2a',
      },
      width: chartContainerRef.current.clientWidth,
      height: 260,
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

    const candlestickSeries = chart.addCandlestickSeries({
      upColor: '#00ff41',
      downColor: '#ff003c',
      borderUpColor: '#00ff41',
      borderDownColor: '#ff003c',
      wickUpColor: '#00ff4180',
      wickDownColor: '#ff003c80',
    })

    chartRef.current = chart
    seriesRef.current = candlestickSeries

    const resizeObserver = new ResizeObserver((entries) => {
      if (entries.length === 0) return
      const { width } = entries[0].contentRect
      chart.applyOptions({ width, height: 260 })
    })

    resizeObserver.observe(chartContainerRef.current)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!seriesRef.current || data.length === 0) return
    seriesRef.current.setData(data)
    chartRef.current?.timeScale().fitContent()
  }, [data])

  useEffect(() => {
    if (!seriesRef.current || !ticker || data.length === 0) return
    if (timeframe === '4h' || timeframe === '1d') return

    const lastCandle = data[data.length - 1]
    const newClose = ticker.price
    if (Math.abs(lastCandle.close - newClose) < Number.EPSILON) return

    const updatedCandle: CandlestickData = {
      ...lastCandle,
      close: newClose,
      high: Math.max(lastCandle.high, newClose),
      low: Math.min(lastCandle.low, newClose),
    }
    seriesRef.current.update(updatedCandle)
  }, [ticker?.price, data, timeframe])

  return (
    <div className="space-y-2">
      {/* TF buttons + chart container */}
      ...
    </div>
  )
}

export default LiveChart
```

### Как рендерятся свечи
1. `fetchOhlcv(symbol, timeframe, limit)` → `OhlcvCandle[]`
2. Маппинг в `CandlestickData`: `time = timestamp_ms / 1000`, O/H/L/C (volume **не** передаётся в series)
3. `seriesRef.current.setData(data)` + `fitContent()`
4. Live-апдейт последней свечи из `liveTickets[flatSymbol].price` (кроме TF `4h` / `1d`)

### Что передаётся в Lightweight Charts
| Поле | Источник |
|------|----------|
| `time` | `c[0] / 1000` (unix seconds) |
| `open/high/low/close` | `c[1..4]` |
| volume | **не используется** в chart series |

### Overlays / markers
**Отсутствуют.** Нет:
- `createPriceLine`
- `addLineSeries` / `addAreaSeries`
- `setMarkers`
- кастомных HTML/Canvas overlays поверх графика

---

## 2. `src/api/mexc/index.ts` — OHLCV

### Тип и таймфреймы

```ts
/** Candle: [timestamp_ms, open, high, low, close, volume] */
export type OhlcvCandle = [number, number, number, number, number, number]

export type MexcTimeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

const TIMEFRAME_MAP: Record<MexcTimeframe, string> = {
  '1m': 'Min1',
  '5m': 'Min5',
  '15m': 'Min15',
  '1h': 'Min60',
  '4h': 'Hour4',
  '1d': 'Day1',
}
```

### `fetchOhlcv()` — полный код

```ts
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
      d.time[i] * 1000,        // MEXC time = unix seconds → ms
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

**Эндпоинт:** `GET /api/v1/contract/kline/{BTC_USDT}?interval=Min60&limit=N`  
**Ответ MEXC:** параллельные массивы `time/open/high/low/close/vol`

---

## 3. `src/engine/smc/index.ts` — индикаторы и зоны

### Уже реализовано

| Функция / тип | Есть? | Назначение |
|---------------|-------|------------|
| `calculateEma` | ✅ | EMA по closes, возвращает **одно** последнее значение |
| `calculateRsi` | ✅ | RSI(14) по closes |
| `calculateAtr` | ✅ | ATR(14) по candles |
| `detectMarketStructure` | ✅ | BOS / swings / trend |
| `findOrderBlocks` | ✅ | OB с `top/bottom/index/strength` |
| `findFvg` | ✅ | FVG с `top/bottom/index` |
| `calculateFibonacciLevels` | ✅ | уровни + OTE |
| `calculateConfluence` | ✅ | score + `zones: string[]` + `bestZone` |
| Bollinger Bands | ❌ | нет |
| VWAP | ❌ | нет |
| EMA series (массив точек) | ❌ | только scalar last EMA |
| MACD / Stochastic | ❌ | нет |

### `calculateEma` / `calculateRsi` / `calculateAtr`

```ts
export function calculateEma(data: number[], period: number): number | null {
  if (data.length < period) return null
  const k = 2 / (period + 1)
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k)
  }
  return ema
}

export function calculateRsi(data: number[], period = 14): number {
  if (data.length < period + 1) return 50
  // Wilder smoothing → scalar 0..100
  ...
}

export function calculateAtr(candles: OhlcvCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null
  // TR average over last `period` → scalar
  ...
}
```

**Важно для графика:** EMA/RSI/ATR сейчас — **скаляры для сканера**, не time-series для line overlay. Для отрисовки на LiveChart нужны series-версии (`number[]` на каждую свечу).

### Типы зон (в SMC, не в `types.ts`)

```ts
export interface OrderBlock {
  type: 'BULLISH' | 'BEARISH'
  top: number
  bottom: number
  low?: number
  high?: number
  index: number      // индекс свечи
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

export interface ConfluenceResult {
  score: number
  zones: string[]   // человекочитаемые лейблы
  bestZone: {
    top: number | null
    bottom: number | null
    sl: number | null
  }
}
```

### `findOrderBlocks()` — полный код

```ts
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
        ? Array.from({ length: 10 }, (_, k) =>
            Math.abs(closes[i - 10 + k] - opens[i - 10 + k])
          ).reduce((a, b) => a + b, 0) / 10
        : candleBody

    // BULLISH OB: red candle + strong impulse up, zone not broken
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

    // BEARISH OB: green candle + strong impulse down
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

### `findFvg()` — полный код

```ts
export function findFvg(candles: OhlcvCandle[], maxGaps = 5): FairValueGap[] {
  if (candles.length < 5) return []

  const highs = candles.map((c) => c[2])
  const lows = candles.map((c) => c[3])
  const fvgList: FairValueGap[] = []

  for (let i = 2; i < candles.length; i++) {
    // BULLISH gap: low[i] > high[i-2]
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

    // BEARISH gap: high[i] < low[i-2]
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

---

## 4. `src/engine/types.ts` — релевантные типы

### `OhlcvCandle`
**Не в `types.ts`.** Живёт в `src/api/mexc/index.ts`:

```ts
export type OhlcvCandle = [number, number, number, number, number, number]
// [ts_ms, open, high, low, close, volume]
```

### Зоны OB / FVG / Fib
**Не в `types.ts`.** Определены в `src/engine/smc/index.ts` (см. выше).

### Типы для индикаторов на графике
**Нет** dedicated chart-indicator types. Есть только legacy:

```ts
/** @deprecated Kept for backward-compat; unused in SMC path */
export interface IndicatorBucket {
  win_rate: number
  samples: number
  direction: 'LONG' | 'SHORT'
  avg_return: number
}
```

Это **не** индикаторы (EMA/BB), а legacy win-rate bucket для старого UI.

### `CoinSignal` (полный)

```ts
export interface CoinSignal {
  symbol: string              // flat BTCUSDT
  internalSymbol: string      // BTC/USDT:USDT
  displayName: string         // BTC/USDT
  price: number
  priceChange24h: number
  currentRSI: number | null
  probabilityPct: number      // 0-100
  score: number
  direction: TradeSide | null
  zones: string[]             // ← только строки-лейблы!
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
  activeSignal: IndicatorBucket | null
  activeSignalKey: string | null
}
```

---

## 5. `src/store/useAppStore.ts`

### Что хранится
| Поле | Назначение |
|------|------------|
| `liveTickets` | цены для live-апдейта последней свечи |
| `signals` | `CoinSignal[]` (результат сканера) |
| `marketContext` | daily bias / BTC trend / scan progress |
| `selectedCoin` / `isDrawerOpen` | UI drawer |
| `extraWatchlist` | доп. монеты (localStorage) |
| `isScanning`, `connectionStatus` | статус |

### Данные графика
**Не в store.** Candles и timeframe — локальный state `LiveChart`.

### Preferences / theme / indicators
**Нет.** Нет `chartSettings`, `enabledIndicators`, theme switch для графика.

---

## 6. `ProbabilityEngine` — как считаются OB / FVG

OB/FVG **не** хранятся в `CoinSignal`. Они считаются локально внутри `analyzeSymbol()` и сразу уходят в `calculateConfluence()`:

```ts
// ProbabilityEngine.analyzeSymbol()
const orderBlocks = findOrderBlocks(ohlcv1h, coinStructure)  // 1H candles
const fvgList = findFvg(ohlcv1h)

// ...
const confluence = calculateConfluence(
  currentPrice,
  orderBlocks,
  fvgList,
  fibLevels,
  side
)
// → confluence.zones: string[]
// → confluence.bestZone: { top, bottom, sl }
```

В `CoinSignal` попадает:
- `zones: string[]` — например `"OB Bullish [1.234-1.250]"`, `"FVG Bearish [...]"`, `"Fibo OTE [...]"`
- `sl / tp1 / tp2 / tpDaily` — числовые уровни **только** при triggered setup
- **НЕ** попадают: массивы `OrderBlock[]`, `FairValueGap[]`, полный `FibLevels`

Координаты зон **есть внутри строк** (`[bottom-top]`), но структурированных полей `zoneTop/zoneBottom` в `CoinSignal` нет (кроме `sl/tp*` и ephemeral `bestZone` внутри confluence).

---

## 7. Структура `CoinSignal.zones` — итог

| Вопрос | Ответ |
|--------|--------|
| `zones: string[]`? | Да — человекочитаемые лейблы из confluence (+ опционально `WALL_BOOST: ...`) |
| Есть ли координаты зон? | Частично: цены **в тексте** лейбла; структурно — только `sl/tp1/tp2/tpDaily` при setup; `bestZone` не сохраняется в signal |
| Где OB/FVG после анализа? | **Нигде persistent.** Локальные переменные в `analyzeSymbol`, затем отбрасываются. Для графика нужно **пересчитать** `findOrderBlocks` / `findFvg` на свечах текущего TF LiveChart |

---

## Выводы для реализации индикаторов / зон на графике

### Готово к переиспользованию
- Математика OB / FVG / Fib / EMA / RSI / ATR в `smc/`
- OHLCV pipeline через `fetchOhlcv`
- Lightweight Charts v4 candlestick series

### Нужно добавить
1. **Series-версии индикаторов** (EMA/BB/VWAP как массивы `{time, value}`)
2. **Overlay слой** в LiveChart:
   - `createPriceLine` для SL/TP/Fib
   - `addLineSeries` для EMA/VWAP
   - зоны OB/FVG: через `setMarkers` + price lines, или HTML/Canvas overlay (LWC v4 не рисует filled rectangles нативно)
3. **Пересчёт зон на TF графика** (сейчас SMC зоны на 1H из сканера)
4. **UI toggles** (локальный state или store preferences)
5. Опционально расширить `CoinSignal` полем `liquidityZones: Array<{type, top, bottom, fromTime}>` — если нужно шарить со сканером

### Рекомендуемый минимальный план
1. Хук `useChartOverlays(candles, options)` → EMA series + OB/FVG boxes data  
2. В LiveChart: line series + `createPriceLine` для горизонталей  
3. Для прямоугольных зон — lightweight custom overlay (div/canvas) поверх `chartContainerRef`  
4. Toggle-кнопки рядом с TF selector
