#!/usr/bin/env python3
"""
Enterprise System - Core Data Generator
Source: MEXC Exchange API
"""

import json
import math
import os
import sys
import time
from datetime import datetime, timedelta

import requests
import pandas as pd
from tqdm import tqdm

MEXC_BASE_URL = 'https://api.mexc.com'

PAIRS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT',
    'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
    'UNIUSDT', 'ATOMUSDT', 'LTCUSDT', 'FILUSDT', 'APTUSDT',
    'ARBUSDT', 'OPUSDT', 'SUIUSDT', 'NEARUSDT', 'MATICUSDT'
]

TIMEFRAME = '60m'
LOOKBACK_DAYS = 730
WIN_THRESHOLD_PCT = 1.0
WIN_WINDOW_CANDLES = 3
RSI_PERIOD = 14
RSI_BUCKET_SIZE = 5
MIN_SAMPLES = 30
BEST_SIGNAL_MIN_SAMPLES = 50
MIN_CANDLES = 100

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'public', 'data')
OUTPUT_FILE = os.path.join(OUTPUT_DIR, 'system_core.json')


def mexc_get(endpoint):
    """Simple GET request to MEXC - params must be in URL string"""
    url = f'{MEXC_BASE_URL}{endpoint}'
    for attempt in range(3):
        try:
            r = requests.get(url, timeout=15)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 400:
                return None
            if attempt < 2:
                time.sleep(1)
        except Exception:
            if attempt < 2:
                time.sleep(1)
    return None


def test_connection():
    """Test MEXC API"""
    data = mexc_get('/api/v3/ping')
    if data is not None:
        print("✓ MEXC API connected")
        return True
    print("✗ MEXC API connection failed")
    return False


def test_klines():
    """Test klines endpoint"""
    data = mexc_get(f'/api/v3/klines?symbol=BTCUSDT&interval={TIMEFRAME}&limit=3')
    if data and isinstance(data, list) and len(data) > 0:
        price = float(data[0][4])
        print(f"✓ Test: got {len(data)} candles, BTC price: ${price:,.2f}")
        return True
    print("✗ Klines test failed")
    return False


def fetch_all_candles(symbol):
    """Fetch all candles with pagination"""
    print(f"  {symbol}:", end='', flush=True)

    end_ts = int(datetime.now().timestamp() * 1000)
    start_ts = int((datetime.now() - timedelta(days=LOOKBACK_DAYS)).timestamp() * 1000)

    all_candles = []
    current_start = start_ts
    batch_num = 0
    seen = set()

    while current_start < end_ts:
        batch_num += 1
        data = mexc_get(
            f'/api/v3/klines?symbol={symbol}&interval={TIMEFRAME}&startTime={current_start}&limit=1000'
        )

        if data is None:
            print(f" failed at batch {batch_num}")
            break

        if len(data) == 0:
            break

        added = 0
        for candle in data:
            ts = int(candle[0])
            if ts not in seen:
                seen.add(ts)
                all_candles.append(candle)
                added += 1

        print(f" b{batch_num}({added})", end='', flush=True)

        if len(data) < 1000:
            break

        # MEXC: 8 columns, [6] = closeTime
        last_close = int(data[-1][6])
        current_start = last_close + 1

        if current_start >= end_ts:
            break

        time.sleep(0.2)

    print(f" = {len(all_candles)} candles")

    if len(all_candles) < MIN_CANDLES:
        print(f"  ⚠️  {symbol}: only {len(all_candles)} candles (need {MIN_CANDLES})")
        return None

    # MEXC returns 8 columns: [timestamp, open, high, low, close, volume, closeTime, quoteVolume]
    df = pd.DataFrame(all_candles, columns=[
        'openTime', 'open', 'high', 'low', 'close', 'volume', 'closeTime', 'quoteVolume'
    ])

    for col in ['openTime', 'open', 'high', 'low', 'close', 'volume']:
        df[col] = pd.to_numeric(df[col])

    df = df.sort_values('openTime').reset_index(drop=True)
    df = df.drop_duplicates(subset=['openTime'], keep='first')

    return df


def calculate_rsi(df):
    """Calculate RSI(14) using Wilder's smoothing"""
    delta = df['close'].diff()
    gain = delta.where(delta > 0, 0)
    loss = (-delta).where(delta < 0, 0)

    avg_gain = gain.ewm(alpha=1 / RSI_PERIOD, min_periods=RSI_PERIOD, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / RSI_PERIOD, min_periods=RSI_PERIOD, adjust=False).mean()

    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    return rsi.fillna(100).clip(0, 100)


def get_bucket(rsi):
    """RSI -> bucket key"""
    if pd.isna(rsi):
        return None
    b = int(math.floor(rsi / RSI_BUCKET_SIZE) * RSI_BUCKET_SIZE)
    return f"RSI_{b}"


