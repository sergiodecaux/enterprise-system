# Ядро поиска сделок: как искали раньше и как сейчас

Документ про **алгоритм поиска входа**, не про Telegram/cron/failover.  
Код: `workers/mexc-proxy/src/`.

---

## 0. Суть в одной фразе

| | |
|---|---|
| **Раньше (высокий WR)** | PEAK_FUEL_FAIL v27.1 — peak-only, мягкие пороги, до 5 алертов/тик |
| **v29–v31 / v32** | CONT / regime / ageGate — то молчание, то не то ядро |
| **Сейчас мемы (v28.5)** | **JEWELER BURST** · classic memes PEPE/WIF/DOGE/BONK · no LDO/FET/HYPE · relative walls |
| **Альты** | ALT_JEWEL book forecast L/S |

Мемы: Predator принимает только `source:jeweler_burst`; legacy и внешний
`jeweler_live` не могут отправить торговый сигнал.

---

## 1. Конвейер мемов (v28.3 Jeweler Burst)

```
Hotlist: 6 movers + 6 liquid sideways       hotMemeWatchlist.ts
    ↓ sticky keep: rockets |chg|≥4 OR liquid |chg|<6
до 12 имён: 120×1m свечи + phase/tail + BTC context
    ↓
live 3-snap стакан на 6 лучших (3 слота RANGE)   orderBookReader.ts
    ↓ crowd bait / spoof magnet / trapped asks   analyzeCrowdBook
    ↓ toxic (wash/spoof) → skip this tick
PEAK: LONG accumulation→impulse · SHORT extension→distribution
RANGE: коробка номинирует LONG и SHORT без hammer/shooting
RANGE low/high: reclaim/reject при sync ≥8 + aligned forecast
RANGE middle: стакан выбирает сторону (sync 15 + direction score ≥75)
    ↓ если оба прошли — зазор quality ≥4, иначе skip
    ↓ BTC veto · momentum/tape · SYNC ≥ 8
    ↓ ≥2 book evidence + realBook/event
quality без базового якоря: SILVER 68 · GOLD 75 · PLATINUM 85
MEME_BOOK_LONG / PEAK_FUEL_FAIL → paper-first → Telegram → журнал
```

Любой meme alert без `source:jeweler_burst` блокируется перед paper/TG.  
Альты: `eliteAltJewel.ts` на Elite.
WR монеты: prefer по последним 3 WIN/LOSS; STOCK и дамперы по-прежнему block.

---

## 2. Как искали в первых версиях

### 2.1. CONT_* — continuation по событию стакана

**Идея:** день уже PUMP/DUMP → ждём MM-событие в стакане → входим с потоком.

Что читали:

- `dayBias` (24h)
- depth (стены, OBI)
- deals (buy/sell flow, move bps)
- паттерны MM (`mmPatterns.ts`)

| Паттерн | Что искали | Типичный вход |
|---|---|---|
| **ABSORPTION** | Лента бьёт в одну сторону, цена почти не едет → кит абсорбирует | LONG при sell-tape / SHORT при buy-tape |
| **BOOK_RELEASE** | Стена снята (vacuum) после persist | LONG на ASK pull / SHORT на BID pull |
| **TRAP_FLIP** | Стена сорвана без persist (spoof) | Часто ложный сигнал |

Пороги (legacy MM):

- absorb: quote ≥ ~$7k / 30s, \|move\| ≤ ~12 bps, conf ≥ ~82
- wall release: persist, drop ≥ ~60%, flow ≥ ~58%, spread ≤ ~55 bps
- уровни: SL ~0.8%, TP1 ~1.5%, TP ~2.0%

**Autopsy CONT_\*:**

- общий WR ~58%; лучший подтип — absorption
- TRAP_FLIP ~10% WR → токсик
- много DEAD: MFE &lt; 0.35% — вход без follow-through

**Сейчас (v32):** `allowMemeFlowEvent()` снова в бою — CONT_* WITH day (absorption / wall / flow). TRAP/LIQ/SPOOF kill. PEAK/PUMP — fallback если CONT не сработал.

### 2.2. Зоны ликвидности (scanner / HTF SSL-BSL)

**Идея:** найти HTF-зону → ждать APPROACH/TOUCH → confluence.

- фазы: FAR / APPROACH (dist ≤ ~0.8%) / TOUCH
- стиль WITH_TREND / COUNTER
- book/fuel как усилители, не жёсткий gate

Мем-путь scanner со временем сузили; основной meme combat ушёл в `memeOrderFlow`.

### 2.3. LIQUIDATION_ECHO (пробовали, cron OFF)

**Идея:** волна ликвидаций → fade → post-only на эхо.

- flush ≥ ~$20k / 3s, move ≥ ~1.2%
- fade 2s, стена ≥ ~$5k, узкий spread
- fill timeout секунды, TP ~1.1%, SL ~0.7%

