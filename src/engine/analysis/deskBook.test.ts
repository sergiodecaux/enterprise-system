import assert from 'node:assert/strict'
import { classifyAsset } from '../composite/assetClassifier'
import { readSituation, type DeskTf } from './deskBook'
import type { OhlcvCandle } from '../../api/mexc'

function tf(
  trend: DeskTf['trend'],
  location: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' = 'DISCOUNT',
  nextSsl: number | null = 100,
  nextBsl: number | null = 120
): DeskTf {
  return {
    trend,
    inPremium: location === 'PREMIUM',
    inDiscount: location === 'DISCOUNT',
    nextSsl,
    nextBsl,
  }
}

function bar(
  open: number,
  high: number,
  low: number,
  close: number,
  i = 0
): OhlcvCandle {
  return [1_700_000_000_000 + i * 900_000, open, high, low, close, 10]
}

const up = [
  bar(100, 101, 99, 100.4, 0),
  bar(100.4, 101, 100, 100.6, 1),
  bar(100.6, 101.2, 100.3, 100.8, 2),
  bar(100, 110, 99, 109, 3),
]

const bullWeek = tf('BULLISH', 'DISCOUNT')
const bullDay = tf('BULLISH', 'DISCOUNT')
const bull4h = tf('BULLISH', 'DISCOUNT', 98, 130)

const gold = readSituation({
  symbol: 'XAU_USDT',
  w1: bullWeek,
  d1: bullDay,
  h4: bull4h,
  h1: bull4h,
  candles15m: up,
})
assert.equal(gold.book, 'COMMODITY')
assert.equal(gold.commodity, 'GOLD')
assert.equal(gold.tradable, true)
assert.equal(gold.trigger, 'ACCEPT')
assert.equal(gold.htfSide, 'LONG')

const wickOnly = readSituation({
  symbol: 'XAU_USDT',
  w1: bullWeek,
  d1: bullDay,
  h4: bull4h,
  h1: bull4h,
  candles15m: [
    bar(100, 101, 99, 100.2, 0),
    bar(100.2, 101, 99.5, 100.4, 1),
    bar(100.4, 101, 100, 100.5, 2),
    bar(100.5, 108, 100.2, 100.7, 3),
  ],
})
assert.equal(wickOnly.tradable, false)
assert.match(wickOnly.line, /Фитиль/)

const fight = readSituation({
  symbol: 'XAU_USDT',
  w1: tf('BULLISH'),
  d1: tf('BEARISH'),
  h4: bull4h,
  h1: bull4h,
  candles15m: up,
})
assert.equal(fight.htfSide, null)
assert.equal(fight.tradable, false)

const counter = readSituation({
  symbol: 'SILVER_USDT',
  w1: bullWeek,
  d1: bullDay,
  h4: tf('BEARISH', 'DISCOUNT'),
  h1: bull4h,
  candles15m: up,
})
assert.equal(counter.tradable, false)
assert.equal(counter.commodity, 'SILVER')
assert.match(counter.line, /4ч против/)

const chased = readSituation({
  symbol: 'BTC_USDT',
  isBtc: true,
  w1: bullWeek,
  d1: bullDay,
  h4: tf('BULLISH', 'PREMIUM', 90, 140),
  h1: tf('BULLISH', 'PREMIUM', 90, 140),
  candles15m: up,
})
assert.equal(chased.book, 'BTC')
assert.equal(chased.tradable, false)
assert.match(chased.line, /премиум/)

const hunt = readSituation({
  symbol: 'BTC_USDT',
  isBtc: true,
  w1: bullWeek,
  d1: bullDay,
  h4: tf('BULLISH', 'DISCOUNT', 100, 140),
  h1: tf('BULLISH', 'DISCOUNT', 100, 140),
  candles15m: [
    bar(102, 103, 101, 102, 0),
    bar(102, 103, 99, 102.4, 1),
    bar(102.2, 103, 101.5, 102.5, 2),
    bar(101, 108, 100.5, 107, 3),
  ],
})
assert.equal(hunt.trigger, 'SWEEP_RETURN')
assert.equal(hunt.tradable, true)

const altOff = readSituation({
  symbol: 'ARB_USDT',
  w1: bullWeek,
  d1: bullDay,
  h4: bull4h,
  h1: bull4h,
  candles15m: up,
  altRegime: 'ALT_OFF',
})
assert.equal(altOff.book, 'ALT')
assert.equal(altOff.tradable, false)
assert.match(altOff.line, /фон альтов/)

const midAlt = readSituation({
  symbol: 'ARB_USDT',
  w1: bullWeek,
  d1: bullDay,
  h4: tf('BULLISH', 'EQUILIBRIUM'),
  h1: tf('BULLISH', 'EQUILIBRIUM'),
  candles15m: up,
  altRegime: 'ALT_ON',
  altBias: 'LONG',
})
assert.equal(midAlt.tradable, false)
assert.match(midAlt.line, /Середина/)

assert.equal(classifyAsset('XAU/USDT:USDT', 0.8), 'COMMODITY')
assert.equal(classifyAsset('SILVER_USDT', 2), 'COMMODITY')
assert.equal(classifyAsset('USOIL_USDT', 1.2), 'COMMODITY')
assert.equal(classifyAsset('BTC/USDT:USDT', 1), 'BLUE_CHIP')
assert.equal(classifyAsset('ARB/USDT:USDT', 3), 'ALT')

console.log('desk book ok')