def process_pair(symbol):
    """Process one pair"""
    df = fetch_all_candles(symbol)
    if df is None:
        return None

    print(f"  {symbol}: RSI...", end='', flush=True)
    df['rsi'] = calculate_rsi(df)
    print(" done")

    stats = {}

    for i in range(len(df) - WIN_WINDOW_CANDLES):
        rsi = df.iloc[i]['rsi']
        if pd.isna(rsi):
            continue

        bucket = get_bucket(rsi)
        if bucket is None:
            continue

        close = df.iloc[i]['close']
        future = df.iloc[i + 1:i + 1 + WIN_WINDOW_CANDLES]
        if len(future) < WIN_WINDOW_CANDLES:
            continue

        max_high = future['high'].max()
        min_low = future['low'].min()

        ret_long = (max_high / close) - 1
        ret_short = 1 - (min_low / close)

        win_long = ret_long >= (WIN_THRESHOLD_PCT / 100.0)
        win_short = ret_short >= (WIN_THRESHOLD_PCT / 100.0)

        if bucket not in stats:
            stats[bucket] = {
                'total': 0, 'lw': 0, 'sw': 0, 'lr': [], 'sr': []
            }

        stats[bucket]['total'] += 1
        if win_long:
            stats[bucket]['lw'] += 1
            stats[bucket]['lr'].append(ret_long * 100)
        if win_short:
            stats[bucket]['sw'] += 1
            stats[bucket]['sr'].append(ret_short * 100)

    indicators = {}
    best = None
    best_wr = 0

    for bk, s in stats.items():
        if s['total'] < MIN_SAMPLES:
            continue

        lwr = round(s['lw'] / s['total'] * 100, 1)
        swr = round(s['sw'] / s['total'] * 100, 1)

        if lwr > swr:
            d, wr = 'LONG', lwr
            ar = round(sum(s['lr']) / len(s['lr']), 2) if s['lr'] else 0.0
        else:
            d, wr = 'SHORT', swr
            ar = round(sum(s['sr']) / len(s['sr']), 2) if s['sr'] else 0.0

        indicators[bk] = {
            'win_rate': wr, 'samples': s['total'], 'direction': d, 'avg_return': ar
        }

        if s['total'] >= BEST_SIGNAL_MIN_SAMPLES and wr > best_wr:
            best_wr = wr
            best = {'key': bk, 'win_rate': wr, 'direction': d}

    if not indicators:
        print(f"  ⚠️  {symbol}: no valid indicators")
        return None

    if best is None:
        top = max(indicators.items(), key=lambda x: x[1]['win_rate'])
        best = {'key': top[0], 'win_rate': top[1]['win_rate'], 'direction': top[1]['direction']}

    bk = best['key']
    print(f"  ✓ {symbol}: {len(indicators)} buckets, best {bk} "
          f"({best['win_rate']}%, {indicators[bk]['samples']} samples, {best['direction']})")

    return {'indicators': indicators, 'best_signal': best}


def main():
    print("=" * 70)
    print("Enterprise System - Core Data Generator")
    print("=" * 70)
    print(f"Source: MEXC Exchange API")
    print(f"Pairs: {len(PAIRS)} | Lookback: {LOOKBACK_DAYS} days | Interval: {TIMEFRAME}")
    print("=" * 70)
    print()

    if not test_connection():
        sys.exit(1)
    if not test_klines():
        sys.exit(1)
    print()

    pairs_data = {}
    failed = []

    for symbol in tqdm(PAIRS, desc="Processing"):
        try:
            result = process_pair(symbol)
            if result:
                pairs_data[symbol] = result
            else:
                failed.append(symbol)
        except Exception as e:
            print(f"  ✗ {symbol}: {e}")
            failed.append(symbol)

    if not pairs_data:
        print("\n✗ No pairs processed")
        sys.exit(1)

    output = {
        'generated_at': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'version': '1.0.0',
        'pairs': pairs_data,
        'meta': {
            'total_pairs': len(pairs_data),
            'timeframe': '1h',
            'lookback_days': LOOKBACK_DAYS,
            'win_threshold_pct': WIN_THRESHOLD_PCT,
            'win_window_candles': WIN_WINDOW_CANDLES
        }
    }

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(output, f, separators=(',', ':'))

    size = os.path.getsize(OUTPUT_FILE) / (1024 * 1024)
    buckets = sum(len(p['indicators']) for p in pairs_data.values())

    print("\n" + "=" * 70)
    print("GENERATION COMPLETE")
    print("=" * 70)
    print(f"✓ Pairs: {len(pairs_data)}")
    print(f"✓ Buckets: {buckets}")
    print(f"✓ Size: {size:.2f} MB")
    print(f"✓ File: {OUTPUT_FILE}")
    if failed:
        print(f"\n⚠️  Failed: {', '.join(failed)}")
    print("=" * 70)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("\n✗ Interrupted")
        sys.exit(1)
    except Exception as e:
        print(f"\n✗ Fatal: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)