Код жив (`liquidationEcho.ts`), в текущем поиске **не участвует**.

### 2.4. VANE MACRO / MICRO (альты, auto OFF)

**Идея:** HTF-зона / range-break / momentum + book grade + 1m with us + impulse band.

| | MACRO | MICRO |
|---|---|---|
| Impulse | 0.5–2.4% | 0.35–0.85% |
| Risk / TP | ~0.85% / 1.5–3.8% | ~0.35% / 0.45–0.7% |
| Контекст | ZONE / RANGE_BREAK / MOMENTUM | только WITH HTF, tight touch |

Сейчас auto-VANE выключен (ассистент). Логика зон осталась в коде, но не ядро мем-поиска.

---

## 3. Ядро сейчас: что именно проверяет детектор

### 3.1. Общий принцип A-класса (v30)

Раньше: `event.ready` → алерт.  
v29: структура + realBook.  
**v30** — одновременно:

1. **Universe** — vol accel / pre-move предпочтительнее хвоста 24h pump  
2. **Фаза** — ACCUMULATION→MARKUP (LONG) или DISTRIBUTION→MARKDOWN (SHORT); шаги 1–4 по порядку  
3. **MM intention** — mustDefend / mustExit / FLAT (не шортить в mustDefend LONG)  
4. **Temporal coherence** — wall age, tape consistent, price vs tape  
5. **Структура** 1m + **Book forecast** realBook + !toxic + bias  
6. **Confirm** + окна dist/conf/chg  

Tape alone → B или skip.

Модули: `volumeAccel.ts`, `phaseDetector.ts`, `intentionReader.ts`.

---

### 3.2. PEAK_FUEL_FAIL — SHORT у хая (`peakFuelFail.ts`)

**Идея:** памп stall у хая без топлива → SHORT. Стакан нужен, чтобы видеть, куда робот гонит толпу, не чтобы закрыть вход новыми гейтами.

#### Сейчас (v27.3)

| | |
|---|---|
| Свечи | failed_break / rejection_wick / lower high / stall · dist ≤ 1.8% · chg24 ≥ 4 |
| Книга | live 3-snap на **2–3** prefer+PUMP; остальные — только свечи, **без** фейкового buyFlow=58 |
| Толпа | `analyzeCrowdBook`: мелкие asks / yank+bid magnet → мягкий минус; живая ask-стена + покупки не едут → плюс |
| Toxic | wash/spoof/trap → skip **этот тик**, не бан монеты |
| conf | ≥ 70 (crowd ±3 за пункт) |
| Prefer | последние 3 WIN/LOSS; STOCK и wr<40 / 2L0W — block |

#### Уровни / выход

- SL **+1.0%** · TP1 **−1.1%** → BE · TP2 **−1.8%**
- OBI-flip runner: ≥15 пт против **два тика** и не пока MFE обновляет экстремум

---

### 3.3. PUMP_CONTINUE — LONG у хая (`pumpContinue.ts`)

**Идея:** ACCUMULATION→MARKUP, MM mustDefend bid.

#### Класс A (v30)

| Условие | Порог |
|---|---|
| Phase / intention | ACCUM steps / MARKUP · mustDefend ∨ LONG ∨ FLAT |
| Structure | impulse \| HH \| (reclaim∧book) |
| Book | !toxic, **realBook**, score ≥ **62**, NEXT_UP |
| conf | ≥ **68** |
| chg24 | ≥ 7 **или** preMove ≥ 3.5 · cap 55% |

Выход тот же: TP1 +0.8% → BE → TP2 +2.0%.

---

### 3.4. DUMP_FUEL_FAIL — LONG reclaim (muted, 0% WR)

Зеркало PEAK: dump day → bounce → LONG reclaim — **выключен**.

### 3.4b. DUMP_CONTINUATION — SHORT (`dumpContinuation.ts`)

Trend-follow после дампа:

- chg24 ≤ **−8%**
- bounce **+1.5…4%** от trough **без** realBook bid support
- OI не покрывается на отскоке
- первая красная 1m с объёмом (+ растущие верхние фитили на зелёных отскока)
- → Predator SHORT A

- trough + bounce ≥ ~5.5%, age ≥ ~18m, higher low  
- fresh tip / still dumping → reject  
- A требовал book+candle или жёсткий candle-path  

**Статус:** после journal ~0% WR — в оркестраторе выключен (`if (false && …)`). Алгоритм в `dumpFuelFail.ts` сохранён.

---

### 3.5. Book forecast — сердце «сейчас» (`memeBookForecast.ts`)

