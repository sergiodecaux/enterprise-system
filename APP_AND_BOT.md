# Enterprise System — описание приложения и Telegram-бота

Документ описывает **текущую** архитектуру продукта (MEXC USDT-M, SMC/ProbabilityEngine, Mini App + Cloudflare Worker).  
Устаревшие упоминания Binance/RSI-таблиц в корневом `README.md` к этой версии не относятся.

---

## 1. Что это за продукт

**Enterprise System** — торговый аналитический Mini App для Telegram + бот-оповещений.

| Часть | Роль |
|--------|------|
| **Mini App** | Радар сетапов, график, стакан, MM-intent, ювелирный вход, журнал |
| **Telegram-бот** | Алерты 24/7 (сканер worker + сигналы из приложения), слежение за выбранными сетапами |
| **Cloudflare Worker** (`mexc-proxy`) | Прокси MEXC, cron-сканер, KV-подписки, watched setups, paper-trades |

Биржа данных: **MEXC Futures** (USDT perpetual). Сделки на бирже приложение **не открывает** — это анализ, лимитные зоны и оповещения; локальный «shadow trade» и worker paper — учебные/теневые треки.

---

## 2. Для кого и какой сценарий

1. Открыть Mini App → вкладка **Radar / Sniper / Meme**.
2. Выбрать монету → **Tactical Drawer** (график, вероятность, SL/TP, стакан, MM, surgical).
3. Нажать **«Сетапы»** → выбрать условный сценарий → **«Следить»**.
4. Закрыть приложение — **бот** напишет, когда вход `READY` или сетап сломан (1H/4H).
5. Параллельно бот шлёт рыночные алерты со своего 2-минутного сканера.

---

## 3. Структура репозитория

```
enterprise-system/
├── src/
│   ├── api/                 # MEXC client, Telegram client, news
│   ├── components/
│   │   ├── radar/           # Радар монет
│   │   ├── sniper/          # Снайперские карточки
│   │   ├── meme/            # Meme Pulse
│   │   ├── trades/          # Сделки + Lab (журнал)
│   │   ├── tactical/        # Drawer, график, стакан, сетапы
│   │   ├── telegram/        # Панель алертов / подписка
│   │   ├── news/            # Новости, Fear&Greed
│   │   ├── layout/          # Header, навигация
│   │   └── composite/       # Сводный анализ
│   ├── engine/
│   │   ├── ProbabilityEngine.ts   # Оркестратор сигнала
│   │   ├── smc/                   # Структура, OB, FVG, OTE, raid, CHoCH…
│   │   ├── mm/                    # MM Intent, OBI, spoof, iceberg, BE…
│   │   ├── surgical/              # Ювелирный вход (sweep→confirm→limit)
│   │   ├── setups/                # Каталог условных сетапов + watch eval
│   │   ├── trend/                 # Сила тренда 1H/4H
│   │   ├── orderbook/             # Стены, whale, heatmap
│   │   ├── prediction/            # Сценарии A/B/C, ghost path
│   │   ├── zones/                 # Global Fib, liquidity
│   │   ├── journal/               # Журнал сигналов / Lab
│   │   ├── meme/                  # Мем-фильтры и билдеры
│   │   ├── sessions/              # Сессии, Session Flip, DNA
│   │   ├── strategies/            # SCALP / INTRADAY / SWING
│   │   ├── confidence/            # Score + invalidation LTF/HTF
│   │   └── …
│   ├── hooks/               # Сканеры, copilot, forecast, Telegram
│   ├── store/               # Zustand + localStorage
│   └── i18n/                # RU/EN
├── workers/mexc-proxy/
│   ├── src/
│   │   ├── index.ts         # HTTP + cron + Telegram routes
│   │   ├── scanner.ts       # 24/7 market scan → alerts
│   │   ├── watchedSetups.ts # Офлайн-слежение сетапов
│   │   └── paperTrades.ts   # Учебные paper после алерта
│   ├── wrangler.toml
│   └── README.md
├── scripts/                 # Legacy генераторы (не ядро Mini App)
└── APP_AND_BOT.md           # этот файл
```

---

## 4. Mini App — экраны и функции

### 4.1 Radar
- Скан watchlist (core + добавленные символы).
- Строки с вероятностью, направлением, soft/active setup.
- Тап → открытие тактического drawer.

**Файлы:** `src/components/radar/`, `src/hooks/useMexcScanner.ts`

