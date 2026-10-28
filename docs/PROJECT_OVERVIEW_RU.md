# Enterprise System — описание проекта, структура и карта файлов

> Документ описывает **весь репозиторий**: что это за приложение, как оно устроено,
> из каких папок состоит и за что отвечает каждый файл.
>
> Дата актуальности: 28.10.2026. Коммит на момент составления: `c9d289d`.

---

## 1. Что это за проект

**Enterprise System** — крипто-терминал для анализа фьючерсов MEXC (USDT-M perpetual),
который работает в четырёх средах:

| Среда | Как запускается |
|---|---|
| Браузер / Vercel | обычный SPA-билд Vite |
| Telegram Mini App | тот же SPA внутри Telegram WebApp |
| Windows | Electron-оболочка (`electron/main.cjs`) |
| Android | Capacitor-проект в `android/` |

Приложение не торгует само (нет вывода средств и API-ключей биржи), а **собирает
рыночные данные, считает вероятностные сценарии и показывает готовые идеи**:
снайперские лимитки, зоны, отскоки, «сундучки», сделки бота, радар аномалий,
новостной фон и разбор от AI-советника.

### 1.1. Пользовательские разделы

| Раздел | Что показывает |
|---|---|
| **Снайпер** | живые лимитные заявки, готовые входы, потенциал 1–5 %, статус «в зоне / ждём» |
| **Сделки** | журнал сигналов, сделки бота, статистика, confidence, P&L |
| **Радар** | охота за монетами, 141-паттерн, сильные/слабые монеты, избранное |
| **Сигналы** | быстрый разбор выбранной монеты и направленные сигналы |
| **Терминал** (ПК) | график + правая панель с ордербуком, новостями, советником и аналитикой |
| **Tactical Drawer** (телефон) | тот же график и анализ в мобильной оболочке |

### 1.2. Ключевые возможности

- Свечной график TradingView-стиля (Lightweight Charts) с зонами, сценариями,
  комментариями, маркерами лимиток и стрелками пути.
- SMC/ICT-анализ: order blocks, FVG, OTE, BOS/CHoCH, PO3, session DNA.
- Order-flow: стакан, стены, iceberg, spoofing, CVD, tape momentum, buyer aggression.
- Мем-пульс: volume spike, liquidity gap, mean reversion, squeeze, toxic chop.
- Прогноз: multi-TF alignment, сценарии, вероятности, ghost path, target ladder.
- AI-советник: компактный снимок рынка уходит на Cloudflare Worker с цепочкой моделей.
- Telegram: алерты, избранное, журнал бота, Mini App.
- «Сундучки» — автоматические отложенные лимитки на отскок от важных зон
  с фильтром движения цели 1–5 % и оценкой прибыль/риск.

> Все вероятности — **оценка модели**, а не гарантия исхода. Приложение показывает
> сценарии и риски, а не обещает прибыль.

---

## 2. Архитектура

### 2.1. Слои

```
┌──────────────────────────────────────────────────────────────┐
│ components/  — React-интерфейс, графики, панели, оверлеи     │
│      ▲                                                       │
│ store/       — Zustand: глобальное состояние и настройки     │
│      ▲                                                       │
│ hooks/       — связка React ↔ API ↔ engine, polling/streams  │
│      ▲                                                       │
│ engine/      — чистая логика: SMC, order-flow, прогноз, риск │
│      ▲                                                       │
│ api/         — MEXC, Binance, news, Telegram, AI advisor     │
└──────────────────────────────────────────────────────────────┘
```

Правило зависимостей: `components → store/hooks → engine → api`.
`engine` не импортирует React и не делает сетевых запросов (кроме CLI-скриптов).

### 2.2. Потоки данных

1. **Рынок.** `useMexcScanner` опрашивает MEXC через Cloudflare Worker
   (`VITE_MEXC_PROXY_URL`), обновляет тикеры в `useAppStore`.
2. **Выбранная монета.** `CoinSearch` → `selectSymbol` → `TacticalDrawer`/`LiveChart`
   → загрузка OHLCV по таймфрейму → `engine/*` → оверлеи и панели.
3. **Стакан и сделки.** `useMexcDepthStream`, `useOrderBookHistory`,
   `useBuyerAggression` поставляют live-метрики в график и анализ.
4. **Новости.** `useNewsIntelligence` → CryptoPanic / RSS / Fear&Greed →
   sentiment → буст вероятности.
5. **AI-советник.** `useAdvisorChat` собирает `AdvisorChartInput` и отправляет
   на ring из `ai-advisor` воркеров; ответ стримится в чат.
6. **Telegram.** `useTelegramAlerts` и `useSniperSignalFire` шлют POST на
   `mexc-proxy`; воркер рассылает сообщения подписчикам.
7. **Деплой.** Push в `main` → GitHub Actions → `npm ci && npm run build` →
   штамп `dist/version.json` → GitHub Pages.

### 2.3. Технологии

| Слой | Технологии |
|---|---|
| UI | React 18, TypeScript, TailwindCSS, Lucide React |
| Состояние | Zustand |
| График | lightweight-charts, @react-three/fiber + three (3D-heatmap) |
| Сборка | Vite 5, PostCSS, ESLint |
| i18n | i18next, react-i18next (ru/en) |
| Backend | Cloudflare Workers (TypeScript), KV, Cron Triggers |
| AI | Workers AI + OpenAI-совместимые провайдеры |
| Мобильное | Telegram WebApp SDK, Capacitor 6 |
| Desktop | Electron 33, electron-builder |
| Деплой | GitHub Pages, Vercel (конфиг), Cloudflare |

### 2.4. Переменные окружения

| Переменная | Назначение |
|---|---|
| `VITE_MEXC_PROXY_URL` | URL Cloudflare Worker (MEXC + news + Telegram) |
| `VITE_ALERT_SECRET` | общий секрет для `POST /telegram/alert` |
| `VITE_TELEGRAM_BOT_USERNAME` | имя бота без `@` для ссылки «Открыть бота» |
| `VITE_ADVISOR_URLS` | необязательный список URL AI-советника |
| `VITE_ADVISOR_TOKEN` | необязательный токен советника |

Секреты воркеров (`TELEGRAM_BOT_TOKEN`, `ALERT_SECRET`, `FAILOVER_SECRET`,
`ADVISOR_TOKEN`) задаются через `wrangler secret put` и в репозиторий не попадают.

---

## 3. Структура репозитория (верхний уровень)

```
enterprise-system/
├── .github/workflows/       CI: сборка и деплой на GitHub Pages
├── android/                 Capacitor-проект Android
├── data/                    локальные данные (OI-история и пр.)
├── dist/                    результат сборки (в git не входит)
├── docs/                    тематические документы
├── electron/                Electron-оболочка для Windows
├── public/                  статика: data/, dev-страницы
├── release/                 собранный portable .exe (в git не входит)
├── scripts/                 CLI-скрипты и генераторы
├── services/                зарезервировано под сервисы (сейчас пусто)
├── src/                     весь код приложения
├── workers/                 Cloudflare Workers
├── tmp-visual/              локальные визуальные прогоны (в git не входит)
├── index.html               HTML-вход Vite
├── package.json             скрипты и зависимости
├── vite.config.ts           конфиг сборки и dev-proxy
├── tailwind.config.ts       тема и палитра
├── capacitor.config.ts      настройки Android-оболочки
├── electron/main.cjs        главный процесс Electron
├── vercel.json              конфиг Vercel
└── README.md                краткая инструкция запуска
```

