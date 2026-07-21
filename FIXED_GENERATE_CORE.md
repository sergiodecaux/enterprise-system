# Исправленный скрипт generate_core.py

## Полный исправленный код

См. файл `scripts/generate_core.py` - все исправления применены.

## Основные исправления

### 1. ✅ ДИАГНОСТИКА - Добавлен отладочный вывод

```python
# DIAGNOSTIC: Debug output BEFORE validation
if df is not None and len(df) > 0:
    first_date = pd.to_datetime(df['timestamp'].iloc[0], unit='ms')
    last_date = pd.to_datetime(df['timestamp'].iloc[-1], unit='ms')
    print(f"  DEBUG {symbol}: downloaded {len(df)} candles, first date: {first_date.strftime('%Y-%m-%d')}, last date: {last_date.strftime('%Y-%m-%d')}")
else:
    print(f"  DEBUG {symbol}: downloaded 0 candles (no data available)")
    return None
```

Теперь видно сколько свечей реально скачано ПЕРЕД проверкой на "insufficient data".

### 2. ✅ СНИЖЕНЫ ТРЕБОВАНИЯ К ДАННЫМ

- Минимум свечей: 100 (константа `MIN_CANDLES_REQUIRED = 100`)
- Если за 2 года не получилось скачать - используется то что есть
- Даже 500 свечей (~20 дней) достаточно для расчёта RSI

```python
MIN_CANDLES_REQUIRED = 100  # Minimum candles to process a pair

# LOWERED REQUIREMENTS: Minimum 100 candles (not more)
if df is None or len(df) < MIN_CANDLES_REQUIRED:
    print(f"  ⚠️  Insufficient data for {symbol}: {len(df) if df is not None else 0} candles (minimum {MIN_CANDLES_REQUIRED} required)")
    return None
```

### 3. ✅ ИСПРАВЛЕНА ПАГИНАЦИЯ

**Проблема**: Использовался Open time (`klines[-1][0]`) вместо Close time (`klines[-1][6]`)

**Исправление**:
```python
# Move to next batch using Close time of last candle + 1ms
# Use Close time (element [6]) not Open time (element [0])
last_close_time = int(klines[-1][6])
current_start = last_close_time + 1
```

**Добавлено**:
- Логирование батчей: `print(f" batch {batch_num} ({batch_size})", end='', flush=True)`
- Защита от дубликатов: `seen_timestamps` set
- Обработка пустого массива от Binance (остановка пагинации)
- Проверка что `current_start < end_timestamp`

### 4. ✅ ПРОВЕРЕН ФОРМАТ ОТВЕТА BINANCE

**Правильный парсинг**:
```python
# Binance klines format:
# [0] = Open time (ms timestamp)
# [4] = Close price (string) - нужно float()
# [6] = Close time (ms timestamp) - используется для пагинации

timestamp = int(kline[0])  # Open time
close_price = float(kline[4])  # Close price (строка -> float)
close_time = int(kline[6])  # Close time для следующего батча
```

**Конвертация в numeric**:
```python
df['timestamp'] = pd.to_numeric(df['timestamp'])
df['close'] = pd.to_numeric(df['close'])  # Все значения приходят как строки
```

### 5. ✅ ПРОВЕРЕН startTime

**Правильная логика**:
```python
# Первый запрос
start_timestamp = int(start_time.timestamp() * 1000)

# Следующие запросы
last_close_time = int(klines[-1][6])  # Close time последней свечи
current_start = last_close_time + 1  # +1ms чтобы не дублировать

# Остановка если достигли текущего времени
if current_start >= end_timestamp:
    break
```

### 6. ✅ ОБРАБОТАН ПУСТОЙ МАССИВ ОТ BINANCE

```python
# Check if Binance returned empty array (no data for this period)
if isinstance(data, list) and len(data) == 0:
    return []

# В цикле пагинации
if len(klines) == 0:
    # No more data available for this period
    break
```

Если Binance возвращает пустой массив - это значит нет данных за этот период (монета ещё не торговалась). Используется то что уже скачано.

### 7. ✅ УЛУЧШЕН ВЫВОД

Теперь скрипт выводит:
```
BTCUSDT: fetching... batch 1 (1000) batch 2 (1000) ... batch 18 (520)
DEBUG BTCUSDT: downloaded 17520 candles, first date: 2023-02-11, last date: 2025-02-11
BTCUSDT: RSI calculating... done
✓ BTCUSDT: 17520 candles loaded, date range: 2023-02-11 to 2025-02-11
✓ BTCUSDT: RSI calculated, 16 valid buckets
✓ BTCUSDT: best signal RSI_10 (78.5%, 45 samples, LONG)
✓ BTCUSDT complete
```

### 8. ✅ СОЗДАНИЕ ФАЙЛА ДАЖЕ ЕСЛИ НЕ ВСЕ ПАРЫ ОБРАБОТАНЫ

```python
# CREATE FILE EVEN IF NOT ALL PAIRS PROCESSED
# If at least 1 pair processed, write JSON
if not pairs_data:
    print("\n✗ No pairs processed successfully. Check your internet connection or try using VPN.")
    sys.exit(1)
```

Если обработана хотя бы 1 пара - JSON файл создаётся.

## Дополнительные улучшения

1. **Защита от дубликатов**: Используется `seen_timestamps` set для отслеживания уже добавленных свечей
2. **Удаление дубликатов в DataFrame**: `df.drop_duplicates(subset=['timestamp'], keep='first')`
3. **Улучшенная обработка ошибок**: Вывод traceback при исключениях
4. **Прогресс-бар**: Используется `tqdm` для визуализации прогресса

## Тестирование

После исправлений скрипт должен:
1. ✅ Скачивать данные для всех 20 пар
2. ✅ Показывать отладочную информацию о количестве свечей
3. ✅ Обрабатывать пары даже если скачано меньше 2 лет данных
4. ✅ Правильно пагинировать через Close time
5. ✅ Создавать JSON файл даже если обработаны не все пары

## Запуск

```bash
cd scripts
pip install -r requirements.txt
python generate_core.py
```