| | Tape-only (раньше хватало) | Forecast (сейчас) |
|---|---|---|
| Сигнал | buyFlow / move / MM ready | score + realBook + bias + toxic |
| realBook | «есть лента» | absorb/CVD **или** OBI build + wall persist **или** OBI align + wall/absorb |
| strongTape | мог открыть вход | даёт очки, **один не открывает A** |
| toxic | почти не блок | WASH / SPOOF / CONFLICT / trap_flip / wall_yank → **hard skip** |
| bias | не было | `NEXT_UP` / `NEXT_DOWN` / `CHOP` / `TRAP` |

---

### 3.6. ALT_JEWEL — поиск по альтам (`eliteAltJewel.ts`)

Не мемы, не CONT, не VANE-зона.

1. Пул ликвидных альтов, quote vol ≥ **$8M**, \|chg24\| &lt; 25%  
2. Rank по объёму → **топ-3**  
3. На каждый: book → forecast **только SHORT**  
4. Gates: !toxic, realBook, score ≥ **62**, bias `NEXT_DOWN`  
5. Impulse 1m в сторону шорта: **0.28–0.95%** (уже пошёл, не tip)  
6. Последняя закрытая 1m красная; conf ≥ **72**  
7. Лучший из 3 → max 1 сигнал  

Уровни: SL **0.40%**, TP **0.80%** (≈ +40% ROE @ ×50).

---

## 4. THEN vs NOW — таблица ядра

| Фича | Раньше (CONT / zones / VANE / echo) | Сейчас (A combat) |
|---|---|---|
| Главный триггер | wall/MM event, zone touch, liq wave | структура у хая + fuel |
| dayBias | фильтр стороны CONT | PUMP → PEAK/PUMP; DUMP reclaim muted |
| OBI / CVD / walls | прямой entry | вклад в **forecast.realBook** |
| Tape | часто достаточен | только fuel/score; без depth → B/skip |
| Свечи | слабо / «1m with us» у VANE | failed/wick/HH/impulse + confirm |
| OI | редко | PEAK: flat/weak; PUMP: rising |
| Toxic / trap | trap часто = «сигнал» | toxic = **запрет** |
| Класс | ready → alert | в бой только **A** |
| Цель | TP1 / trail / ранний BE | binary: +2% @×20 или +0.8% @×50 |
| Альты | VANE zone spam | top-3 liquid + impulse band (ALT_JEWEL) |

---

## 5. Чеклист A-tier (боевой минимум)

### PEAK SHORT A
`failed|wick` + bearish follow + bookAllowsA + conf≥70 + fuel≥1 + dist 0.22–1.45% + chg≥9% + !toxic  

### PUMP LONG A
`impulse|HH|(reclaim∧book)` + fuelAlive + pressure + realBook score≥58 `NEXT_UP` + candle + score≥6 + conf≥66 + dist 0.18–1.85% + chg 7–55%  

### ALT SHORT A
top-3 vol + realBook≥62 `NEXT_DOWN` + impulse 0.28–0.95% + 1m with + conf≥72  

---

## 6. Эволюция ядра по этапам (только поиск)

1. **Событийный order-flow** — CONT/ABSORPTION/RELEASE/TRAP по MM ready  
2. **Зонный / VANE** — HTF touch + confluence + impulse band  
3. **Сужение до экстремума** — PEAK SHORT / PUMP LONG у хая (структура свечей + OI)  
4. **Отказ от tape-only A** — forecast: realBook обязателен, toxic = skip  
5. **Binary target** — один TP по ROE, без раннего trail (сопровождение, не поиск)  
6. **DUMP muted** — reclaim-алгоритм есть, в поиске не вызывается  
7. **ALT_JEWEL** — тот же forecast-gate, другая вселенная (ликвидные альты) и полоса impulse  

---

## 7. Файлы ядра

| Файл | Роль в поиске |
|---|---|
| `memeOrderFlow.ts` | оркестратор hotlist → book → детекторы |
| `hotMemeWatchlist.ts` | вселенная мем-тиков по 24h |
| `orderBookReader.ts` | depth/deals → события/OBI/tape |
| `mmPatterns.ts` | ABSORPTION / RELEASE / TRAP (legacy entry → сейчас кадры) |
| `memeBookForecast.ts` | realBook / toxic / bias score |
| `peakFuelFail.ts` | PEAK SHORT |
| `pumpContinue.ts` | PUMP LONG |
| `dumpFuelFail.ts` | DUMP LONG (muted) |
| `eliteAltJewel.ts` | топ-3 альт SHORT |
| `candleConfirm.ts` | 1m/2m confirm |
| `vane/macroStrategy.ts` · `microStrategy.ts` | старое альт-ядро (auto OFF) |
| `liquidationEcho.ts` | старое echo-ядро (OFF) |

---

*Фокус документа — логика поиска входа. Доставка в Telegram, paper TTL и failover сюда не входят.*
