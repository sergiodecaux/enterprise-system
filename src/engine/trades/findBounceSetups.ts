/**
 * Bounce mode composer: strong SSL/BSL + reaction-board hold targets →
 * chart zones, limit prices, and hold-to arrows.
 * Constants locked before the run, not fitted.
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { LiquidityZone } from '../indicators/types'
import type { LiquidityMap } from '../types'
import type { ConditionalSetup } from '../setups/types'
import type { ZoneReactionBoard } from '../smc/zoneReaction'
import { findTradeZones } from '../zones/findTradeZones'

/** Max bounce zones per side on the clean chart. Locked before run. */
const BOUNCE_MAX_PER_SIDE = 2
/** Prefer zones within this % of price. Locked before run. */
const BOUNCE_MAX_DIST_PCT = 4.5
/** Min zone strength (findTradeZones scale). Locked before run. */
const BOUNCE_MIN_STRENGTH = 7

export type BounceArrow = {
  from: number
  to: number
  side: 'LONG' | 'SHORT'
  label: string
}

export type BounceModeResult = {
  zones: LiquidityZone[]
  setups: ConditionalSetup[]
  limits: { price: number; side: 'LONG' | 'SHORT' }[]
  arrows: BounceArrow[]
}

function fmtPx(p: number): string {
  if (!(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
  if (p >= 0.01) return p.toFixed(5)
  return p.toFixed(6)
}

function emptyResult(): BounceModeResult {
  return { zones: [], setups: [], limits: [], arrows: [] }
}

/**
 * Build bounce-only chart payload from liquidity + reaction board.
 */
export function findBounceSetups(input: {
  candles: OhlcvCandle[]
  symbol: string
  flatSymbol: string
  price: number
  atr: number
  liquidityMap?: LiquidityMap | null
  board?: ZoneReactionBoard | null
  tradeStyle?: 'SCALP' | 'INTRADAY' | 'SWING'
}): BounceModeResult {
  const { candles, price, atr, board } = input
  if (!(price > 0) || candles.length < 20) return emptyResult()

  const tz = findTradeZones({
    candles,
    symbol: input.symbol,
    flatSymbol: input.flatSymbol,
    price,
    tradeStyle: input.tradeStyle ?? 'INTRADAY',
    liquidityMap: input.liquidityMap ?? undefined,
  })

  const bounceZones = tz.zones
    .filter(
      (z) =>
        (z.source === 'SSL' || z.source === 'BSL') &&
        z.strength >= BOUNCE_MIN_STRENGTH &&
        Math.abs(z.distancePct) <= BOUNCE_MAX_DIST_PCT
    )
    .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))

  const longs = bounceZones
    .filter((z) => z.side === 'LONG')
    .slice(0, BOUNCE_MAX_PER_SIDE)
  const shorts = bounceZones
    .filter((z) => z.side === 'SHORT')
    .slice(0, BOUNCE_MAX_PER_SIDE)
  const picked = [...longs, ...shorts]
  if (!picked.length) return emptyResult()

  const holdBySide = new Map<'LONG' | 'SHORT', number>()
  if (board?.reactions?.length) {
    for (const r of board.reactions) {
      if (!r.targetIfHold?.price || !(r.targetIfHold.price > 0)) continue
      const role = r.zone.role
      const side: 'LONG' | 'SHORT' | null =
        role === 'SUPPORT' ? 'LONG' : role === 'RESISTANCE' ? 'SHORT' : null
      if (!side) continue
      const prev = holdBySide.get(side)
      if (prev == null || Math.abs(r.targetIfHold.price - price) < Math.abs(prev - price)) {
        holdBySide.set(side, r.targetIfHold.price)
      }
    }
  }

  const zones: LiquidityZone[] = []
  const limits: BounceModeResult['limits'] = []
  const arrows: BounceArrow[] = []
  const setups: ConditionalSetup[] = []

  for (let i = 0; i < picked.length; i++) {
    const z = picked[i]!
    const primary = i === 0
    const chartZone: LiquidityZone = {
      ...z.chartZone,
      storyRole: primary ? 'PRIMARY' : 'SECONDARY',
      strength: z.strength,
      strengthTier: z.strength >= 9 ? 'STRONG' : 'MEDIUM',
      label:
        z.side === 'LONG'
          ? `Отскок LONG · лимит ${fmtPx(z.limitEntry)}`
          : `Отскок SHORT · лимит ${fmtPx(z.limitEntry)}`,
      contextHint:
        z.side === 'LONG'
          ? `лимитка LONG · держать ↑`
          : `лимитка SHORT · держать ↓`,
      invalidation: z.invalidation,
      target: z.target,
    }
    zones.push(chartZone)
    limits.push({ price: z.limitEntry, side: z.side })

    const holdTarget =
      holdBySide.get(z.side) ??
      z.target ??
      (z.side === 'LONG'
        ? z.limitEntry + Math.max(atr * 1.8, price * 0.008)
        : z.limitEntry - Math.max(atr * 1.8, price * 0.008))

    const to =
      z.side === 'LONG'
        ? Math.max(holdTarget, z.limitEntry * 1.004)
        : Math.min(holdTarget, z.limitEntry * 0.996)

    arrows.push({
      from: z.limitEntry,
      to,
      side: z.side,
      label: `держать до ${fmtPx(to)}`,
    })

    const setup = tz.setups.find(
      (s) =>
        s.side === z.side &&
        (s.kind === 'BOUNCE_SSL' || s.kind === 'BOUNCE_BSL') &&
        Math.abs(s.limitEntry - z.limitEntry) / Math.max(z.limitEntry, 1e-12) <
          0.003
    )
    if (setup) {
      setups.push({
        ...setup,
        target: to,
        title:
          z.side === 'LONG'
            ? `Отскок LONG · ${fmtPx(z.limitEntry)}`
            : `Отскок SHORT · ${fmtPx(z.limitEntry)}`,
      })
    } else {
      setups.push({
        id: `bounce_${z.id}`,
        kind: z.side === 'LONG' ? 'BOUNCE_SSL' : 'BOUNCE_BSL',
        side: z.side,
        title:
          z.side === 'LONG'
            ? `Отскок LONG · ${fmtPx(z.limitEntry)}`
            : `Отскок SHORT · ${fmtPx(z.limitEntry)}`,
        probability: Math.min(78, 48 + z.strength * 3),
        preconditions: [],
        entryZone: { top: z.top, bottom: z.bottom },
        limitEntry: z.limitEntry,
        target: to,
        invalidation: z.invalidation,
        triggerSummary: `Лимитка в зоне отскока · цель ${fmtPx(to)}`,
        reasoning: [z.label, `держать до ${fmtPx(to)}`],
        status: Math.abs(z.distancePct) < 0.35 ? 'READY' : 'ARMED',
        createdAt: Date.now(),
      })
    }
  }

  return { zones, setups, limits, arrows }
}
