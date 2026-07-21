# Sessions Overlay — Planning Research

**Дата:** 2026-07-20  
**Цель:** подготовка к наложению торговых сессий (Asia / London / NY) на LiveChart  
**Статус:** только исследование

---

## Краткие ответы Q1–Q5

| # | Ответ |
|---|--------|
| **Q1** | Да: `CHART_HEIGHT = 260`. Да: на relative-контейнере есть `overflow-hidden` |
| **Q2** | **Оба** используют `timeScale.subscribeVisibleLogicalRangeChange` + дополнительно `subscribeCrosshairMove` + `ResizeObserver` |
| **Q3** | LWC хранит `Time` как **unix seconds (UTC)**. MEXC kline: API отдаёт seconds → код делает `* 1000` в ms; **timezone offset в пайплайне нет** — всё UTC |
| **Q4** | Фонового session/background series **нет**. Есть: LWC layout `#111111`, ChartOverlay (zones z:1), PredictionOverlay (line series + canvas z:2). Custom primitives / background series — **нет** |
| **Q5** | Сессии имеют смысл на **1m / 5m / 15m / 1h**. На **4h / 1d** — мало смысла (бар ≥ полсессии / сутки) |

---

## 1. LiveChart — relative контейнер и overlays

### Константа и containerRef

```ts
const CHART_HEIGHT = 260
const containerRef = useRef<HTMLDivElement>(null)
// createChart(..., { width: containerRef.clientWidth, height: CHART_HEIGHT })
// ResizeObserver → applyOptions({ width, height: CHART_HEIGHT })
```

- **Размеры:** ширина = `clientWidth` host-div; высота = **фиксированные 260px**
- **Host LWC:** `<div ref={containerRef} className="h-full w-full" />` внутри relative parent
- **timeScale subscription в LiveChart:** **нет** напрямую. Подписки только внутри overlay-компонентов. LiveChart сам: `fitContent()` после `setData`, ResizeObserver на ширину

### JSX блок графика (актуальный порядок слоёв)

```tsx
<div
  className="relative w-full overflow-hidden rounded-lg border border-hull-border bg-hull"
  style={{ height: CHART_HEIGHT }}
>
  {/* loading — absolute z-10 */}
  {/* error — absolute z-10 */}

  <div ref={containerRef} className="h-full w-full" />
  {/* ↑ LWC canvas (base) */}

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
  {/* ↑ z-index: 1 — OB/FVG DOM boxes */}

  {showForecast && forecast && chartReady > 0 && (
    <PredictionOverlay
      chart={chartRef.current}
      series={candleRef.current}
      forecast={forecast}
      activeScenarios={activeScenarios}
      containerRef={containerRef}
    />
  )}
  {/* ↑ z-index: 2 — forecast LineSeries + canvas cone */}
</div>
```

### Рекомендуемый z-index для Sessions Overlay

| Layer | z |
|-------|---|
| Sessions background bands | **0** или **0.5** (под зонами) / absolute под ChartOverlay |
| LWC | base |
| ChartOverlay | 1 |
| PredictionOverlay | 2 |
| loading/error | 10 |

Сессии логично рисовать **под** зонами и прогнозом (`zIndex: 0` sibling перед ChartOverlay, или внутри LWC через markers/background — TBD).

---

## 2. ChartOverlay — паттерн redraw

**Файл целиком:** `src/components/tactical/ChartOverlay.tsx` (147 строк)

### Паттерн (для копирования Sessions)

```ts
const redraw = () => { /* compute coords → DOM/canvas */ }
redraw()
timeScale.subscribeVisibleLogicalRangeChange(onVisible)
chart.subscribeCrosshairMove(onVisible)
ResizeObserver → redraw
cleanup: unsubscribe + disconnect
```

### X через timeToCoordinate

```ts
const startX = timeScale.timeToCoordinate(zone.startTime as Time)
const endX = timeScale.timeToCoordinate((zone.endTime ?? zone.startTime) as Time)
// null → skip zone (или endX ?? containerWidth)
// left = max(0, startX); width = endX - startX (clamped)
```

`zone.startTime` / `endTime` уже в формате LWC `Time` (unix seconds), из candles `ts_ms / 1000`.

---

## 3. PredictionOverlay — canvas X для timestamp

Актуальный canvas-effect (после перехода на LineSeries пути):

```ts
const timeToX = (ts: number) =>
  timeScale.timeToCoordinate(ts as Time) as number | null

// для cone:
const ts = forecast.lastCandleTimestamp + pp.timeOffsetSeconds
const x = timeToX(ts)
```

- Forecast **линии** — native `addLineSeries` с `time: lastCandleTs + offset` (не canvas)
- Canvas cone / liq: `timeToCoordinate(lastCandleTimestamp + offset)`
- Синхронизация: **`subscribeVisibleLogicalRangeChange(redraw)`** + crosshair + ResizeObserver