---

## 4. Карта файлов

Ниже — каждый значимый файл репозитория и его ответственность.
Сгенерированные артефакты (`node_modules`, `dist`, `release`, `android/.gradle`,
`*.tsbuildinfo`, `workers/**/.wrangler`, `workers/mexc-proxy/reports`) не перечисляются.

### 4.1. Корень репозитория

| Файл | За что отвечает |
|---|---|
| `README.md` | краткое описание, установка, запуск, Telegram-бот |
| `package.json` | имя проекта, npm-скрипты (`dev`, `build`, `desktop`, `android:*`, `backtest`), зависимости и настройки electron-builder |
| `package-lock.json` | зафиксированные версии npm-пакетов |
| `index.html` | HTML-каркас Vite: viewport, Telegram WebApp script, `#root`, fallback-загрузчик |
| `vite.config.ts` | React-плагин, dev-proxy на MEXC/Binance/новости, RSS-прокси, штамп `version.json` для сброса кэша Telegram |
| `vite.config.js` | скомпилированная JS-копия конфига (артефакт `tsc`); править нужно `.ts` |
| `vite.config.d.ts` | типы скомпилированного конфига |
| `tsconfig.json` | TypeScript project references для приложения |
| `tsconfig.node.json` | TypeScript для Vite/Node-инструментов |
| `tsconfig.tsbuildinfo` | кэш инкрементальной сборки приложения (служебный) |
| `tsconfig.node.tsbuildinfo` | кэш сборки node-конфига (служебный) |
| `tailwind.config.ts` | палитра `matrix/holo/space/hull`, шрифты, анимации, content-пути |
| `postcss.config.js` | PostCSS: Tailwind + Autoprefixer |
| `capacitor.config.ts` | `appId`, `webDir=dist`, HTTPS-схема, splash |
| `vercel.json` | rewrites/headers для деплоя на Vercel |
| `.env.example` | шаблон переменных окружения |
| `.env` | локальные значения (в git не входит) |
| `.gitignore` | исключения git |
| `PROJECT_STRUCTURE.md` | старая структурная справка (историческая) |
| `APP_AND_BOT.md` | описание приложения и Telegram-бота |
| `MINI_APP.md` | заметки по Telegram Mini App |
| `AUDIT_MARKET_ANALYSIS.md` | аудит рыночного анализа |
| `CHART_INDICATORS_RESEARCH.md` | исследование индикаторов и зон |
| `LIVECHART_VISUAL_AUDIT.md` | визуальный аудит графика |
| `PREDICTION_MTF_RESEARCH.md` | исследование прогноза и multi-TF |
| `SESSIONS_OVERLAY_RESEARCH.md` | исследование сессионного оверлея |
| `NEWS_INTELLIGENCE_RESEARCH.md` | исследование новостного модуля |
| `ORDERBOOK_CODEBASE_BRIEF.md` | бриф по ордербуку |
| `WHALE_WATCHER_CONTEXT.md` | контекст whale-watcher |
| `LIQUIDITY_MAP_CONTEXT.md` | контекст карты ликвидности |
| `LIQUIDITY_MAP_POST_IMPL_CONTEXT.md` | пост-реализационные заметки по карте ликвидности |
| `TECHNICAL_FILTERS_SOURCE_DUMP.md` | дамп исходников технических фильтров |
| `TRADING_SESSION_DNA_SOURCE_DUMP.md` | дамп исходников Session DNA |
| `FIXED_GENERATE_CORE.md` | заметка об исправлении `generate_core.py` |
| `КОНЦЕПТ_ПРИЛОЖЕНИЯ.md` | концепция продукта |
| `ОПИСАНИЕ_ПРОГРАММЫ.md` | пользовательское описание программы |
| `ADVISOR_DIGEST.md` | черновик-дайджест AI-советника (не коммитится) |
| `PROJECT_DIGEST.md` | черновик общего дайджеста (не коммитится) |
| `REVIEW_BUNDLE.md` | черновик обзорного бандла (не коммитится) |
| `SOURCE_INVENTORY_RU.md` | старый автоген-инвентарь (не коммитится) |
| `_inventory_md_draft.md` | черновик инвентаря (не коммитится) |

### 4.2. `src/` — корень приложения

| Файл | За что отвечает |
|---|---|
| `src/main.tsx` | точка входа React: `StrictMode`, `Suspense`, глобальные стили, i18n |
| `src/App.tsx` | корневая компоновка: Header, мобильные вкладки, ПК-терминал (nav rail + панель + график), подписка на сканеры и Telegram-хуки |
| `src/vite-env.d.ts` | типы `import.meta.env` |
| `src/styles/globals.css` | Tailwind-слои, CSS-переменные, стили `.tv-btn`, скроллбары, анимации |
| `src/assets/fonts/.gitkeep` | заглушка папки шрифтов |

### 4.3. `src/api/` — сетевой слой

| Файл | За что отвечает |
|---|---|
| `api/proxyBase.ts` | базовый URL Cloudflare Worker; выбор env/прод-fallback |
| `api/mexc/index.ts` | REST MEXC futures: OHLCV, глубина, сделки, тикеры; типы свечей и таймфреймов |
| `api/mexc/perpetualGuard.ts` | проверка, что инструмент — живой USDT-M перп (золото/серебро/нефть) |
| `api/binance/crowd.ts` | long/short ratio и funding с Binance, fallback на MEXC |
| `api/binance/symbols.ts` | маппинг символов Enterprise/MEXC → Binance USDT-M |
| `api/marketContext.ts` | контекст рынка из воркера: Fear&Greed, новости, BTC.D, TOTAL3 |
| `api/news/index.ts` | объединение CryptoPanic + RSS, дедупликация, топ-новости |
| `api/news/cryptoPanic.ts` | клиент CryptoPanic через worker proxy + sentiment |
| `api/news/fearGreed.ts` | индекс страха и жадности + буст скоринга |
| `api/news/rssParser.ts` | парсинг RSS CoinDesk/Cointelegraph через proxy |
| `api/telegram/alerts.ts` | клиент алертов Telegram через Worker (`/telegram/alert`) |
| `api/telegram/botJournal.ts` | типы и загрузка журнала бота для Lab-синхронизации |
| `api/telegram/formatters.ts` | HTML-форматирование сообщений sniper/meme/setup для Telegram |
| `api/advisor.ts` | клиент AI-советника: ring воркеров, failover, 429-пауза, streaming |

### 4.4. `src/components/` — интерфейс

#### 4.4.1. Корень и layout

| Файл | За что отвечает |
|---|---|
| `components/ErrorBoundary.tsx` | перехват ошибок React, лог и fallback-экран |
| `components/layout/Header.tsx` | верхняя шапка: логотип, поиск монеты, статус, новости, язык |
| `components/layout/DesktopNavRail.tsx` | левая навигационная рейка ПК-терминала (4 раздела) |
| `components/layout/DesktopStatusBar.tsx` | нижняя строка ПК: статус, обновление, подсказки |
| `components/layout/StatusIndicator.tsx` | индикатор соединения/сканирования |
| `components/layout/MarketRibbon.tsx` | бегущая строка с рыночными метриками |
| `components/layout/LanguageToggle.tsx` | переключение ru/en |
| `components/layout/workspaces.ts` | метаданные разделов: id, подпись, иконка, горячая клавиша |