### 4.2 Sniper
- Только качественные сетапы (`sniperMode`: score, фильтры силы, surgical `READY` если план есть).
- Карточка: стиль (SCALP/INTRADAY/SWING), MM badge, session flip, surgical status, вход/SL/TP.
- Открытие сделки пишет в локальные `activeTrades` + журнал.

**Файлы:** `src/components/sniper/`, `src/engine/sniperMode.ts`

### 4.3 Meme Pulse
- Вселенная мем-перпов MEXC (ротация батчами).
- Heat score, squeeze, flatline, CVD trap, backside, absorption и т.д.
- Отдельные фильтры BE / BTC dump / liquidity raid для мемов.

**Файлы:** `src/components/meme/`, `src/engine/meme/`, `src/hooks/useMemePulseScanner.ts`

### 4.4 Trades + Lab
- Локальные активные/закрытые сделки, события (BE, invalidation, walls).
- **Lab** — два контура статистики:
  - **App** — локальный журнал Mini App (`enterprise_signal_journal`).
  - **Бот** — журнал cron-алертов worker’а (KV), WIN/LOSS/TIMEOUT по TP/SL, адаптивные gates сканера.
- Вкладка **Бот**: WR, Avg R, blocked/boosted setups, инсайты, лог последних сигналов. Синк: `GET /telegram/journal` каждые ~2 мин.

**Файлы:** `src/components/trades/JournalStatsPanel.tsx`, `src/engine/journal/`, `src/api/telegram/botJournal.ts`, `useBotJournalSync.ts`, `useSignalJournalResolver.ts`  
**Worker:** `workers/mexc-proxy/src/botJournal.ts`

### 4.5 Tactical Drawer
Единая карточка монеты:
- Probability gauge, daily bias, **HTF trend strength**
- MM Intent (drive, micro→macro hunt)
- Surgical Entry (WAITING_SWEEP / CONFIRM / READY)
- Session Flip reason
- Liquidity magnets, BTC divergence, Session DNA, PO3, tape, absorption
- **LiveChart** (прогноз A/B/C, Fib, SL/TP, кнопка «Сетапы»)
- Order Book (OBI, walls, MM label live)
- News / Fear&Greed

**Файлы:** `src/components/tactical/`

### 4.6 Подбор сетапов и слежение
Кнопка **«Сетапы»** на графике вызывает `buildConditionalSetups`:

| Kind | Смысл |
|------|--------|
| `FORECAST_A/B/C` | Вероятностные пути прогноза |
| `MM_HUNT` | Микро-свип → макро-магнит |
| `SURGICAL` | План ювелирного входа |
| `BOUNCE_SSL/BSL` | «Если дойдёт и оттолкнётся…» |
| `STOP_THEN_REVERSE` | Стоп-хант → разворот |

**Следить** → `POST /telegram/watch` + зеркало в `watchedSetups` (localStorage).  
Бот пишет один раз при `READY` и при `INVALIDATED`.

**Файлы:** `src/engine/setups/`, `SetupPickerPanel.tsx`, `src/api/telegram/alerts.ts`

---

## 5. Ядро анализа (движки)

### 5.1 ProbabilityEngine
Оркестратор на символ:
1. Структура / OB / FVG / Fib confluence  
2. Session Flip + MM Intent (порядок LONG/SHORT)  
3. Hard path `trySide` или soft radar  
4. Surgical gate (при micro-hunt — active только в `READY`)  
5. Enrich: VPVR, CVD, liq, style, **HTF trend**, invalidation 1H/4H  
6. **ScoreCard gate** (8 факторов / 12 баллов): active только при grade **A+ / A**  
7. **Data Quality gates** — штрафы CVD/OB/spoof freshness; POOR → SKIP  

**Файлы:** `src/engine/ProbabilityEngine.ts`, `src/engine/confluence/scoreCard.ts`, `src/engine/confidence/dataQuality.ts`, `src/engine/regime/`, `sessions/sessionQuality.ts`  
**Backtest:** `src/engine/backtest/` · `npm run backtest`

### 5.2 SMC
Market structure, BOS, order blocks, FVG, OTE, candle rejection, daily bias, equal H/L, MSS, liquidity raid, absorption, 1m CHoCH, PO3.

**Файл:** `src/engine/smc/index.ts`