---

## 4. package.json — зависимости

| Пакет | Есть? | Версия |
|-------|--------|--------|
| date-fns | ❌ | — |
| dayjs | ❌ | — |
| luxon | ❌ | — |
| moment | ❌ | — |
| **React** | ✅ | `^18.2.0` |
| **TypeScript** | ✅ (dev) | `^5.2.2` |
| lightweight-charts | ✅ | `^4.1.3` |

**Вывод:** timezone-библиотеки нет. Для сессий достаточно ручного UTC→NY/London с `Intl` / offset tables, либо добавить `dayjs` + `utc`/`timezone` плагины.

---

## 5. i18n/ru.json — первые ~30 ключей

```json
{
  "app_title": "ENTERPRISE SYSTEM",
  "app_subtitle": "ТЕРМИНАЛ ВЕРОЯТНОСТЕЙ",
  "status_online": "СЕНСОРЫ В СЕТИ",
  "status_offline": "СЕНСОРЫ ОТКЛЮЧЕНЫ",
  "status_polling": "ОПРОС MEXC",
  "status_scanning": "СКАНИРОВАНИЕ СЕКТОРА...",
  "connection_unavailable": "Подключение недоступно. Проверьте VPN или сеть.",
  "radar_title": "РЫНОЧНЫЙ РАДАР",
  "radar_subtitle": "10 основных пар + поиск · по вероятности успеха",
  "search_placeholder": "Поиск монеты (например PEPE, WIF)...",
  "search_loading": "Загрузка списка MEXC...",
  "search_empty": "Ничего не найдено",
  "search_add": "Добавить",
  "search_added": "Уже в списке",
  "column_asset": "АКТИВ",
  "column_signal": "СИГНАЛ",
  "column_probability": "ВЕРОЯТНОСТЬ",
  "column_action": "ДЕЙСТВИЕ",
  "signal_long": "ЛОНГ",
  "signal_short": "ШОРТ",
  "signal_neutral": "НЕЙТРАЛЬНО",
  "signal_waiting": "КАЛИБРОВКА...",
  "signal_setup": "СЕТАП",
  "tactical_title": "ТАКТИЧЕСКИЙ ДИСПЛЕЙ",
  "tactical_probability": "ВЕРОЯТНОСТЬ УСПЕХА",
  "tactical_direction": "НАПРАВЛЕНИЕ",
  "tactical_samples": "ИСТОРИЧЕСКИЕ СКАНЫ",
  "tactical_avg_return": "СРЕДНЯЯ ДОХОДНОСТЬ",
  "tactical_rsi": "ПОКАЗАНИЕ RSI",
  "tactical_score": "ОЦЕНКА",
  "tactical_trend": "ТРЕНД"
}
```

Формат: плоский JSON, ключ → русская строка (en.json зеркалит те же ключи).

---

## Q3 детально — время MEXC → LWC

```ts
// fetchOhlcv
candles.push([
  d.time[i] * 1000,  // MEXC unix seconds → ms
  open, high, low, close, vol
])

// LiveChart → LWC
time: (c[0] / 1000) as Time  // обратно в seconds
```

- Нет `getTimezoneOffset`, нет local conversion
- Сессии (Asia 00–08 UTC, London 07–16 UTC, NY 13–22 UTC — типовые) нужно считать в **UTC** от bar open time

---

## Рекомендации для Sessions Overlay

1. **Компонент:** `SessionsOverlay.tsx` по паттерну ChartOverlay (DOM bands или canvas)
2. **Вход:** `chart`, `containerRef`, `candles` (или visible range), `timeframe`, `enabled`
3. **Показывать только если** `timeframe` ∈ `1m|5m|15m|1h`
4. **z-index: 0** — под зонами/прогнозом; низкая opacity (8–15%)
5. **Пересчёт X:** для каждого session segment `[startTs, endTs]` → `timeToCoordinate`; clip к `[0, W]`
6. **Timezone:** без новых deps — фиксированные UTC windows; позже dayjs-timezone если нужны DST London/NY
7. **Toggle:** в `ChartPreferences` / ChartSettings (`sessions: boolean`)
8. **overflow-hidden:** вертикальные badges сессий — внутри полосы, не выше top

### Типовые UTC окна (черновик)

| Session | UTC start | UTC end | Color hint |
|---------|-----------|---------|------------|
| Asia | 00:00 | 08:00 | indigo soft |
| London | 07:00 | 16:00 | amber soft |
| New York | 13:00 | 22:00 | blue soft |

(Пересечения London/NY — норма; полупрозрачные полосы могут накладываться.)