#### 4.4.2. Advisor

| Файл | За что отвечает |
|---|---|
| `components/advisor/AdvisorPanel.tsx` | чат AI-советника, ввод, стриминг ответа |
| `components/advisor/AdvisorMessage.tsx` | пузырь сообщения, markdown, модель/нода, ошибки |
| `components/advisor/AdvisorSettings.tsx` | выбор режима, модели, провайдера, очистка истории |

#### 4.4.3. Остальные доменные панели

| Файл | За что отвечает |
|---|---|
| `components/composite/CompositeAnalysisPanel.tsx` | композитный разбор: контекст, SMC, поток, мемы, итог |
| `components/market/ContextPanel.tsx` | рыночный контекст инструмента (BTC.D, funding, crowd) |
| `components/market/AltMacroStrip.tsx` | полоса альт-макро (TOTAL3, BTC.D, настроение) |
| `components/meme/MemePulseView.tsx` | экран мем-пульса |
| `components/meme/MemePulsePanel.tsx` | список мем-сигналов и фильтры |
| `components/meme/MemeCard.tsx` | карточка мем-сигнала: фаза, топливо, риск |
| `components/meme/SpreadPressureBar.tsx` | давление спреда |
| `components/meme/VolatilityGauge.tsx` | индикатор волатильности мема |
| `components/monetization/ProGate.tsx` | заглушка платного доступа (Telegram Stars TODO) |
| `components/news/NewsStrip.tsx` | компактная лента новостей под шапкой |
| `components/news/NewsPanel.tsx` | полная панель новостей и фильтров |
| `components/news/NewsCard.tsx` | карточка новости с тональностью |
| `components/news/FearGreedGauge.tsx` | gauge Fear & Greed |
| `components/radar/RadarView.tsx` | экран радара: watchlist, 141, охота |
| `components/radar/CoinSearch.tsx` | глобальный поиск и выбор монеты |
| `components/radar/CoinRow.tsx` | строка монеты в списке |
| `components/radar/Radar141Board.tsx` | доска 141-паттерна |
| `components/radar/Radar141Heatmap.tsx` | heatmap 141-паттерна |
| `components/radar/DualHuntBoard.tsx` | двойная охота (long/short полки) |
| `components/radar/SentimentBadge.tsx` | бейдж настроения |
| `components/radar/WinRateBar.tsx` | полоса win-rate |
| `components/signals/SignalsView.tsx` | экран «Сигналы»: направленные сигналы и разбор |
| `components/sniper/SniperView.tsx` | экран снайпера: живые лимитки, фильтры, карточки |
| `components/sniper/SniperCard.tsx` | карточка снайпер-сигнала |
| `components/sniper/LiveLimitCard.tsx` | карточка живой лимитки (вход/цель/статус) |
| `components/sniper/SniperFilters.tsx` | фильтры стиля и стороны |
| `components/telegram/TelegramAlertsPanel.tsx` | настройка Telegram-алертов и подписки |
| `components/trades/TradesView.tsx` | экран сделок: журнал, бот, статистика |
| `components/trades/TradeCard.tsx` | карточка сделки |
| `components/trades/BotTradesPanel.tsx` | сделки бота |
| `components/trades/BotTradeCard.tsx` | карточка сделки бота |
| `components/trades/JournalStatsPanel.tsx` | статистика журнала |
| `components/trades/ConfidenceScore.tsx` | визуализация confidence 0–100 |
| `components/ui/CollapsibleSection.tsx` | сворачиваемая секция интерфейса |

#### 4.4.4. `components/tactical/` — график и терминал

| Файл | За что отвечает |
|---|---|
| `LiveChart.tsx` | **главный график**: свечи, таймфреймы, зоны, сценарии, лимитки, «сундучки», комментарии, тулбар, мобильные режимы |
| `TacticalDrawer.tsx` | оболочка терминала: ПК-раскладка и мобильный drawer, шапка инструмента, вкладки |
| `ChartOverlay.tsx` | базовый слой зон/уровней/аннотаций на графике |
| `ChartCommentsOverlay.tsx` | русские карточки-комментарии, пересчёт при pan/zoom/resize |
| `CaseMarkersOverlay.tsx` | 🧰 маркеры отложенных лимиток на уровне входа |
| `LimitCasesStrip.tsx` | мобильная лента кейсов-лимиток под графиком |
| `BounceArrowsOverlay.tsx` | стрелки отскока от зон |
| `CurvePathOverlay.tsx` | кривые пути сценария |
| `StoryPathOverlay.tsx` | путь выбранного сценария |
| `GhostPathOverlay.tsx` | «призрачный» прогнозный путь |
| `ZonePathOverlay.tsx` | путь от зоны к цели |
| `DirectionArrowOverlay.tsx` | стрелка общего направления |
| `Fib141ZoneOverlay.tsx` | зоны Fib 1.41 |
| `IctMarksOverlay.tsx` | метки ICT (BOS/CHoCH/FVG) |
| `LiqHeatmapOverlay.tsx` | heatmap ликвидности поверх графика |
| `WhaleLevelsOverlay.tsx` | уровни китов |
| `StructureOverlay.tsx` | структура рынка на графике |
| `SessionOverlay.tsx` | сессионные сегменты |
| `SequenceProcessOverlay.tsx` | процессные метки Remizov-последовательности |
| `PredictionOverlay.tsx` | прогнозные сценарии |
| `ChartHintsOverlay.tsx` | подсказки процесса на графике |
| `chartLabels/LabelLayoutManager.tsx` | раскладка меток без наложений |
| `useViewportRedraw.ts` | хук перерисовки оверлеев при изменении viewport |
| `ChartSettings.tsx` | настройки отображения графика |
| `DepthSettings.tsx` | настройки глубины стакана |
| `ScenarioBoard.tsx` | доска сценариев + `ZoneLegend` |
| `ScenarioLegend.tsx` | легенда сценариев |
| `SetupPickerPanel.tsx` | выбор условного сетапа |
| `SignalNowPanel.tsx` | «сигнал сейчас»: вход, стоп, цели |
| `StructureHud.tsx` | HUD структуры рынка |
| `NowStoryHud.tsx` | компактный HUD текущей истории |
| `MarketBriefPanel.tsx` | текстовая сводка по рынку |
| `MacroOutlookPanel.tsx` | макро-прогноз |
| `MultiTFPanel.tsx` | мульти-таймфрейм таблица |
| `LTFAlignmentPanel.tsx` | согласованность младших ТФ |
| `MLPredictionPanel.tsx` | ML-прогноз направления |
| `PredictionGauge.tsx` | gauge прогноза |
| `ProbabilityGauge.tsx` | gauge вероятности |
| `PO3Panel.tsx` | Power of 3 (аккумуляция/манипуляция/распределение) |
| `SessionDNAPanel.tsx` | ДНК торговой сессии |
| `ProcessStrip.tsx` | полоса процесса Remizov |
| `AbsorptionPanel.tsx` | абсорбция в стакане |
| `BuyerAggressionIndicator.tsx` | агрессия покупателей |
| `TapeMomentumIndicator.tsx` | импульс ленты |
| `DeltaSparkline.tsx` | sparkline дельты |
| `ImbalanceChart.tsx` | график дисбаланса |
| `OrderBookPanel.tsx` | стакан |
| `OrderBookLevel.tsx` | строка уровня стакана |
| `OrderBookMetrics.tsx` | метрики стакана |
| `HeatmapOverlay.tsx` | 2D-heatmap стакана на графике |
| `Heatmap3D.tsx` | 3D-heatmap стакана |
| `LiquidationMapPanel.tsx` | карта ликвидаций |
| `ProbableTradesPanel.tsx` | вероятные сделки |
| `VolumePanel.tsx` | объёмная панель |
| `OscillatorPanel.tsx` | осцилляторы (RSI/MACD/Stoch) |
| `ZoneAdvisorCard.tsx` | карточка «если → то» по зоне; на телефоне — bottom-sheet |
| `ZoneVariantsPanel.tsx` | варианты сделки по зоне |
| `WallAlert.tsx` | алерт стены |
| `WhaleAlertBanner.tsx` | баннер китовой активности |
| `WhaleSitStrip.tsx` | полоса «киты сидят» |
| `DataLog.tsx` | лог данных/событий |
| `DescriptiveNote.tsx` | пояснительная заметка |
| `DesktopTerminalEmpty.tsx` | заглушка пустого ПК-терминала |
| `CoinAnalysisUpgradePanel.tsx` | расширенный апгрейд-анализ монеты |