### 5.3 Market Maker X-Ray (`engine/mm`)
- Weighted OBI, spoof/fleeing walls, iceberg, price prodding  
- Effort vs result / absorption trap  
- Triple filter, BTC dump  
- **MM Intent:** куда гонит цену + hunt micro→macro  
- Spoof/Iceberg **подключены** через OrderBookPanel → store → PE / ScoreCard  

### 5.4 Surgical Entry
Состояния: `WAITING_SWEEP` → `WAITING_CONFIRM` → `READY` | `INVALIDATED` | `MISSED`  
Лимит: OTE / reclaim / зона confluence.  
Sniper требует `READY`, если surgical-план не `IDLE`.

### 5.5 HTF Trend + Invalidation
- Сила 1H/4H: bias, strength 0–100, WEAK/MEDIUM/STRONG  
- Слом по **закрытию** свечи 1H/4H за swing (не только wick)  
- Copilot алертит закрытие позиции при HTF breach  

**Файлы:** `src/engine/trend/`, `src/engine/confidence/invalidation.ts`

### 5.6 Fibonacci
- Local OTE 0.618–0.786  
- Global Fib: последний подтверждённый swing high/low → 0→100→141/161 (куда тянет цену)  

**Файлы:** `src/engine/zones/globalFibonacci.ts`

### 5.7 Order Book
Depth metrics, walls tracker, whale watcher, heatmaps, score boost в PE.

---

## 6. Telegram-бот и Worker

### 6.1 Назначение бота
- Подписка chat_id на категории Sniper / Meme  
- Рассылка рыночных алертов со **worker-сканера** (даже если Mini App закрыт)  
- Приём сигналов из Mini App (`/telegram/alert`)  
- **Setup Watch:** персональный алерт «вход возможен» / «сетап снят»  
- Paper-trades: учебный комментарий после некоторых алертов (`/trades`)

### 6.2 HTTP-маршруты Worker

| Метод | Путь | Назначение |
|--------|------|------------|
| `*` | `/mexc/*` | Прокси публичного MEXC contract API |
| GET | `/news/rss`, `/news/panic`, `/news/fg` | Новости / Fear&Greed |
| GET | `/telegram/health` | Здоровье + число подписчиков |
| POST | `/telegram/subscribe` | Подписка chat_id |
| POST | `/telegram/unsubscribe` | Отписка |
| POST | `/telegram/alert` | Broadcast / direct (нужен `X-Alert-Secret`) |
| POST | `/telegram/watch` | Создать watch сетапа |
| POST | `/telegram/watch/delete` | Снять watch |
| GET | `/telegram/watches?chatId=` | Список watch |
| GET | `/telegram/journal` | Статистика бота + adaptive gates |
| POST/GET | `/telegram/scan` | Ручной прогон сканера |
| POST | `/telegram/webhook` | Команды бота |

**Worker URL (prod):** `https://mexc-proxy.sergiodecaux.workers.dev`  
**Cron:** каждые 2 минуты (`wrangler.toml`)

### 6.3 Команды бота

| Команда | Действие |
|---------|----------|
| `/start` | Подписка + приветствие |
| `/stop` | Отписка |
| `/status` | Статус подписки |
| `/ping` | Проверка связи |
| `/test` | Тестовое сообщение |
| `/scan` | Ручной скан рынка |
| `/trades` | Paper-сделки |
| `/sniper_on` / `_off` | Фильтр sniper-алертов |
| `/meme_on` / `_off` | Фильтр meme-алертов |

### 6.4 Типы алертов

- `SNIPER` — снайперские / worker sniper-подобные  
- `MEME` — мем-импульсы  
- `SYSTEM` — служебные, paper commentary, тесты  
- `SETUP_WATCH` — готовность/слом **выбранного** сетапа  

Dedupe: KV ключ `telegram:dedup:*` (TTL ~1 час).

### 6.5 Cron-цикл (каждые 2 мин)

```
runCronScan
  ├─ maybeHeartbeat
  ├─ runMarketScan (scanner.ts) → SNIPER/MEME alerts
  │     └─ optional createPaperTradeFromPlan
  ├─ monitorPaperTrades → SYSTEM комментарии
  └─ monitorWatchedSetups → SETUP_WATCH (READY / INVALIDATED)
```

### 6.6 Watched Setups (офлайн)

Хранение: KV `telegram:watched_setups` (+ memory fallback).  
Поля: `watchId`, `chatId`, `symbol`, snapshot сетапа, TTL ~48ч, флаги `readyNotified` / `invalidatedNotified`.

