import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chooseConfirmedDirection,
  detectMemeDirectionalSignal,
  inspectMemeCandleDirections,
  movementPhase,
  patternTier,
  tailBlocked,
  type MemeDirectionalSignal,
} from './memeDirectionalSignal'
import type { MemeBookForecast } from './memeBookForecast'
import type {
  CrowdBookMetrics,
  OrderBookEvent,
  OrderBookSnapshot,
} from './orderBookReader'
import type { Candle } from './peakFuelFail'

function candle(
  index: number,
  open: number,
  close: number,
  volume: number,
  highPad = 0.002,
  lowPad = 0.002
): Candle {
  return [
    1_700_000_000_000 + index * 60_000,
    open,
    Math.max(open, close) + highPad,
    Math.min(open, close) - lowPad,
    close,
    volume,
  ]
}

test('classifies quiet price with rising volume as accumulation', () => {
  const candles: Candle[] = []
  for (let index = 0; index < 36; index++) {
    const recent = index >= 31
    candles.push(
      candle(
        index,
        1 + (index % 2) * 0.0003,
        1 + ((index + 1) % 2) * 0.0003,
        recent ? 160 : 100,
        0.01,
        0.01
      )
    )
  }
  assert.equal(movementPhase(candles), 'ACCUMULATION')
})

test('classifies a high-location move with fading volume as extension', () => {
  const candles: Candle[] = []
  for (let index = 0; index < 46; index++) {
    const open = 1 + index * 0.004
    candles.push(candle(index, open, open + 0.003, index >= 41 ? 45 : 100))
  }
  assert.equal(movementPhase(candles), 'EXTENSION_UP')
})

test('classifies a balanced bounded market as range', () => {
  const candles: Candle[] = []
  for (let index = 0; index < 46; index++) {
    const open =
      index >= 40 ? 1.008 : index % 2 === 0 ? 1.004 : 1.012
    const close =
      index >= 40 ? 1.008 : index % 2 === 0 ? 1.012 : 1.004
    candles.push(candle(index, open, close, 100, 0.004, 0.004))
  }
  assert.equal(movementPhase(candles), 'RANGE')
  const directions = inspectMemeCandleDirections(candles, 1)
  assert.ok(
    directions.some(
      (candidate) =>
        candidate.side === 'LONG' &&
        candidate.patterns.includes('range_book_forecast_long')
    )
  )
  assert.ok(
    directions.some(
      (candidate) =>
        candidate.side === 'SHORT' &&
        candidate.patterns.includes('range_book_forecast_short')
    )
  )
})

test('nominates a short after rejection from the top of a range', () => {
  const candles: Candle[] = []
  for (let index = 0; index < 42; index++) {
    const open = index % 2 === 0 ? 1.003 : 1.014
    const close = index % 2 === 0 ? 1.014 : 1.003
    candles.push(candle(index, open, close, 100, 0.003, 0.003))
  }
  candles.push(candle(42, 1.012, 1.017, 100, 0.003, 0.003))
  candles.push([
    1_700_000_000_000 + 43 * 60_000,
    1.018,
    1.025,
    1.015,
    1.016,
    100,
  ])
  const short = inspectMemeCandleDirections(candles, 0).find(
    (candidate) => candidate.side === 'SHORT'
  )
  assert.ok(short)
  assert.ok(short.patterns.includes('range_high_reject'))
})

test('blocks a long after an oversized two-hour tail', () => {
  const candles: Candle[] = []
  for (let index = 0; index < 121; index++) {
    const open = 1 + index * 0.0017
    candles.push(candle(index, open, open + 0.001, 100))
  }
  assert.equal(tailBlocked(candles, 'LONG'), true)
})

test('assigns candlestick pattern tiers', () => {
  assert.equal(patternTier(['failed_breakdown']), 'S')
  assert.equal(patternTier(['higher_low']), 'A')
  assert.equal(patternTier(['volume_expansion']), 'B')
})

function rangeBox(count = 46): Candle[] {
  const candles: Candle[] = []
  for (let index = 0; index < count; index++) {
    const quiet = index >= count - 6
    const open = quiet ? 1.008 : index % 2 === 0 ? 1.004 : 1.012
    const close = quiet ? 1.008 : index % 2 === 0 ? 1.012 : 1.004
    candles.push(candle(index, open, close, 100, 0.004, 0.004))
  }
  return candles
}

test('classifies a mild 0.55% drift with flat volume as range', () => {
  const candles: Candle[] = []
  for (let index = 0; index < 46; index++) {
    const drifting = index >= 40
    const open = drifting ? 1.004 + (index - 40) * 0.0011 : index % 2 === 0 ? 1.004 : 1.016
    const close = drifting ? open + 0.0008 : index % 2 === 0 ? 1.016 : 1.004
    candles.push(candle(index, open, close, 100, 0.004, 0.004))
  }
  assert.equal(movementPhase(candles), 'RANGE')
})

