# Система процесса (теория Ремизова) — полное описание

Документ описывает, **как устроен слой «процесса»** в Enterprise System: кадры order flow → последовательности → режим → сигналы на графике. Это не отдельный бот и **не связано с meme-ботом** (`memeOrderFlow` не трогаем).

Актуально для клиентского пути: **Tactical Drawer / Live Chart / Elite live signal**.

---

## 1. Идея в одном абзаце

Рынок читается не как «формула индикатора», а как **фильм коротких кадров** (удары в стену, перевес стакана, открытый интерес, дельта покупок/продаж). Когда кадры складываются в узнаваемую **последовательность**, наступает её **предел** (момент решения) — например: «стену били продажами, она выстояла, агрессия стихла → смотри отскок вверх». Режим рынка (тренд / боковик / хаос) — **первый кадр**: он решает, можно ли этот предел брать в работу или только наблюдать.

---

## 2. Где это живёт в продукте

```
MEXC WS / REST
   │
   ├─ OrderBookPanel  ──► киты, стены, сделки, CVD, OI
   │         │
   │         ▼
   │   ingestAndDetectSequence()
   │         │  кадры → FrameBus
   │         │  детекторы → SequenceHit
   │         ▼
   │   Zustand: sequenceHits[symbol]
   │
   ├─ ProbabilityEngine ──► marketRegime на CoinSignal
   │
   └─ LiveChart / findLiveSignal
            │
            ├─ ProcessStrip          (режим · контракты · лента 5м)
            ├─ WhaleLevelsOverlay    (ОПОРА / КРЫША)
            ├─ SequenceProcessOverlay (МОМЕНТ ↑/↓ у стены)
            ├─ ChartHintsOverlay     (Подсказки ON/OFF)
            ├─ DeltaSparkline        (покупки/продажи 5м)
            └─ SignalNowPanel        (что сейчас → действие)
```

**Важно:** детект последовательности крутится на клиенте при обновлении стакана (`OrderBookPanel`). Meme cron / worker paper — отдельный контур.

---

## 3. Словарь на экране (без биржевого жаргона)

| На экране | В коде / на бирже | Смысл |
|-----------|-------------------|--------|
| **ОПОРА** | BID / support / whale bid | Крупные **хотят купить** лимиткой **ниже** цены. Стена снизу. |
| **КРЫША** | ASK / resistance / whale ask | Крупные **хотят продать** лимиткой **выше** цены. Стена сверху. |
| **Удары** | HIT / market aggression | Рыночные покупки или продажи, бьющие в стену. |
| **Момент** | Sequence limit / «предел» | Последовательность дозрела до точки решения. |
| **Контракты** | Open Interest (OI, `holdVol`) | Сколько позиций открыто; рост/падение с ценой = «есть/нет топлива». |
| **Покупки / продажи** | Delta / CVD tape | Баланс агрессии покупателей и продавцов. |
| **Тренд / Боковик / Хаос** | `MarketRegime` | Первый кадр: какие сценарии вообще разрешены. |

Цвета на графике:
- циан/бирюза ≈ опора / лонг-контекст;
- оранж ≈ крыша / шорт-контекст;
- зелёный / красный на sparkline ≈ покупки / продажи.

---

## 4. Кадры (`MarketFrame`) — «плёнка»

Код: `src/engine/sequence/frameBus.ts`, сборка в `ingestAndDetect.ts` → `buildFrames()`.

На каждый тик стакана (и связанных данных) режется набор микро-событий:

| `kind` | Откуда | Что означает |
|--------|--------|--------------|
| `REGIME` | `CoinSignal.marketRegime` | Состояние рынка |
| `BOOK` | imbalance стакана | Перевес лимитных заявок |
| `WALL` | кит / wall events | Стена (опора или крыша), съедена / спуф |
| `HIT` | лента сделок ~1м | Объём рыночных BUY/SELL в $ |
| `DELTA` | enhanced CVD | Тренд дельты / агрессия |
| `OI` | ticker open interest | Изменение контрактов и дивергенция с ценой |
| `PA` / `VOL` | зарезервированы | Пока почти не используются |

Хранение: **кольцевой буфер в памяти браузера** на символ (до ~160 кадров). Не пишется на сервер. Окно для UI-ленты обычно **5 минут**.

Полоска точек в `ProcessStrip` — это последние интересные кадры (`HIT`, `WALL`, `DELTA`, `OI`, `BOOK`).

---

## 5. Режим рынка — первый кадр

Режим считает `ProbabilityEngine` → `detectMarketRegime`, лежит в `signal.marketRegime`.