### 4.5. `src/engine/` — расчётное ядро

#### 4.5.1. Корень

| Файл | За что отвечает |
|---|---|
| `ProbabilityEngine.ts` | сборка сигнала: confluence, пороги, cooldown, `analyzeSymbol` |
| `RSICalculator.ts` | RSI и серии значений |
| `sniperMode.ts` | превращение сигналов в `SniperSignal`, фильтр качества |
| `types.ts` | общие доменные типы (CoinSignal, PairData, MarketContext, LiquidityMap, WhaleWatcherState и др.) |

#### 4.5.2. `engine/advisor`

| Файл | За что отвечает |
|---|---|
| `advisor/buildAdvisorSnapshot.ts` | компактный снимок рынка для AI с оценкой токенов |
| `advisor/buildDeskContext.ts` | контекст стола: график, поток, SMC, сессии, композит |
| `advisor/huntSetups.ts` | поиск сетапов для советника |
| `advisor/format.ts` | форматирование чисел и текста |
| `advisor/types.ts` | типы запроса/ответа советника |
| `advisor/index.ts` | публичные экспорты модуля |

#### 4.5.3. `engine/aggression`, `engine/analysis`

| Файл | За что отвечает |
|---|---|
| `aggression/index.ts` | `detectBuyerAggression` — агрессия покупателей по сделкам и стакану |
| `analysis/altMacro.ts` | альт-макро: TOTAL3, BTC.D, макро-биас |
| `analysis/deskBook.ts` | модель «книги стола»: локация, триггеры, стороны |
| `analysis/flowGate.ts` | гейт входа по потоку, OI и позиции толпы |
| `analysis/histWrPolicy.ts` | политика исторического win-rate (минимум сделок) |
| `analysis/ideaStatus.ts` | жизненный цикл идеи: ждём/активна/отменена |
| `analysis/index.ts` | экспорт модулей анализа |
| `analysis/macroStructure.ts` | макро-тренд и локация по старшим ТФ |
| `analysis/marketContextBoost.ts` | буст вероятности от новостного фона |
| `analysis/playbook.ts` | плейбук сценария |
| `analysis/readyGate.ts` | чек-лист готовности входа |
| `analysis/sessionWalk.ts` | измерение типичного хода сессии |
| `analysis/signalSnapshot.ts` | снимки сигналов и «что изменилось» |
| `analysis/deskBook.test.ts` | тест deskBook |
| `analysis/flowGate.test.ts` | тест flowGate |
| `analysis/macroStructure.test.ts` | тест macroStructure |

#### 4.5.4. `engine/backtest`

| Файл | За что отвечает |
|---|---|
| `backtest/backtester.ts` | движок бэктеста: входы, выходы, результаты |
| `backtest/backtestRunner.ts` | прогон по историческим снимкам |
| `backtest/config.ts` | константы калибровки (min samples, Wilson z, holdout) |
| `backtest/calibrationStats.ts` | доверительные интервалы, группировка, holdout-отчёт |
| `backtest/featureVector.ts` | вектор признаков и ключи групп |
| `backtest/history.ts` | загрузка исторических свечей |
| `backtest/outcomeLabeler.ts` | разметка исхода сделки |
| `backtest/fundingHypothesis.ts` | гипотеза funding-хвостов |
| `backtest/splitAxes.ts` | разбиение по осям поиска |
| `backtest/enrichPhase15.ts` | обогащение фазы 1.5 |
| `backtest/runCalibration.ts` | CLI калибровки (`npm run calibrate`) |
| `backtest/runFunding.ts` | CLI funding-проверки (`npm run funding:check`) |
| `backtest/types.ts` | типы событий/исходов/групп |
| `backtest/index.ts` | публичные экспорты |
| `backtest/calibrationTable.json` | базовая таблица калибровки |
| `backtest/calibrationTable.body.json` | калибровка по телу свечи |
| `backtest/calibrationTable.body-htfZone.json` | калибровка тело + зона старшего ТФ |
| `backtest/calibrationTable.body-htfZone-location.json` | калибровка тело + зона + локация |
| `backtest/fundingTable.json` | таблица funding-гипотезы |
| `backtest/labeledEvents.json` | размеченные события |
| `backtest/fixtures/btc-structure.json` | фикстура структуры BTC |
| `backtest/backtest.test.ts` | тест бэктестера |
| `backtest/fundingHypothesis.test.ts` | тест funding-гипотезы |

#### 4.5.5. `engine/brief`, `composite`, `confidence`, `confluence`

| Файл | За что отвечает |
|---|---|
| `brief/marketBrief.ts` | сборка текстовой сводки по таймфреймам |
| `brief/index.ts` | экспорт |
| `composite/assetClassifier.ts` | классификация актива, фазы, доминирующей силы, волатильности |
| `composite/index.ts` | `buildCompositeAnalysis` — итоговый композит |
| `confidence/dataQuality.ts` | оценка качества данных (spoof/iceberg age) |
| `confidence/invalidation.ts` | динамическая инвалидация сделки |
| `confidence/index.ts` | confidence score и проверка инвалидации |
| `confluence/scoreCard.ts` | score-card: факторы, блокеры, грейд |
| `confluence/index.ts` | экспорт |

#### 4.5.6. `engine/context`, `derivatives`, `indicators`