test('nominates a long at range low without a hammer', () => {
  const candles = rangeBox(42)
  candles.push(candle(42, 1.005, 1.003, 100, 0.001, 0.001))
  candles.push(candle(43, 1.002, 1.005, 100, 0.001, 0.001))
  const long = inspectMemeCandleDirections(candles, 1).find(
    (candidate) => candidate.side === 'LONG'
  )
  assert.ok(long)
  assert.ok(long.patterns.includes('range_low_reclaim'))
})

function longBook() {
  const snapshot: OrderBookSnapshot = {
    symbol: 'BOX_USDT',
    at: 1,
    mid: 1,
    asks: [[1.01, 1]],
    bids: [[0.99, 2]],
    obi: 12,
  }
  const crowd: CrowdBookMetrics = {
    crowdAskLevels: 0,
    crowdAskUsd: 0,
    realAskUsd: 800,
    crowdAskShare: 0,
    shortBaitAsks: false,
    bidSupportUsd: 1800,
    largeAskWall: false,
    largeBidWall: true,
    spoofAskWall: false,
    spoofBidWall: false,
    maxBidUsd: 800,
    maxAskUsd: 400,
    bidAskUsdRatio: 1.4,
    stackedBidWalls: 1,
    stackedAskWalls: 0,
    nearBidUsd: 1400,
    nearAskUsd: 1000,
  }
  const event: OrderBookEvent = {
    ready: true,
    side: 'LONG',
    confidence: 80,
    kind: 'BID_WALL_SUPPORT',
    entryMode: 'LIMIT_CHASE',
    wallPrice: 0.99,
    wallDropPct: 0,
    wallMultiple: 1,
    flowSharePct: 60,
    obi: 12,
    obiChange: 4,
    priceMoveBps: 5,
    spreadBps: 8,
    relocated: false,
    wallPersisted: true,
    trap: false,
    slPrice: null,
    tpPrice: null,
    tp1Price: null,
    notes: [],
  }
  const forecast: MemeBookForecast = {
    score: 70,
    realBook: true,
    strongTape: true,
    toxic: false,
    obiAligned: true,
    bias: 'NEXT_UP',
    reasons: ['test'],
  }
  return { snapshot, crowd, event, forecast }
}

test('RANGE low reclaim confirms with sync 8 and aligned forecast', () => {
  const candles = rangeBox()
  const book = longBook()
  const signal = detectMemeDirectionalSignal({
    candidate: {
      side: 'LONG',
      score: 60,
      htfAligned: true,
      patterns: ['range_low_reclaim'],
    },
    price: 1,
    snapshot: book.snapshot,
    crowd: book.crowd,
    forecast: book.forecast,
    event: book.event,
    candles,
    btcState: 'NEUTRAL',
    tapeBuyPct: 50,
    tapeMoveBps: 0,
  })
  assert.ok(signal)
  assert.equal(signal.side, 'LONG')
  assert.ok(signal.probability >= 68)
})

test('does not veto a long just because a $1.8k ask level exists', () => {
  const candles = rangeBox()
  const book = longBook()
  const signal = detectMemeDirectionalSignal({
    candidate: {
      side: 'LONG',
      score: 60,
      htfAligned: true,
      patterns: ['range_low_reclaim'],
    },
    price: 1,
    snapshot: { ...book.snapshot, obi: 8 },
    crowd: {
      ...book.crowd,
      largeAskWall: true,
      maxAskUsd: 1800,
      stackedAskWalls: 2,
      nearAskUsd: 2200,
      nearBidUsd: 2800,
      bidAskUsdRatio: 1.27,
    },
    forecast: book.forecast,
    event: book.event,
    candles,
    btcState: 'NEUTRAL',
    tapeBuyPct: 50,
    tapeMoveBps: 0,
  })
  assert.ok(signal)
})

test('RANGE mid-range forecast still needs sync 15', () => {
  const candles = rangeBox()
  const book = longBook()
  const signal = detectMemeDirectionalSignal({
    candidate: {
      side: 'LONG',
      score: 54,
      htfAligned: true,
      patterns: ['range_book_forecast_long'],
    },
    price: 1,
    snapshot: book.snapshot,
    crowd: book.crowd,
    forecast: book.forecast,
    event: book.event,
    candles,
    btcState: 'NEUTRAL',
    tapeBuyPct: 50,
    tapeMoveBps: 0,
  })
  assert.equal(signal, null)
})

function stubSignal(side: 'LONG' | 'SHORT', probability: number): MemeDirectionalSignal {
  return {
    side,
    setup: side === 'LONG' ? 'MEME_BOOK_LONG' : 'PEAK_FUEL_FAIL',
    probability,
    limitPrice: 1,
    sl: 0.99,
    tp1: 1.01,
    tp: 1.015,
    target3: 1.015,
    notes: [],
    journalReasons: [],
  }
}

test('drops a RANGE flip-flop when LONG and SHORT scores are tied', () => {
  const tied = chooseConfirmedDirection(stubSignal('LONG', 72), stubSignal('SHORT', 73))
  assert.equal(tied.pick, null)
  assert.equal(tied.reason, 'range_direction_ambiguous')
  const winner = chooseConfirmedDirection(stubSignal('LONG', 80), stubSignal('SHORT', 73))
  assert.equal(winner.pick?.side, 'LONG')
})