| Режим | Смысл для трейдера | Что разрешаем из последовательностей |
|-------|--------------------|--------------------------------------|
| `TRENDING_STRONG` | Сильный тренд | Продолжение: снятие стены, OI-подтверждение. **Не** fade от стены как primary |
| `TRENDING_WEAK` | Слабый тренд | И отскок, и продолжение — смотри процесс |
| `RANGING` | Боковик | Работа от опоры/крыши (absorb, CVD-div) |
| `VOLATILE_CHOP` | Хаос после импульса | Почти всё primary выключено — лучше ждать |

Логика допуска: `src/engine/sequence/regimeGate.ts`.

- `allowedInRegime === false` → на UI показывается **«не сейчас»**: процесс есть, вход не предлагаем.
- Множитель уверенности `regimeConfidenceMul` режет score, если режим чужой.

Те же правила фильтруют классические сетапы в `findLiveSignal` через `setupFitsRegime` (BOUNCE / BREAK / CONTINUATION / …).

---

## 6. Последовательности (`SequenceHit`)

Код: детекторы в `src/engine/sequence/*`, оркестратор `ingestAndDetectSequence()`.

На каждом цикле строятся кандидаты, берётся **лучший**: сначала `allowedInRegime`, потом `confidence`. К hit подмешивается история из локального журнала (`applySequenceHistWr`).

### 6.1 `WALL_ABSORPTION_EXHAUSTION` — стена выдержала удары

**Процесс:** агрессия бьёт в крупную стену → стена жива (не съедена) → объём ударов достаточный → агрессия начинает стихать → **момент отскока**.

- Опора + продажи в неё → **LONG**
- Крыша + покупки в неё → **SHORT**

Пороги (ориентиры): стена ≳ $400k, удары ≳ $250k / 5м, дистанция до стены ≲ 2.5%. TTL ~90с.

**Режим:** да в боковике и слабом тренде; нет в сильном тренде и хаосе.

### 6.2 `CVD_DIVERGENCE_LIMIT` — цена и поток разошлись

**Процесс:** цена идёт в одну сторону, накопленная дельта / агрессия — в другую → топливо хода иссякает → разворот/откат.

**Режим:** боковик / слабый тренд; не в сильном тренде и не в хаосе.

### 6.3 `WALL_RELEASE` — стену сняли

**Процесс:** стену били → её **съели** (`EATEN` за ~60с) → лента согласна (покупки после снятия крыши / продажи после снятия опоры) → импульс продолжения.

- Сняли крышу + покупки → **LONG**
- Сняли опору + продажи → **SHORT**

**Режим:** хорошо в тренде; в хаосе выкл.; в боковике слабее.

### 6.5 `TRAPPED_TRADERS` — запертые / топливо

**Процесс:** цена у стены → OI растёт → агрессия экстремальна → цена почти не идёт (кит поглощает) → агрессия иссякает (часто после LIQ) → толпа = топливо для разворота.

**Режим:** боковик / слабый тренд; в сильном тренде выкл.; в хаосе допускается после liq climax.

---

## 7. Киты и стены

Код: `src/engine/orderbook/whaleDetector.ts` + UI `WhaleLevelsOverlay`.

1. Стакан → strongest support / resistance (крупный лимитный объём).
2. На график **не** рисуются через `createPriceLine` (они тянули шкалу вниз). Только HTML-оверлей: пунктир + бейдж **ОПОРА / КРЫША**.
3. Алерты в шапке дровера: `WhaleAlertBanner` — те же слова.
4. События стены (`EATEN`, `SPOOFED`) → кадры `WALL` и вход в `WALL_RELEASE` / absorb.

Под бейджем: «крупные хотят купить · стена снизу» / «…продать · стена сверху» + цена + объём + «ниже/выше X%».

---

## 8. Открытый интерес (OI)

Код: `src/engine/sequence/oiTracker.ts`.

- Источник: `ticker.openInterest` / `holdVol`, опрос ~раз в 20с из `OrderBookPanel`.
- Сэмплы в памяти → снимок за ~15м: `changePct`, `priceChangePct`, `confirmsMove`, тип дивергенции (`DISTRIBUTION`, `SHORT_BUILD`, …).
- Идёт в кадры `OI`, детектор `OI_DELTA_CONFIRM` и текстовые подсказки.

---

## 9. Как рождается «что делать сейчас»