| Файл | За что отвечает |
|---|---|
| `context/marketContext.ts` | полный рыночный контекст, whale-контекст |
| `context/adjustThresholds.ts` | адаптация порогов под контекст |
| `context/htfClose.ts` | контекст закрытия старшего ТФ |
| `context/types.ts` | типы контекста (Crowd, HTFClose и др.) |
| `context/index.ts` | экспорт |
| `derivatives/liqHeatmap.ts` | модель heatmap ликвидаций |
| `derivatives/liquidations.ts` | кластеры ликвидаций и гейт |
| `derivatives/index.ts` | экспорт |
| `indicators/momentum.ts` | RSI, MACD, Stochastic RSI |
| `indicators/trend.ts` | EMA, SMA, Bollinger, ATR |
| `indicators/volume.ts` | VWAP и объёмы |
| `indicators/types.ts` | типы индикаторов, зон, настроек графика |
| `indicators/index.ts` | экспорт |

#### 4.5.7. `engine/journal`

| Файл | За что отвечает |
|---|---|
| `journal/classify.ts` | классификация сетапов (SMC/meme) |
| `journal/storage.ts` | localStorage-хранилище журнала |
| `journal/stats.ts` | аналитика и P&L |
| `journal/similarSetups.ts` | похожие сетапы и их статистика |
| `journal/types.ts` | типы записей журнала |
| `journal/index.ts` | запись сигналов/сделок, резолв, экспорт |

#### 4.5.8. `engine/meme`

| Файл | За что отвечает |
|---|---|
| `meme/analyzer.ts` | общий анализ мем-монеты, heat score |
| `meme/memeFilter.ts` | фильтр вселенной мемов |
| `meme/memeSignalBuilder.ts` | сборка `MemeSignal` |
| `meme/lifecycle.ts` | фазы жизненного цикла пампа |
| `meme/volumeSpike.ts` | всплеск объёма/дельты |
| `meme/liquidityGap.ts` | разрыв ликвидности |
| `meme/meanReversion.ts` | возврат к среднему |
| `meme/squeeze.ts` | short squeeze |
| `meme/backside.ts` | backside-шорт после пампа |
| `meme/bidVoid.ts` | пустота в бидах |
| `meme/cvdTrap.ts` | CVD-ловушка |
| `meme/flatline.ts` | пробой флэта |
| `meme/spreadPressure.ts` | давление спреда |
| `meme/toxic.ts` | токсичный чоп |
| `meme/volatility.ts` | gauge волатильности |
| `meme/absorptionAlert.ts` | iceberg-абсорбция |
| `meme/fuelCache.ts` | кэш OI и плотности бидов |
| `meme/index.ts` | константы и экспорт модуля |

#### 4.5.9. `engine/ml`, `mm`, `oi`

| Файл | За что отвечает |
|---|---|
| `ml/featureExtractor.ts` | извлечение и нормализация признаков |
| `ml/imbalancePredictor.ts` | модель предсказания направления |
| `ml/trainData.ts` | генерация тренировочных данных, предобученная модель |
| `ml/types.ts` | типы ML |
| `ml/index.ts` | экспорт |
| `mm/mmIntent.ts` | намерение маркет-мейкера и путь охоты за ликвидностью |
| `mm/obi.ts` | взвешенный order-book imbalance |
| `mm/iceberg.ts` | поиск iceberg-заявок |
| `mm/spoofing.ts` | детект спуфинга и убегающих стен |
| `mm/priceProdding.ts` | «прощупывание» цены |
| `mm/effortVsResult.ts` | усилие против результата |
| `mm/tripleFilter.ts` | тройной фильтр входа |
| `mm/breakeven.ts` | безубыток для мем-сделок |
| `mm/btcDump.ts` | детект дампа BTC и штраф мем-лонгов |
| `mm/index.ts` | экспорт |
| `oi/oiLog.ts` | журнал открытого интереса, бары, статистика |
| `oi/collectOi.ts` | CLI сбора OI (`npm run oi:collect`) |
| `oi/oiLog.test.ts` | тест OI-лога |

#### 4.5.10. `engine/orderbook`, `orderflow`

| Файл | За что отвечает |
|---|---|
| `orderbook/analyzer.ts` | метрики стакана, стены, дисбаланс |
| `orderbook/detector.ts` | детекторы событий стакана |
| `orderbook/heatmap.ts` | 2D-heatmap истории стакана |
| `orderbook/heatmap3d.ts` | 3D-heatmap |
| `orderbook/history.ts` | история снимков и статистика |
| `orderbook/obDelta.ts` | сдвиг объёма в стакане |
| `orderbook/scoreBooster.ts` | буст скоринга от стен и китов |
| `orderbook/tapeMomentum.ts` | импульс ленты |
| `orderbook/wallTracker.ts` | трекинг стен и их исчезновения |
| `orderbook/whaleDetector.ts` | детект китовых заявок |
| `orderbook/whaleSitLevels.ts` | кластеры накопления китов |
| `orderbook/index.ts` | экспорт |
| `orderflow/cvd.ts` | CVD-серия и дивергенции |
| `orderflow/enhancedCvd.ts` | расширенный CVD-снимок |
| `orderflow/index.ts` | экспорт |

#### 4.5.11. `engine/prediction`

| Файл | За что отвечает |
|---|---|
| `prediction/scenarioBuilder.ts` | сборка сценариев A/B/C |
| `prediction/scenarioProbabilities.ts` | вероятности сценариев с учётом новостей/контекста |
| `prediction/multiTFAnalyzer.ts` | анализ и согласованность таймфреймов |
| `prediction/pathProjector.ts` | проекция пути в пиксели графика |
| `prediction/ghostPath.ts` | призрачный путь и проверка реалистичности TP |
| `prediction/liquidityMap.ts` | карта ликвидности и ближайшие уровни |
| `prediction/macroOutlook.ts` | макро-контекст и макро-сценарии |
| `prediction/types.ts` | типы прогноза |
| `prediction/index.ts` | экспорт |

#### 4.5.12. `engine/radar`, `radar141`, `regime`, `sentiment`

| Файл | За что отвечает |
|---|---|
| `radar/dualHunt.ts` | двойная охота: полки long/short, качество цели |
| `radar141/compute.ts` | расчёт строк 141-паттерна и фильтры |
| `radar141/stats.ts` | статистика срабатываний 141 |
| `radar141/types.ts` | типы 141 |
| `radar141/index.ts` | экспорт |
| `regime/marketRegime.ts` | определение режима рынка |
| `regime/index.ts` | экспорт |
| `sentiment/analyzer.ts` | анализ тональности текста |
| `sentiment/keywords.ts` | словари бычьих/медвежьих слов, веса источников |
| `sentiment/relevance.ts` | релевантность новости монете |
| `sentiment/types.ts` | типы новостей и sentiment |
| `sentiment/index.ts` | экспорт |

#### 4.5.13. `engine/sequence` — процесс Remizov

