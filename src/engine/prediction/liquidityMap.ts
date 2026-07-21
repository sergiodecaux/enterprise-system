import type { OhlcvCandle } from '../../api/mexc'
import type { LiquidityLevel } from './types'
import { detectMarketStructure, findOrderBlocks, findFvg } from '../smc'

function getRoundNumbers(price: number): number[] {
  const step =
    price > 50000 ? 1000 : price > 5000 ? 500 : price > 500 ? 100 : price > 50 ? 10 : price > 5 ? 1 : 0.1

  const base = Math.round(price / step) * step
  return [base - step * 2, base - step, base, base + step, base + step * 2].filter(
    (p) => p > 0
  )
}

export function buildLiquidityMap(
  candles1d: OhlcvCandle[],
  candles4h: OhlcvCandle[],
  candles1h: OhlcvCandle[],
  currentPrice: number
): LiquidityLevel[] {
  if (currentPrice <= 0) return []

  const levels: LiquidityLevel[] = []
  const struct4h = detectMarketStructure(candles4h)
  const struct1h = detectMarketStructure(candles1h)

  struct4h.swingHighs.slice(-4).forEach(([, price], i) => {
    if (Math.abs(price - currentPrice) / currentPrice < 0.0005) return
    levels.push({
      id: `sh4h_${i}`,
      type: 'SWING_HIGH',
      price: price * 1.0002,
      side: 'BUY_SIDE',
      strength: 7,
      distancePercent: ((price - currentPrice) / currentPrice) * 100,
      label: `4H Swing High ${price.toFixed(2)}`,
    })
  })

  struct4h.swingLows.slice(-4).forEach(([, price], i) => {
    if (Math.abs(price - currentPrice) / currentPrice < 0.0005) return
    levels.push({
      id: `sl4h_${i}`,
      type: 'SWING_LOW',
      price: price * 0.9998,
      side: 'SELL_SIDE',
      strength: 7,
      distancePercent: ((currentPrice - price) / currentPrice) * 100,
      label: `4H Swing Low ${price.toFixed(2)}`,
    })
  })

  struct1h.swingHighs.slice(-3).forEach(([, price], i) => {
    levels.push({
      id: `sh1h_${i}`,
      type: 'SWING_HIGH',
      price,
      side: 'BUY_SIDE',
      strength: 5,
      distancePercent: ((price - currentPrice) / currentPrice) * 100,
      label: `1H Swing High ${price.toFixed(2)}`,
    })
  })

  struct1h.swingLows.slice(-3).forEach(([, price], i) => {
    levels.push({
      id: `sl1h_${i}`,
      type: 'SWING_LOW',
      price,
      side: 'SELL_SIDE',
      strength: 5,
      distancePercent: ((currentPrice - price) / currentPrice) * 100,
      label: `1H Swing Low ${price.toFixed(2)}`,
    })
  })

  const ob4h = findOrderBlocks(candles4h, struct4h, 5)
  ob4h.forEach((ob, i) => {
    const midPrice = (ob.top + ob.bottom) / 2
    levels.push({
      id: `ob4h_${i}`,
      type: 'ORDER_BLOCK',
      price: midPrice,
      side: ob.type === 'BULLISH' ? 'SELL_SIDE' : 'BUY_SIDE',
      strength: ob.strength,
      distancePercent: ((midPrice - currentPrice) / currentPrice) * 100,
      label: `4H OB ${ob.type} ${midPrice.toFixed(2)}`,
    })
  })

  const fvg1h = findFvg(candles1h, 5)
  fvg1h.forEach((fvg, i) => {
    const midPrice = (fvg.top + fvg.bottom) / 2
    levels.push({
      id: `fvg1h_${i}`,
      type: 'FVG',
      price: midPrice,
      side: fvg.type === 'BULLISH' ? 'SELL_SIDE' : 'BUY_SIDE',
      strength: 6,
      distancePercent: ((midPrice - currentPrice) / currentPrice) * 100,
      label: `FVG ${fvg.type} ${midPrice.toFixed(2)}`,
    })
  })

  if (candles1d.length >= 2) {
    const prevDay = candles1d[candles1d.length - 2]
    const pdh = prevDay[2]
    const pdl = prevDay[3]
    levels.push(
      {
        id: 'pdh',
        type: 'DAILY_HIGH',
        price: pdh,
        side: 'BUY_SIDE',
        strength: 9,
        distancePercent: ((pdh - currentPrice) / currentPrice) * 100,
        label: `PDH ${pdh.toFixed(2)}`,
      },
      {
        id: 'pdl',
        type: 'DAILY_LOW',
        price: pdl,
        side: 'SELL_SIDE',
        strength: 9,
        distancePercent: ((currentPrice - pdl) / currentPrice) * 100,
        label: `PDL ${pdl.toFixed(2)}`,
      }
    )
  }

  getRoundNumbers(currentPrice).forEach((p, i) => {
    if (Math.abs(p - currentPrice) / currentPrice < 0.001) return
    levels.push({
      id: `round_${i}`,
      type: 'ROUND_NUMBER',
      price: p,
      side: p > currentPrice ? 'BUY_SIDE' : 'SELL_SIDE',
      strength: 4,
      distancePercent: Math.abs((p - currentPrice) / currentPrice) * 100,
      label: `Round $${p >= 10 ? p.toFixed(0) : p.toFixed(2)}`,
    })
  })

  return levels
    .filter((l) => Math.abs(l.distancePercent) > 0.05)
    .sort((a, b) => Math.abs(a.distancePercent) - Math.abs(b.distancePercent))
    .slice(0, 20)
}

export function findNearestLiquidity(
  liquidityMap: LiquidityLevel[],
  direction: 'UP' | 'DOWN',
  minDistancePct = 0.3
): LiquidityLevel | null {
  const candidates = liquidityMap.filter((l) => {
    const isAbove = l.distancePercent > 0
    const matchDir = direction === 'UP' ? isAbove : !isAbove
    return matchDir && Math.abs(l.distancePercent) >= minDistancePct
  })

  const scored = candidates.map((l) => ({
    ...l,
    score: l.strength / Math.max(Math.abs(l.distancePercent), 0.01),
  }))

  scored.sort((a, b) => b.score - a.score)
  return scored[0] ?? null
}