1. `OrderBookPanel` вызывает `ingestAndDetectSequence` → `setSequenceHit(symbol, hit)`.
2. `LiveChart` берёт hit из store + зонный/MM анализ → `findLiveSignal({ sequence })`.
3. Если confidence ≥ 55, sequence добавляется в **сценарии** live-сигнала (тип `SEQUENCE_LIMIT`) с учётом `allowedInRegime`.
4. `recordSequenceHit` пишет в **локальный journal** (для hist WR), когда уверенность достаточна.
5. UI:
   - **ProcessStrip** — режим, контракты, точки кадров, «Момент ↑/↓»;
   - **SequenceProcessOverlay** — полоса «удары $…» у стены + маркер **МОМЕНТ**;
   - **ChartHintsOverlay** (`buildChartHints`) — до 4 карточек простым языком (кнопка **Подсказки ON/OFF**);
   - **DeltaSparkline** — покупки/продажи за 5м;
   - **SignalNowPanel** — нарратив: что сейчас → предел → действие.

---

## 10. Подсказки (`buildChartHints`)

Приоритет (выше = важнее), максимум 4 штуки:

1. Активная последовательность / действие live-сигнала  
2. Шаги «что уже произошло»  
3. Стены опоры/крыши  
4. OI, перевес стакана, «лента активна без предела»  
5. Режим как INFO-фон  

Язык: процессный русский, без BID/ASK в тексте для пользователя.

---

## 11. Журнал и исторический win rate

- Типы сетапов: `SEQUENCE_ABSORB`, `SEQUENCE_CVD_DIV`, `SEQUENCE_WALL_RELEASE`, `SEQUENCE_OI_CONFIRM`.
- `applySequenceHistWr` подтягивает похожие записи → на UI «раньше сработало N%».
- Это **клиентский** journal, не KV meme-бота.

---

## 12. Что система сознательно НЕ делает

| Тема | Статус |
|------|--------|
| Полный footprint / cluster chart | Нет |
| Непрерывный Time & Sales как отдельный поток | Частично (агрегация HIT из trades) |
| Авто-майнинг новых последовательностей (ML) | Нет — 5 жёстких детекторов (+ trapped) |
| Официальный force-order feed MEXC | Нет — LIQ **инферится** из tape burst |
| Изменение meme-бота / paper cron | **Запрещено политикой** — отдельный контур |
| Персистентность FrameBus между сессиями | Нет (память вкладки) |
| Серверный детект sequence | Нет — только клиент |

---

## 16. Слой «Топлива» (LIQ + запертые)

- Кадр `LIQ`: односторонняя волна сделок за ~3.5с с доминированием ≥72% и тиком цены — прокси ликвидаций.
- Последовательность `TRAPPED_TRADERS`: стена + рост OI + экстремальная агрессия + цена почти стоит → иссякание = толпа стала топливом.
- После серии LIQ + падение агрессии — буст к trapped / exhaustion.

## 17. Слой «Здоровья» (Spot vs Perps)

- Spot tape через `/mexc-spot` → `api.mexc.com/api/v3/trades`.
- В ProcessStrip: `Спот ведёт` / `Перпы ведут` / `Грязный ход`.
- `confidenceMul`: spot-led 1.1 · aligned ~1 · perp-led 0.78 · diverged 0.68.

## 18. Слой звука

- Web Audio (без Howler): кнопка **Звук** на графике.
- HIT щелчки · LIQ удар · OI гул · RELEASE стекло · MOMENT/TRAP аккорд.

## 19. Z-Score скептицизм

- `hitBaseline.ts`: rolling samples + seed из 1m свечей.
- Аномалия при Z ≳ 2.5 (после прогрева ≥24 сэмплов).
- HIT-driven sequences на шуме получают ×0.55 к confidence.

---

## 13. Карта файлов

### Движок

| Файл | Роль |
|------|------|
| `src/engine/sequence/types.ts` | Кадры, SequenceHit, контекст |
| `src/engine/sequence/frameBus.ts` | Кольцевой буфер кадров |
| `src/engine/sequence/ingestAndDetect.ts` | Сборка кадров + выбор лучшего hit |
| `src/engine/sequence/regimeGate.ts` | Допуск по режиму |
| `src/engine/sequence/wallAbsorptionExhaustion.ts` | Absorb → exhaustion |
| `src/engine/sequence/cvdDivergenceLimit.ts` | CVD-дивергенция |
| `src/engine/sequence/wallRelease.ts` | Снятие стены |
| `src/engine/sequence/oiDeltaConfirm.ts` | OI + дельта |
| `src/engine/sequence/oiTracker.ts` | Сэмплы OI |
| `src/engine/sequence/sequenceJournal.ts` | Journal + hist WR |
| `src/engine/sequence/buildChartHints.ts` | Текст подсказок |
| `src/engine/sequence/index.ts` | Публичный API |
| `src/engine/orderbook/whaleDetector.ts` | Киты / опоры |
| `src/engine/regime/marketRegime.ts` | Режим рынка |
| `src/engine/trades/findLiveSignal.ts` | Вплетение sequence в live-сценарии |