| Файл | За что отвечает |
|---|---|
| `sequence/ingestAndDetect.ts` | приём ордер-флоу и детект последовательности |
| `sequence/frameBus.ts` | шина кадров (micro-events) |
| `sequence/types.ts` | типы кадров и хитов |
| `sequence/buildChartHints.ts` | подсказки на графике |
| `sequence/regimeGate.ts` | фильтр последовательностей по режиму |
| `sequence/sigmaBaseline.ts` | z-score базы сигм и хитов |
| `sequence/hitBaseline.ts` | базовая статистика попаданий |
| `sequence/trappedTraders.ts` | детект пойманных трейдеров |
| `sequence/wallRelease.ts` | снятие стены |
| `sequence/wallAbsorptionExhaustion.ts` | абсорбция/истощение стены |
| `sequence/cvdDivergenceLimit.ts` | CVD-дивергенция как лимит |
| `sequence/oiTracker.ts` | трекинг OI |
| `sequence/oiDeltaConfirm.ts` | подтверждение по дельте OI |
| `sequence/liqInfer.ts` | вывод ликвидаций из данных |
| `sequence/spotPerpHealth.ts` | здоровье связки спот/перп |
| `sequence/venueLead.ts` | лидерство Binance/MEXC |
| `sequence/processAudio.ts` | звуковые сигналы процесса |
| `sequence/sequenceJournal.ts` | журнал последовательностей и исторический WR |
| `sequence/index.ts` | экспорт |

#### 4.5.14. `engine/sessions`, `setups`, `signals`

| Файл | За что отвечает |
|---|---|
| `sessions/sessionCalculator.ts` | сегменты азиатской/лондонской/нью-йоркской сессий |
| `sessions/sessionMap.ts` | определения сессий и lookup по часу |
| `sessions/sessionQuality.ts` | качество и контекст сессии |
| `sessions/sessionFlip.ts` | разворот сессии |
| `sessions/dnaAnalyzer.ts` | ДНК сессии: ход, волатильность, характер |
| `sessions/newsCalendar.ts` | экономический календарь NFP/FOMC |
| `sessions/types.ts` | типы сессий |
| `sessions/index.ts` | экспорт |
| `setups/buildConditionalSetups.ts` | сборка условных сетапов из зон |
| `setups/evaluateSetupReadiness.ts` | готовность сетапа по цене/стакану |
| `setups/types.ts` | типы сетапов и лестницы целей |
| `setups/index.ts` | экспорт |
| `signals/buildDirectedSignal.ts` | направленный сигнал и watch-факторы |

#### 4.5.15. `engine/smc`

| Файл | За что отвечает |
|---|---|
| `smc/structureRead.ts` | чтение структуры по ТФ (свинги, BOS/CHoCH) |
| `smc/structureScenarios.ts` | сценарии структуры и их цвета |
| `smc/ictStructure.ts` | ICT-структура, premium/discount, breaks |
| `smc/auction.ts` | аукцион/баланс диапазона |
| `smc/closeCascade.ts` | каскад закрытий по ТФ |
| `smc/continuationExtension.ts` | продолжение/расширение 141 |
| `smc/entryZones.ts` | выбор action-зон (проторговка + FVG/OB) |
| `smc/mmTrapThesis.ts` | тезис ловушки маркет-мейкера |
| `smc/zoneReaction.ts` | реакция зоны (SSL/BSL, hold/break) |
| `smc/zoneAdvisor.ts` | разбор зоны «если → то» |
| `smc/chartStory.ts` | **сюжет графика**: зоны, комментарии, сценарии, легенда, прогноз |
| `smc/index.ts` | экспорт SMC-примитивов |

#### 4.5.16. `engine/sniper`, `strategies`, `surgical`, `telegram`

| Файл | За что отвечает |
|---|---|
| `sniper/fire.ts` | отметка «выстрела» снайпера и TTL бейджа NEW |
| `sniper/liveLimits.ts` | живые лимитные сделки, потенциал, статус в зоне |
| `strategies/classify.ts` | классификация стиля торговли |
| `strategies/intraday.ts` | интрадей-профиль, killzone, уровни |
| `strategies/scalp.ts` | скальп-профиль и уровни |
| `strategies/swing.ts` | свинг-профиль |
| `strategies/types.ts` | типы стилей и весов |
| `strategies/index.ts` | экспорт |
| `surgical/surgicalEntry.ts` | хирургический вход по OB/FVG |
| `telegram/types.ts` | настройки Telegram-алертов, лимиты избранного |

#### 4.5.17. `engine/trades`

| Файл | За что отвечает |
|---|---|
| `trades/findLiveSignal.ts` | живой сигнал: фаза, сценарий, результат |
| `trades/findProbableTrades.ts` | поиск вероятных сделок |
| `trades/liveMarketRead.ts` | чтение рынка: реакция зон, цели, план отскока |
| `trades/findBounceSetups.ts` | сетапы отскока от сильных зон |
| `trades/targetLadder.ts` | лестница целей TP1/TP2/TP3 |
| `trades/limitCases.ts` | **«сундучки»**: отложенные лимитки 1–5 %, R:R, вероятность |
| `trades/index.ts` | экспорт |
| `trades/findBounceSetups.test.ts` | тест отскоков |

#### 4.5.18. `engine/trend`, `volumeProfile`, `zones`

| Файл | За что отвечает |
|---|---|
| `trend/directionConsensus.ts` | консенсус направления по сигналам/прогнозу/стакану/новостям |
| `trend/htfTrendStrength.ts` | сила тренда старшего ТФ |
| `trend/index.ts` | экспорт |
| `volumeProfile/vpvr.ts` | VPVR, POC, value area, зоны |
| `volumeProfile/index.ts` | экспорт |
| `zones/findTradeZones.ts` | поиск торговых зон и обновление сетапов |
| `zones/liquidity.ts` | OB, FVG, POC, value area, дневные уровни |
| `zones/fibonacci.ts` | расчёт Fib-уровней |
| `zones/globalFibonacci.ts` | глобальная Fib-карта и зоны реакции |
| `zones/horizonProfiles.ts` | профили горизонтов (скальп/интрадей/свинг) |
| `zones/zoneScenarios.ts` | сценарии отскока/пробоя зоны, win-rate |
| `zones/index.ts` | экспорт |

### 4.6. `src/hooks/` — React-хуки

| Файл | За что отвечает |
|---|---|
| `hooks/useMexcScanner.ts` | основной цикл сканирования MEXC и обновление store |
| `hooks/useMexcDepthStream.ts` | live-стакан MEXC |
| `hooks/useOrderBookHistory.ts` | история стакана для heatmap |
| `hooks/useBuyerAggression.ts` | агрессия покупателей по сделкам |
| `hooks/useChartIndicators.ts` | расчёт индикаторов для графика |
| `hooks/useChartZones.ts` | зоны для графика |
| `hooks/usePriceForecast.ts` | прогноз и сценарии |
| `hooks/useMultiTFAnalysis.ts` | мульти-ТФ анализ |
| `hooks/useMLPredictor.ts` | ML-прогноз |
| `hooks/useLiqHeatmap.ts` | heatmap ликвидности |
| `hooks/useFearGreed.ts` | Fear & Greed |
| `hooks/useNewsIntelligence.ts` | новости + sentiment |
| `hooks/useWorkerMarketContext.ts` | контекст рынка из воркера |
| `hooks/useSessionData.ts` | сессии и их качество |
| `hooks/useRadar141Screener.ts` | скринер 141-паттерна |
| `hooks/useRadarFavoriteToggle.ts` | избранное радара |
| `hooks/useMemePulseScanner.ts` | сканер мем-пульса |
| `hooks/loadMemeCoinAnalysis.ts` | загрузка анализа мем-монеты |
| `hooks/useBinanceLeadStream.ts` | стрим Binance lead |
| `hooks/useAdvisorChat.ts` | чат и стриминг AI-советника |
| `hooks/useBotJournalSync.ts` | синхронизация журнала бота |
| `hooks/useSniperSignalFire.ts` | отправка снайперских сигналов |
| `hooks/useLiveLimitFreshness.ts` | свежесть живых лимиток, бейдж NEW |
| `hooks/useSignalJournalResolver.ts` | резолв журнала и статистика |
| `hooks/useTelegramWebApp.ts` | init/expand/haptic Telegram WebApp |
| `hooks/useTelegramAlerts.ts` | подписка и отправка алертов |
| `hooks/useTelegramFavoritesSync.ts` | синхронизация избранного с ботом |
| `hooks/useTradeCopilot.ts` | торговый копилот (breakeven, сопровождение) |
| `hooks/useDesktopLayout.ts` | определение ПК/мобильного layout |