Оценка: цена + 1m/1H/4H свечи → зона входа, sweep/reclaim, HTF close break.  
Сообщение уходит **только владельцу** `chatId`, один раз на статус.

---

## 7. Поток данных

```
MEXC Contract API
       │
       ├──────────────► Worker /mexc proxy ──► Mini App (свечи, depth, ticker)
       │
       └──────────────► Worker cron scanner ──► Telegram alerts + paper

Mini App scanners (useMexcScanner / meme)
       │
       ▼
 ProbabilityEngine + MM + Surgical + HTF
       │
       ▼
 Zustand store (signals, maps, mmIntent, surgical, watches)
       │
       ├─► Radar / Sniper / Meme / Drawer / Chart
       ├─► useTelegramAlerts ──► POST /telegram/alert
       └─► «Следить» ─────────► POST /telegram/watch ──► cron ──► бот
```

Типичные интервалы Mini App:
- ticker ~5 с  
- полный SMC-скан ~75 с  
- стакан в drawer ~2 с (REST)

---

## 8. Конфигурация и секреты

### Frontend (`.env` / GitHub Pages secrets)

| Переменная | Назначение |
|------------|------------|
| `VITE_MEXC_PROXY_URL` | Base URL worker |
| `VITE_ALERT_SECRET` | Секрет для `/telegram/alert` и `/telegram/watch` |
| `VITE_TELEGRAM_BOT_USERNAME` | Username бота без `@` |

### Worker (`wrangler secret`)

| Секрет / binding | Назначение |
|------------------|------------|
| `TELEGRAM_BOT_TOKEN` | BotFather token |
| `ALERT_SECRET` | = `VITE_ALERT_SECRET` |
| KV `SUBSCRIBERS` | Подписчики, dedupe, watches, paper |

Деплой worker:

```bash
cd workers/mexc-proxy
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ALERT_SECRET
npx wrangler deploy
# webhook:
# curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<WORKER>/telegram/webhook"
```

Деплой Mini App: push в `main` → GitHub Actions → GitHub Pages (`deploy-pages.yml`).

Подробности worker: `workers/mexc-proxy/README.md`.

---

## 9. Локальное хранилище браузера

| Ключ | Данные |
|------|--------|
| `enterprise_extra_watchlist` | Добавленные монеты |
| `enterprise_active_trades` | Shadow-сделки |
| `enterprise_telegram_alerts` | Настройки алертов |
| `enterprise_watched_setups` | Зеркало watch |
| `enterprise_signal_journal` | Журнал сигналов |
| chart / session / news prefs | Настройки UI |

Worker KV хранит журнал **бот-алертов** (`telegram:bot_journal`, gates) + подписки, watches, paper.  
Локальный журнал Mini App (`enterprise_signal_journal`) остаётся отдельно в браузере.

---

## 10. Пользовательские сценарии (кратко)

### Открыть монету
Radar/Sniper/Meme → тап → Drawer → график + контекст.

### Подобрать сетап
График → **Сетапы** → карточки с preconditions / limit / TP / inv → **Выбрать** (подсветка) или **Следить**.

### Получить алерт на вход
Подписка (колокольчик или `/start`) → watch → cron → сообщение с лимитом, зоной, SL, TP.

### Управление в сделке
Локальная сделка + Trade Copilot: BE, invalidation 1m/5m и **HTF 1H/4H close**, OBI против позиции.

---

## 11. Ограничения текущей версии

- Нет автоторговли на MEXC (только зоны и алерты).  
- Стакан — **WebSocket** (`wss://contract.mexc.com/edge`, depth.full + deal) с REST-fallback.
- Worker-сканер **упрощённее** полного ProbabilityEngine Mini App.  
- `VITE_ALERT_SECRET` попадает в бандл браузера — это shared secret для MVP, не user-auth.  
- Paper trades worker — демонстрационные, не баланс пользователя.

---

## 12. Связанные документы

| Файл | Содержание |
|------|------------|
| `workers/mexc-proxy/README.md` | Деплой бота и proxy |
| `.env.example` | Шаблон env фронта |
| `scripts/README_ENV.md` | Legacy Python-скрипты |
| Этот файл `APP_AND_BOT.md` | Продуктовое описание + структура |

---

*Обновлено: SMC ProbabilityEngine, ScoreCard + Data Quality, Market Brief (MTF), стиль-сценарии SCALP/INTRA/SWING, bot majors SNIPER, journal win% + regime, WS стакан, кнопка «Зоны» + ювелирный вход в бот.*
