import assert from 'node:assert/strict'
import test from 'node:test'

import { buildHotMemeWatchlist } from './hotMemeWatchlist'

test('reserves ten hotlist slots for liquid sideways symbols', () => {
  const movers = Array.from({ length: 25 }, (_, index) => ({
    symbol: `MOVE${index}_USDT`,
    lastPrice: 1,
    riseFallRate: (20 + index) / 100,
    amount24: 2_000_000 + index * 10_000,
  }))
  const sideways = Array.from({ length: 12 }, (_, index) => ({
    symbol: `RANGE${index}_USDT`,
    lastPrice: 1,
    riseFallRate: (1 + index * 0.25) / 100,
    amount24: 5_000_000 + index * 100_000,
  }))
  const tickers = [...movers, ...sideways]
  const list = buildHotMemeWatchlist(tickers, {
    blueChips: new Set(),
    tradable: new Set(tickers.map((ticker) => ticker.symbol)),
    now: Date.UTC(2026, 7, 22, 16),
  })

  assert.equal(list.entries.length, 30)
  assert.ok(
    list.entries.filter(
      (entry) =>
        Math.abs(entry.chg24hPct) < 6 && entry.quoteVolUsd >= 250_000
    ).length >= 10
  )
})

test('sticky refresh keeps liquid sideways names below 4% 24h', () => {
  const now = Date.UTC(2026, 7, 22, 16)
  const movers = Array.from({ length: 20 }, (_, index) => ({
    symbol: `MOVE${index}_USDT`,
    lastPrice: 1,
    riseFallRate: (20 + index) / 100,
    amount24: 2_000_000,
  }))
  const sideways = Array.from({ length: 10 }, (_, index) => ({
    symbol: `RANGE${index}_USDT`,
    lastPrice: 1,
    riseFallRate: (1 + index * 0.2) / 100,
    amount24: 5_000_000,
  }))
  const tradable = new Set([...movers, ...sideways].map((ticker) => ticker.symbol))
  const previous = buildHotMemeWatchlist([...movers, ...sideways], {
    blueChips: new Set(),
    tradable,
    now,
  })
  const hotterMovers = Array.from({ length: 20 }, (_, index) => ({
    symbol: `NEW${index}_USDT`,
    lastPrice: 1,
    riseFallRate: (40 + index) / 100,
    amount24: 8_000_000,
  }))
  const next = buildHotMemeWatchlist(
    [...movers, ...sideways, ...hotterMovers],
    {
      blueChips: new Set(),
      tradable: new Set([...tradable, ...hotterMovers.map((ticker) => ticker.symbol)]),
      now: now + 2 * 60_000,
      previous,
    }
  )
  const keptSideways = next.entries.filter((entry) =>
    entry.symbol.startsWith('RANGE')
  )
    assert.ok(
      keptSideways.length >= 10,
      `expected sticky RANGE names, got ${keptSideways.map((e) => e.symbol).join(',')}`
    )
})

test('keeps classic memes like PEPE and drops L1/DeFi', () => {
  const tickers = [
    {
      symbol: 'PEPE_USDT',
      lastPrice: 1,
      riseFallRate: 0.02,
      amount24: 500_000_000,
    },
    {
      symbol: 'LDO_USDT',
      lastPrice: 1,
      riseFallRate: 0.02,
      amount24: 9_000_000,
    },
    {
      symbol: 'MEMEBOX_USDT',
      lastPrice: 1,
      riseFallRate: 0.02,
      amount24: 1_200_000,
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      symbol: `MOVE${index}_USDT`,
      lastPrice: 1,
      riseFallRate: (18 + index) / 100,
      amount24: 1_500_000,
    })),
  ]
  const list = buildHotMemeWatchlist(tickers, {
    blueChips: new Set(['LDO_USDT']),
    tradable: new Set(tickers.map((ticker) => ticker.symbol)),
    now: Date.UTC(2026, 7, 22, 18),
  })
  assert.ok(list.entries.some((entry) => entry.symbol === 'PEPE_USDT'))
  assert.ok(!list.entries.some((entry) => entry.symbol === 'LDO_USDT'))
  assert.ok(list.entries.some((entry) => entry.symbol === 'MEMEBOX_USDT'))
})