### 4.7. `src/store/`, `src/utils/`, `src/i18n/`

| Файл | За что отвечает |
|---|---|
| `store/useAppStore.ts` | главный store: монеты, сигналы, контекст, настройки, журнал, избранное, Telegram |
| `store/useAdvisorStore.ts` | состояние советника: сообщения, очередь запросов, снимки по символам |
| `utils/logger.ts` | единый логгер с уровнями |
| `utils/ml.ts` | вспомогательные ML-функции |
| `i18n/index.ts` | инициализация i18next, определение языка |
| `i18n/ru.json` | русские переводы |
| `i18n/en.json` | английские переводы |
| `i18n/displayMaps.ts` | словари отображаемых названий |

### 4.8. `scripts/` — CLI и генераторы

| Файл | За что отвечает |
|---|---|
| `scripts/runBacktest.ts` | CLI бэктеста (`npm run backtest`) |
| `scripts/generate_core.py` | генерация `public/data/system_core.json` по RSI-бакетам MEXC |
| `scripts/requirements.txt` | Python-зависимости генератора |
| `scripts/README_ENV.md` | как положить MEXC API-ключи в `scripts/.env` |
| `scripts/continuationExtensionProbe.ts` | разовая проверка продолжения 141 |
| `scripts/memeBookLab.ts` | лаборатория стакана/ленты мем-монет |
| `scripts/memeBookMonitor.ts` | монитор причин пампов/дампов мемов |
| `scripts/peakFuelFailDayProbe.ts` | офлайн-проверка PEAK A/B |
| `scripts/_gen_inventory_ru.mjs` | генератор старого инвентаря (черновик, не коммитится) |
| `scripts/.env` | локальные ключи (в git не входит) |

### 4.9. `workers/` — Cloudflare Workers

#### 4.9.1. `workers/ai-advisor/`

| Файл | За что отвечает |
|---|---|
| `ai-advisor/src/index.ts` | HTTP-роутер советника, стриминг, выбор провайдера, лимиты |
| `ai-advisor/src/auth.ts` | проверка токена и Telegram-ID |
| `ai-advisor/src/env.ts` | типы окружения и секретов |
| `ai-advisor/src/limits.ts` | дневные лимиты и квоты |
| `ai-advisor/src/prompt.ts` | системный промпт советника |
| `ai-advisor/src/providers/index.ts` | ring провайдеров и fallback |
| `ai-advisor/src/providers/openaiCompat.ts` | OpenAI-совместимый провайдер |
| `ai-advisor/src/providers/workersAi.ts` | Workers AI провайдер |
| `ai-advisor/src/providers/types.ts` | типы провайдеров |
| `ai-advisor/wrangler.toml` | конфиг воркера и окружений |
| `ai-advisor/scripts/deploy-all.ps1` | деплой всех окружений |
| `ai-advisor/README.md` | инструкция по воркеру |
| `ai-advisor/package.json` | зависимости воркера |
| `ai-advisor/tsconfig.json` | TypeScript-конфиг воркера |

#### 4.9.2. `workers/mexc-proxy/` — основной backend