### UI

| Файл | Роль |
|------|------|
| `src/components/tactical/OrderBookPanel.tsx` | Ingest + `setSequenceHit` |
| `src/components/tactical/LiveChart.tsx` | Сборка оверлеев, кнопка подсказок |
| `src/components/tactical/ProcessStrip.tsx` | Полоска процесса |
| `src/components/tactical/WhaleLevelsOverlay.tsx` | ОПОРА / КРЫША |
| `src/components/tactical/SequenceProcessOverlay.tsx` | МОМЕНТ на графике |
| `src/components/tactical/ChartHintsOverlay.tsx` | Карточки подсказок |
| `src/components/tactical/DeltaSparkline.tsx` | Sparkline покупок/продаж |
| `src/components/tactical/WhaleAlertBanner.tsx` | Баннер кита |
| `src/components/tactical/SignalNowPanel.tsx` | Панель «сейчас» |
| `src/store/useAppStore.ts` | `sequenceHits` / `setSequenceHit` |

---

## 14. Как пользоваться глазами (чеклист)

1. Открыть монету → дождаться стакана и китов.  
2. Смотреть **ProcessStrip**: режим → контракты → цветные точки 5м.  
3. На графике: **ОПОРА** снизу / **КРЫША** сверху — это лимитные желания крупных, не сигнал сами по себе.  
4. Когда появляется **МОМЕНТ** у стены — прочитать подпись («стена выдержала…» / «стену сняли…»).  
5. Если рядом «не сейчас» — режим запрещает вход: наблюдать.  
6. Включить **Подсказки ON** — 3–4 фразы: режим, стена, действие.  
7. Не догонять середину хода: лимитка на реакции у стены / после снятия.

---

## 15. Теория ↔ реализация (сводка)

| Тезис Ремизова | Реализация |
|----------------|------------|
| Процесс важнее формулы | Кадры + 4 последовательности вместо «одного индикатора» |
| Режим — рамка чтения | `regimeGate` + dim сценариев в chop/strong trend |
| Предел последовательности | `SequenceHit` + маркер МОМЕНТ |
| Стены = взаимодействие с агрессией | Absorb / Release + heat «удары $» |
| OI как подтверждение денег | `oiTracker` + `OI_DELTA_CONFIRM` |
| Обучение на своих сделках | Локальный journal hist WR |

---

---

## 16. Апгрейд A+B (sigma · tape→PE · TG moments)

| Кусок | Где | Что делает |
|-------|-----|------------|
| **Sigma HIT/DELTA/WALL** | `sigmaBaseline.ts` + `ingestAndDetect` | Z-score anomaly; шум режет confidence |
| **Tape CVD → PE** | `liveTapeCvd` store · OrderBookPanel · scanner | ScoreCard/PE берут WS-ленту, не OHLCV proxy |
| **Fuel в live signal** | `findLiveSignal` · `scoreCard.sequence` | TRAPPED / WALL_RELEASE / SPOT_LED поднимают primary |
| **Audio ∝ intensity** | `processAudio.ts` | Громче glass/liq/moment при сильном кадре |
| **TG process moment** | `workers/.../processMoment.ts` на paper cron | Watched symbols → Elite «⚡ МОМЕНТ» (absorb/CVD/release) |

## 17. Фаза C — Binance lead venue

| Кусок | Где | Что делает |
|-------|-----|------------|
| **Binance WS** | `useBinanceLeadStream` · `fstream` aggTrade+depth5 | Lead delta / move / OBI |
| **VenueLead** | `venueLead.ts` · кадр `VENUE` | `ARB_WALL_RISK` если BN двигается, а локальная стена ещё стоит |
| **Ingest** | `ingestAndDetect` | Режет bounce против lead; бустит WALL_RELEASE по lead |
| **ProcessStrip** | бейдж `BN ↑/↓` / `Arb стена` | Видно без открытия стакана Binance |

OKX/Bybit — опционально позже; Binance = закон ликвидности для мажоров.

---

*Документ отражает код клиента на момент введения Remizov process layer. При смене порогов или детекторов правь этот файл вместе с `src/engine/sequence/`.*
