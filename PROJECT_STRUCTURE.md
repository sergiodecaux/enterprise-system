# Enterprise System - Подробное описание проекта

## 📋 Оглавление

1. [Обзор проекта](#обзор-проекта)
2. [Технологический стек](#технологический-стек)
3. [Структура проекта](#структура-проекта)
4. [Архитектура системы](#архитектура-системы)
5. [Компоненты](#компоненты)
6. [Хуки](#хуки)
7. [Движок анализа](#движок-анализа)
8. [Генерация данных](#генерация-данных)
9. [Интернационализация](#интернационализация)
10. [Развертывание](#развертывание)

---

## 🎯 Обзор проекта

**Enterprise System** — это криптовалютная аналитическая платформа, которая использует машинное обучение и технический анализ для прогнозирования вероятности движения цен криптовалют.

### Основные возможности:

- **Real-time анализ**: Получение данных о ценах в реальном времени через WebSocket/REST API
- **Вероятностный анализ**: Расчет вероятности движения цены на основе исторических данных и RSI индикатора
- **Тактический вид**: Детальный анализ отдельных монет с графиками и метриками
- **Монетизация**: Система блокировки для бесплатных пользователей (только BTC/USDT доступен)
- **Telegram Mini App**: Интеграция с Telegram для удобного доступа

---

## 🛠 Технологический стек

### Frontend:
- **React 18** — UI библиотека
- **TypeScript** — типизация
- **Vite** — сборщик и dev-сервер
- **TailwindCSS** — стилизация
- **Zustand** — управление состоянием
- **i18next** — интернационализация (EN/RU)
- **Lightweight Charts** — графики свечей
- **Lucide React** — иконки

### Backend/Data:
- **Python 3** — генерация данных
- **pandas** — обработка данных
- **requests** — HTTP запросы
- **MEXC API** — источник исторических данных

### Инфраструктура:
- **Vercel** — хостинг и деплой
- **GitHub** — версионирование

---

## 📁 Структура проекта

```
enterprise-system/
├── public/
│   └── data/
│       ├── system_core.json          # Генерируемая база вероятностей (minified)
│       └── system_core_debug.json     # Отладочная версия (pretty-printed)
│
├── scripts/
│   ├── generate_core.py              # Python скрипт генерации данных
│   ├── requirements.txt              # Python зависимости
│   └── README_ENV.md                 # Инструкции по настройке
│
├── src/
│   ├── assets/
│   │   └── fonts/                    # Кастомные шрифты
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Header.tsx            # Верхняя панель навигации
│   │   │   ├── StatusIndicator.tsx   # Индикатор подключения
│   │   │   └── LanguageToggle.tsx    # Переключатель языка
│   │   │
│   │   ├── radar/
│   │   │   ├── RadarView.tsx          # Главный экран радара
│   │   │   ├── CoinRow.tsx            # Строка монеты в списке
│   │   │   └── WinRateBar.tsx        # Прогресс-бар вероятности
│   │   │
│   │   ├── tactical/
│   │   │   ├── TacticalDrawer.tsx     # Нижний drawer с деталями
│   │   │   ├── ProbabilityGauge.tsx  # Полукруглый индикатор вероятности
│   │   │   ├── LiveChart.tsx          # График свечей (Lightweight Charts)
│   │   │   └── DataLog.tsx            # Терминальный лог анализа
│   │   │
│   │   ├── monetization/
│   │   │   └── ProGate.tsx            # Модальное окно Pro функций
│   │   │
│   │   └── ErrorBoundary.tsx          # Обработчик ошибок React
│   │
│   ├── engine/
│   │   ├── types.ts                   # TypeScript интерфейсы
│   │   ├── RSICalculator.ts          # Клиентский расчет RSI
│   │   └── ProbabilityEngine.ts      # Движок вероятностного анализа
│   │
│   ├── hooks/
│   │   ├── useBinanceWebSocket.ts     # WebSocket/REST подключение к Binance
│   │   ├── useProbabilityEngine.ts   # Оркестрация расчета сигналов
│   │   └── useTelegramWebApp.ts      # Интеграция с Telegram Mini App
│   │
│   ├── i18n/
│   │   ├── index.ts                   # Конфигурация i18next
│   │   ├── en.json                    # Английские переводы
│   │   └── ru.json                    # Русские переводы
│   │
│   ├── store/
│   │   └── useAppStore.ts             # Zustand store (глобальное состояние)
│   │
│   ├── styles/
│   │   └── globals.css                # Глобальные стили, анимации
│   │
│   ├── utils/
│   │   └── logger.ts                  # Утилита логирования
│   │
│   ├── App.tsx                        # Главный компонент приложения
│   ├── main.tsx                       # Точка входа React
│   └── vite-env.d.ts                  # Типы для Vite
│
├── .gitignore                         # Игнорируемые файлы
├── index.html                          # HTML шаблон
├── package.json                        # NPM зависимости и скрипты
├── tsconfig.json                       # TypeScript конфигурация
├── vite.config.ts                      # Vite конфигурация
├── tailwind.config.ts                  # TailwindCSS конфигурация
├── postcss.config.js                   # PostCSS конфигурация
├── vercel.json                         # Конфигурация Vercel
└── README.md                           # Основная документация
```

---

## 🏗 Архитектура системы

### Поток данных:

```
[MEXC API] → [Python Generator] → [system_core.json]
                                              ↓
[Binance WS/REST] → [RSI Calculator] → [Probability Engine] → [UI Components]
                                              ↓
                                    [Zustand Store]
```

### Основные модули:

1. **Data Generation** (`scripts/generate_core.py`)
   - Скачивает исторические данные с MEXC API
   - Рассчитывает RSI и создает бакеты вероятностей
   - Генерирует `system_core.json` с метриками win rate

2. **Data Fetching** (`hooks/useBinanceWebSocket.ts`)
   - Подключается к Binance WebSocket для real-time цен
   - Fallback на REST API polling при недоступности WS
   - Обновляет цены в Zustand store

3. **RSI Calculation** (`engine/RSICalculator.ts`)
   - Клиентский расчет RSI(14) по методу Wilder's smoothing
   - Поддерживает буфер до 200 цен
   - Обрабатывает edge cases (avgLoss = 0)

4. **Probability Engine** (`engine/ProbabilityEngine.ts`)
   - Загружает `system_core.json`
   - Сопоставляет текущий RSI с историческими бакетами
   - Генерирует сигналы LONG/SHORT с вероятностями

5. **UI Layer** (React Components)
   - Отображает сигналы в виде списка (RadarView)
   - Показывает детальный анализ (TacticalDrawer)
   - Управляет состоянием через Zustand

---

## 🧩 Компоненты

### Layout Components

#### `Header.tsx`
- Фиксированная верхняя панель
- Содержит: логотип, StatusIndicator, LanguageToggle
- Декоративная градиентная линия внизу

#### `StatusIndicator.tsx`
- Пульсирующая точка (зеленая/красная/желтая)
- Показывает статус подключения: ONLINE/POLLING/OFFLINE
- Текст статуса с i18n

#### `LanguageToggle.tsx`
- Переключатель EN/RU
- Неоновый эффект при активном состоянии
- Использует `i18n.changeLanguage()`

### Radar Components

#### `RadarView.tsx`
- Главный экран приложения
- Заголовок секции с иконкой и подзаголовком
- Заголовки колонок таблицы
- Список `CoinRow` компонентов
- Skeleton loader при загрузке
- Empty state с анимацией
- Footer с информацией о данных

#### `CoinRow.tsx`
- Одна строка в списке монет
- Отображает: ранг, символ, цену, изменение 24h
- Бейдж сигнала (LONG/SHORT)
- `WinRateBar` для визуализации вероятности
- Иконка стрелки/замка
- Обработчик клика для открытия TacticalDrawer
- Blur эффект для заблокированных монет

#### `WinRateBar.tsx`
- Горизонтальный прогресс-бар
- Динамическая ширина и цвет по значению
- Shimmer анимация
- Blur и иконка замка для locked состояния

### Tactical Components

#### `TacticalDrawer.tsx`
- Нижний slide-up drawer
- Backdrop с затемнением
- Drag handle для закрытия
- Header с информацией о монете
- `ProbabilityGauge` для визуализации
- Сетка статистики
- `LiveChart` для графика
- `DataLog` для текстового анализа
- Haptic feedback при открытии

#### `ProbabilityGauge.tsx`
- Полукруглый SVG gauge
- Анимация заполнения
- Динамический цвет (зеленый/красный)
- Центральный текст с процентом и направлением
- Tick marks для шкалы

#### `LiveChart.tsx`
- График свечей через Lightweight Charts
- Темная тема
- Real-time обновления цен
- ResizeObserver для адаптивности
- TODO: замена mock данных на реальные klines

#### `DataLog.tsx`
- Терминальный стиль текста
- Typewriter эффект
- Мигающий курсор
- Зеленый текст на темном фоне
- Отображает детальный анализ сигнала

### Monetization

#### `ProGate.tsx`
- Модальное окно для Pro функций
- Floating кнопка "Upgrade"
- TODO: интеграция с Telegram Stars

### Error Handling

#### `ErrorBoundary.tsx`
- React Error Boundary
- Ловит JavaScript ошибки
- Показывает fallback UI
- Кнопка перезагрузки страницы

---

## 🎣 Хуки

### `useBinanceWebSocket.ts`

**Назначение**: Подключение к Binance для получения real-time цен

**Функциональность**:
- Множественные WebSocket endpoints (порт 9443, 443, futures)
- Fallback на REST API polling при недоступности WS
- Загрузка исторических klines для начального RSI
- Retry логика (3 попытки на endpoint)
- Throttling обновлений (1 раз в секунду)
- Статусы подключения: ONLINE/POLLING/OFFLINE
- Обновление Zustand store с тикерами

**Возвращает**:
```typescript
{
  isConnected: boolean
  connectionStatus: 'ONLINE' | 'POLLING' | 'OFFLINE'
  reconnect: () => void
}
```

### `useProbabilityEngine.ts`

**Назначение**: Оркестрация расчета RSI и генерации сигналов

**Функциональность**:
- Загрузка `system_core.json` при монтировании
- Инициализация `RSICalculator` для каждой пары
- Подписка на изменения `liveTickets` в store
- Подача цен в калькуляторы RSI
- Вызов `ProbabilityEngine.lookup()` для получения сигналов
- Throttling пересчета (1 раз в 2 секунды)
- Обновление `signals` в store

**Возвращает**:
```typescript
{
  isLoading: boolean
  error: string | null
  coreVersion: string | null
}
```

### `useTelegramWebApp.ts`

**Назначение**: Интеграция с Telegram Mini App API

**Функциональность**:
- Проверка наличия `window.Telegram?.WebApp`
- Однократный вызов `WebApp.ready()` и `WebApp.expand()`
- Установка цветов header и background
- Извлечение языка пользователя и user ID
- Haptic feedback методы
- Mock значения для разработки вне Telegram

**Возвращает**:
```typescript
{
  isInTelegram: boolean
  userLanguage: string
  userId: number | null
  haptic: {
    impact: () => void
    notification: (type: 'success' | 'error' | 'warning') => void
  }
}
```

---

## ⚙️ Движок анализа

### `RSICalculator.ts`

**Класс для клиентского расчета RSI**

**Методы**:
- `constructor(period: number = 14)` — инициализация
- `addPrice(price: number): void` — добавление цены в буфер
- `calculate(): number | null` — расчет RSI (Wilder's smoothing)
- `reset(): void` — очистка буфера
- `getBufferSize(): number` — размер буфера

**Алгоритм**:
1. Вычисление изменений цены (deltas)
2. Разделение на gains и losses
3. Первый avg = SMA за 14 периодов
4. Последующие = Wilder's smoothing: `avg = (prevAvg * 13 + current) / 14`
5. RS = avgGain / avgLoss
6. RSI = 100 - (100 / (1 + RS))

### `ProbabilityEngine.ts`

**Класс для вероятностного анализа**

**Методы**:
- `constructor(systemCore: SystemCore)` — инициализация с данными
- `getBucketKey(rsi: number): string` — получение ключа бакета (RSI_30, RSI_35, ...)
- `lookup(symbol, rsi)` — поиск сигнала для пары и RSI
- `getBestSignals(liveData, liveTickers)` — генерация лучших сигналов для всех пар
- `getDetailedAnalysis(symbol, rsi)` — детальный анализ для тактического вида

**Логика lookup**:
1. Пытается найти точный бакет по RSI
2. Если нет данных (samples < 30), пробует соседние бакеты (±5)
3. Возвращает сигнал с наибольшим win_rate

---

## 📊 Генерация данных

### `scripts/generate_core.py`

**Назначение**: Генерация вероятностной lookup таблицы

**Процесс**:

1. **Загрузка данных**:
   - Подключение к MEXC API (публичный endpoint)
   - Скачивание 1h свечей за 730 дней для 20 пар
   - Пагинация по 1000 свечей
   - Задержка 0.2 сек между запросами

2. **Расчет индикаторов**:
   - RSI(14) через Wilder's smoothing
   - Создание бакетов: округление RSI вниз до кратного 5

3. **Проверка исходов**:
   - Для каждой свечи проверяются следующие 3 свечи
   - WIN_LONG: max(high[i+1:i+4]) / close[i] - 1 >= 1%
   - WIN_SHORT: 1 - min(low[i+1:i+4]) / close[i] >= 1%

4. **Агрегация**:
   - Группировка по RSI бакетам
   - Подсчет win rates для LONG и SHORT
   - Выбор направления с большим win_rate
   - Расчет среднего return

5. **Фильтрация**:
   - Удаление бакетов с samples < 30
   - Поиск best_signal (samples >= 50, max win_rate)

6. **Вывод**:
   - Минифицированный JSON в `public/data/system_core.json`
   - Pretty-printed версия в `system_core_debug.json`

**Формат данных**:
```json
{
  "generated_at": "2025-02-11T15:30:00Z",
  "version": "1.0.0",
  "pairs": {
    "BTCUSDT": {
      "indicators": {
        "RSI_30": {
          "win_rate": 73.2,
          "samples": 89,
          "direction": "LONG",
          "avg_return": 1.8
        }
      },
      "best_signal": {
        "key": "RSI_30",
        "win_rate": 73.2,
        "direction": "LONG"
      }
    }
  },
  "meta": {
    "total_pairs": 20,
    "timeframe": "1h",
    "lookback_days": 730,
    "win_threshold_pct": 1.0,
    "win_window_candles": 3
  }
}
```

---

## 🌍 Интернационализация

### Структура i18n:

- **`src/i18n/index.ts`**: Конфигурация i18next
  - Использует `i18next-browser-languagedetector`
  - Порядок детекции: localStorage → navigator
  - Fallback: `en`
  - Регистрация `en.json` и `ru.json`

- **`src/i18n/en.json`**: Английские переводы
- **`src/i18n/ru.json`**: Русские переводы

### Использование:

```typescript
import { useTranslation } from 'react-i18next'

const { t } = useTranslation()
<p>{t('radar_title')}</p>
```

### Ключи переводов:

- `radar_title`, `radar_subtitle`
- `column_asset`, `column_signal`, `column_probability`
- `status_online`, `status_offline`, `status_polling`
- `status_scanning`, `connection_unavailable`
- `footer_data_age`, `footer_version`
- И другие...

---

## 🚀 Развертывание

### Локальная разработка:

```bash
# Установка зависимостей
npm install

# Генерация данных (опционально)
cd scripts
pip install -r requirements.txt
python generate_core.py

# Запуск dev-сервера
npm run dev
```

### Production сборка:

```bash
npm run build
```

### Vercel деплой:

1. Подключить GitHub репозиторий к Vercel
2. Настроить автоматический деплой
3. `vercel.json` настроен для SPA routing
4. Кеширование `/data/*` файлов (1 час)

### Telegram Bot настройка:

1. Создать бота через @BotFather
2. Получить токен бота
3. Установить Mini App URL: `https://your-domain.vercel.app`
4. Пользователи могут открыть приложение через бота

---

## 📝 Типы данных

### Основные интерфейсы (`src/engine/types.ts`):

```typescript
interface IndicatorBucket {
  win_rate: number;       // 0-100
  samples: number;
  direction: 'LONG' | 'SHORT';
  avg_return: number;
}

interface PairData {
  indicators: Record<string, IndicatorBucket>;
  best_signal: {
    key: string;
    win_rate: number;
    direction: 'LONG' | 'SHORT';
  };
}

interface SystemCore {
  generated_at: string;
  version: string;
  pairs: Record<string, PairData>;
  meta: {
    total_pairs: number;
    timeframe: string;
    lookback_days: number;
    win_threshold_pct: number;
    win_window_candles: number;
  };
}

interface LiveTicker {
  symbol: string;         // "BTCUSDT"
  price: number;
  priceChange24h: number; // percentage
  volume24h: number;
  high24h: number;
  low24h: number;
  timestamp: number;
}

interface CoinSignal {
  symbol: string;
  displayName: string;    // "BTC/USDT"
  price: number;
  priceChange24h: number;
  currentRSI: number | null;
  activeSignal: IndicatorBucket | null;
  activeSignalKey: string | null;
  isLocked: boolean;      // true for non-BTC in free version
}
```

---

## 🎨 Стилизация

### TailwindCSS конфигурация:

**Кастомные цвета**:
- `space` — темный фон (#0a0a0a)
- `hull` — панели (#1a1a1a)
- `matrix` — акцентный зеленый (#00ff88)
- `alert` — красный для ошибок
- `holo` — текст (#e0e0e0)

**Шрифты**:
- `mono`: JetBrains Mono (для технического вида)
- `sans`: Inter (для UI)

### Анимации (`globals.css`):

- `pulse-dot` — пульсация точки статуса
- `shimmer` — мерцание на прогресс-барах
- `typewriter` — эффект печати в DataLog
- `blink-cursor` — мигающий курсор

---

## 🔧 Утилиты

### `logger.ts`

Централизованное логирование:

```typescript
logger.info('Message')    // 🟢 только в dev
logger.warn('Warning')   // 🟡 только в dev
logger.error('Error')    // 🔴 всегда
logger.ws('WebSocket')   // 📡 только в dev
```

Логирование отключено в production для чистоты консоли.

---

## 📌 TODO

В коде есть комментарии TODO для будущих улучшений:

- `LiveChart.tsx`: Замена mock данных на реальные Binance klines
- `ProGate.tsx`: Интеграция Telegram Stars payment
- `ProbabilityEngine.ts`: Добавление MACD, EMA crossover
- `useBinanceWebSocket.ts`: Push уведомления для высоких вероятностей
- `useProbabilityEngine.ts`: Web Worker для тяжелых расчетов

---

## 🔐 Безопасность

- API ключи не хранятся в коде (используются только публичные endpoints)
- `.env` файлы в `.gitignore`
- Все данные валидируются перед использованием
- Error Boundary для обработки ошибок
- TypeScript для типобезопасности

---

## 📈 Производительность

- Throttling обновлений (1 сек для WS, 2 сек для сигналов)
- Lazy loading компонентов через React.Suspense
- Chunk splitting в Vite (react, charts, i18n отдельно)
- Кеширование `/data/*` файлов на Vercel
- Оптимизация RSI расчетов (буфер ограничен 200 ценами)

---

## 🐛 Отладка

### Dev режим:

- Логирование через `logger` утилиту
- Детальные ошибки в консоли
- React DevTools для инспекции состояния

### Production:

- Минимальное логирование (только ошибки)
- Error Boundary для graceful degradation
- Vercel Analytics для мониторинга

---

**Версия документа**: 1.0.0  
**Последнее обновление**: 2025-02-11