| Файл | За что отвечает |
|---|---|
| `mexc-proxy/src/index.ts` | HTTP-роутер: MEXC proxy, news, Telegram, scan, cron, health |
| `mexc-proxy/src/scanner.ts` | сканер рынка и запуск стратегий |
| `mexc-proxy/src/mexcUniverse.ts` | вселенная символов MEXC |
| `mexc-proxy/src/marketContext.ts` | контекст рынка для клиента |
| `mexc-proxy/src/marketPulse.ts` | пульс рынка |
| `mexc-proxy/src/marketRegime.ts` | режим рынка для клиента |
| `mexc-proxy/src/regime.ts` | внутренний режимный классификатор |
| `mexc-proxy/src/globalScanContext.ts` | общий контекст скана |
| `mexc-proxy/src/orderBookReader.ts` | чтение стакана |
| `mexc-proxy/src/bookToxicity.ts` | токсичность стакана |
| `mexc-proxy/src/liquidityZones.ts` | зоны ликвидности |
| `mexc-proxy/src/liquidationEcho.ts` | эхо ликвидаций |
| `mexc-proxy/src/mmPatterns.ts` | паттерны маркет-мейкера |
| `mexc-proxy/src/intentionReader.ts` | чтение намерений |
| `mexc-proxy/src/movePotential.ts` | потенциал движения |
| `mexc-proxy/src/volumeAccel.ts` | ускорение объёма |
| `mexc-proxy/src/phaseDetector.ts` | фаза движения |
| `mexc-proxy/src/processMoment.ts` | момент процесса |
| `mexc-proxy/src/pumpContinue.ts` | продолжение пампа |
| `mexc-proxy/src/dumpContinuation.ts` | продолжение дампа |
| `mexc-proxy/src/dumpFuelFail.ts` | провал топлива на дампе |
| `mexc-proxy/src/peakContext.ts` | контекст PEAK |
| `mexc-proxy/src/peakDecisionLog.ts` | лог решений PEAK |
| `mexc-proxy/src/peakFuelFail.ts` | PEAK fuel/fail |
| `mexc-proxy/src/predatorHotlist.ts` | хотлист Predator |
| `mexc-proxy/src/hotMemeWatchlist.ts` | вотчлист горячих мемов |
| `mexc-proxy/src/memeAgeGate.ts` | возрастной гейт мемов |
| `mexc-proxy/src/memeAntiManipulation.ts` | антиманипуляция |
| `mexc-proxy/src/memeBookForecast.ts` | прогноз по стакану мема |
| `mexc-proxy/src/memeDirectionalSignal.ts` | направленный мем-сигнал |
| `mexc-proxy/src/memeOrderFlow.ts` | ордер-флоу мема |
| `mexc-proxy/src/memePipelineDebug.ts` | отладка мем-пайплайна |
| `mexc-proxy/src/memeRegimeDetector.ts` | режим мем-рынка |
| `mexc-proxy/src/memeVolumeProfile.ts` | объёмный профиль мема |
| `mexc-proxy/src/pendingMemeTg.ts` | отложенные Telegram-сообщения по мемам |
| `mexc-proxy/src/telegramChannels.ts` | каналы/подписчики Telegram |
| `mexc-proxy/src/botEngine.ts` | торговый движок бота |
| `mexc-proxy/src/botJournal.ts` | журнал бота |
| `mexc-proxy/src/paperTrades.ts` | бумажные сделки |
| `mexc-proxy/src/watchedSetups.ts` | наблюдаемые сетапы |
| `mexc-proxy/src/userZoneWatch.ts` | пользовательские watch-зоны |
| `mexc-proxy/src/watchQuality.ts` | качество наблюдения |
| `mexc-proxy/src/candleConfirm.ts` | подтверждение свечой |
| `mexc-proxy/src/candleTape.ts` | лента свечей |
| `mexc-proxy/src/confluence.ts` | конфлюэнс воркера |
| `mexc-proxy/src/exhaustionScore.ts` | счёт истощения |
| `mexc-proxy/src/tradeOutcomeAnalysis.ts` | разбор исходов сделок |
| `mexc-proxy/src/symbolSideLock.ts` | блокировка стороны символа |
| `mexc-proxy/src/kvWrite.ts` | запись в KV |
| `mexc-proxy/src/failover.ts` | failover между воркерами |
| `mexc-proxy/src/elite/index.ts` | elite-лейн: сборка сигналов |
| `mexc-proxy/src/elite/favorites.ts` | избранное elite-лейна |
| `mexc-proxy/src/eliteAltJewel.ts` | ALT-jewel сигналы elite |
| `mexc-proxy/src/elite/tacticHunt.ts` | тактическая охота |
| `mexc-proxy/src/elite/zonePierceEntry.ts` | вход на проколе зоны |
| `mexc-proxy/src/elite/briefing.ts` | брифинг elite |
| `mexc-proxy/src/elite/chartSnapshot.ts` | снимок графика |
| `mexc-proxy/src/elite/narrative.ts` | текстовая история сигнала |
| `mexc-proxy/src/elite/favoritesDigest.ts` | дайджест избранного |
| `mexc-proxy/src/elite/assistantMode.ts` | режим ассистента |
| `mexc-proxy/src/vane/engine.ts` | VANE-движок |
| `mexc-proxy/src/vane/macroStrategy.ts` | макро-стратегия |
| `mexc-proxy/src/vane/microStrategy.ts` | микро-стратегия |
| `mexc-proxy/src/vane/macroMemory.ts` | память макро |
| `mexc-proxy/src/vane/btcShield.ts` | защита от дампа BTC |
| `mexc-proxy/src/vane/htfCache.ts` | кэш старших ТФ |
| `mexc-proxy/src/vane/internalLiquidity.ts` | внутренняя ликвидность |
| `mexc-proxy/src/vane/richContext.ts` | обогащённый контекст |
| `mexc-proxy/src/vane/portfolioRisk.ts` | портфельный риск |
| `mexc-proxy/src/vane/riskMath.ts` | расчёт риска |
| `mexc-proxy/src/vane/roundRobin.ts` | round-robin по символам |
| `mexc-proxy/src/vane/scoreCard.ts` | score-card |
| `mexc-proxy/src/vane/sessionFilter.ts` | фильтр сессий |
| `mexc-proxy/src/vane/srFlip.ts` | разворот S/R |
| `mexc-proxy/src/vane/volSpike.ts` | всплеск волатильности |
| `mexc-proxy/src/vane/zoneStrength.ts` | сила зоны |
| `mexc-proxy/src/vane/universe.ts` | вселенная VANE |
| `mexc-proxy/src/vane/mexc.ts` | MEXC-клиент VANE |
| `mexc-proxy/src/vane/types.ts` | типы VANE |
| `mexc-proxy/src/vane/index.ts` | экспорт |
| `mexc-proxy/wrangler.toml` | основной конфиг (cron, KV, ring) |
| `mexc-proxy/wrangler.standby.toml` | конфиг резервного воркера B |
| `mexc-proxy/wrangler.standby2.toml` | конфиг резервного воркера C |
| `mexc-proxy/wrangler.standby3.toml` | конфиг резервного воркера D |
| `mexc-proxy/wrangler.standby4.toml` | конфиг резервного воркера E |
| `mexc-proxy/wrangler.standby5.toml` | конфиг резервного воркера F |
| `mexc-proxy/FAILOVER.md` | схема failover |
| `mexc-proxy/README.md` | инструкция по воркеру |
| `mexc-proxy/.env` | локальные секреты для wrangler (в git не входит) |
| `mexc-proxy/src/hotMemeWatchlist.test.ts` | тест вотчлиста мемов |
| `mexc-proxy/src/memeDirectionalSignal.test.ts` | тест направленного мем-сигнала |
| `mexc-proxy/src/elite/tacticHunt.test.ts` | тест тактической охоты |
| `mexc-proxy/src/elite/zonePierceEntry.test.ts` | тест входа на проколе зоны |

### 4.10. `electron/`

| Файл | За что отвечает |
|---|---|
| `electron/main.cjs` | Electron main: окно, загрузка `dist`, failover proxy/advisor, меню, обновление |

### 4.11. `public/`, `docs/`, `.github/`, `android/`

| Файл | За что отвечает |
|---|---|
| `public/data/system_core.json` | таблицы RSI-бакетов для вероятностного движка (legacy) |
| `public/__chart-preview.html` | dev-harness графика с mock-данными (не коммитится) |
| `public/__chart-shot.html` | стенд для скриншотов графика (не коммитится) |
| `docs/BOTS_STRATEGY_AND_HISTORY.md` | история и стратегии ботов |
| `docs/PROCESS_SYSTEM.md` | описание процессной системы Remizov |
| `.github/workflows/deploy-pages.yml` | CI: checkout → node 20 → `npm ci` → build с секретами → штамп версии → deploy Pages |
| `android/build.gradle` | корневая сборка Android |
| `android/app/build.gradle` | сборка приложения, версии SDK |
| `android/settings.gradle`, `variables.gradle`, `gradle.properties`, `capacitor.settings.gradle` | настройки Gradle/Capacitor |
| `android/gradlew`, `gradlew.bat` | Gradle wrapper |
| `android/app/src/main/AndroidManifest.xml` | манифест приложения |
| `android/app/src/main/java/.../MainActivity.java` | Activity Capacitor |
| `android/app/src/main/assets/public/**` | скопированный `dist` (генерируется `npm run android:sync`) |
| `services/jeweler/` | зарезервированная папка под будущий сервис (пусто) |

---

## 5. Как читать код

1. **Новый экран** → `src/components/<домен>/`, затем маршрут в `App.tsx`.
2. **Новая метрика** → `src/engine/<домен>/`, экспорт через `index.ts`, затем хук.
3. **Новый источник данных** → `src/api/<источник>.ts` + хук в `src/hooks/`.
4. **Новая настройка** → `useAppStore` + `localStorage`-ключ `enterprise_*`.
5. **Новый алерт** → `engine` (условие) → `useTelegramAlerts`/`useSniperSignalFire`
   → `workers/mexc-proxy` (рассылка).

## 6. Сборка и запуск

```powershell
npm install          # зависимости
npm run dev          # http://127.0.0.1:5173
npm run build        # tsc -b && vite build → dist/
npm run preview      # локальный просмотр dist
npm run desktop      # Electron-окно
npm run android:sync # сборка + копирование в android/
npm run android:apk  # сборка debug APK
```

Деплой на GitHub Pages запускается автоматически push-ем в `main`.
Подробная памятка команд — в `docs/PUSH_CHEATSHEET_RU.md`.
