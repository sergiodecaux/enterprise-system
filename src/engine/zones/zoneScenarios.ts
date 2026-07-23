/**
 * Build bounce / break scenario paths for a liquidity zone.
 */

import type { PathPoint } from '../prediction/types'
import type { FoundTradeZone } from './findTradeZones'
import type { ConditionalSetup, SetupPrecondition } from '../setups/types'

function path(
  points: { t: number; p: number; label?: string; key?: boolean }[]
): PathPoint[] {
  return points.map((x) => ({
    timeOffsetSeconds: x.t,
    price: x.p,
    label: x.label,
    isKeyLevel: x.key,
  }))
}

/** Bounce: touch zone → reclaim → target opposite liquidity */
export function buildZoneBouncePath(z: FoundTradeZone, price: number): PathPoint[] {
  const t0 = 0
  const touch = Math.max(900, Math.abs(z.distancePct) * 120)
  if (z.side === 'LONG') {
    return path([
      { t: t0, p: price, label: 'сейчас' },
      { t: touch, p: z.mid, label: 'касание SSL', key: true },
      { t: touch + 1800, p: z.limitEntry, label: 'лимит' },
      { t: touch + 7200, p: z.target, label: 'TP', key: true },
    ])
  }
  return path([
    { t: t0, p: price, label: 'сейчас' },
    { t: touch, p: z.mid, label: 'касание BSL', key: true },
    { t: touch + 1800, p: z.limitEntry, label: 'лимит' },
    { t: touch + 7200, p: z.target, label: 'TP', key: true },
  ])
}

/** Break: sweep through zone → continuation to next liquidity */
export function buildZoneBreakPath(z: FoundTradeZone, price: number): PathPoint[] {
  const touch = Math.max(900, Math.abs(z.distancePct) * 100)
  if (z.side === 'LONG') {
    // SSL breaks → short continuation below
    const breakPx = z.invalidation
    const cont = z.mid * 0.985
    return path([
      { t: 0, p: price, label: 'сейчас' },
      { t: touch, p: z.mid, label: 'свип SSL', key: true },
      { t: touch + 1200, p: breakPx, label: 'слом' },
      { t: touch + 5400, p: cont, label: 'продолжение', key: true },
    ])
  }
  const breakPx = z.invalidation
  const cont = z.mid * 1.015
  return path([
    { t: 0, p: price, label: 'сейчас' },
    { t: touch, p: z.mid, label: 'свип BSL', key: true },
    { t: touch + 1200, p: breakPx, label: 'слом' },
    { t: touch + 5400, p: cont, label: 'продолжение', key: true },
  ])
}

function statusFromPre(pre: SetupPrecondition[]): ConditionalSetup['status'] {
  if (pre.some((p) => p.status === 'FAILED')) return 'INVALIDATED'
  if (pre.length && pre.every((p) => p.status === 'MET')) return 'READY'
  if (pre.some((p) => p.status === 'MET')) return 'ARMED'
  return 'HYPOTHESIS'
}

/**
 * For each found zone: bounce setup + break/stop-run alternative.
 */
export function buildZoneTradeVariants(
  zones: FoundTradeZone[],
  price: number,
  bookImbalance: number | null,
  symbol?: string,
  internalSymbol?: string
): ConditionalSetup[] {
  const out: ConditionalSetup[] = []

  for (const z of zones) {
    const inZone =
      price >= z.bottom * 0.998 && price <= z.top * 1.002
    const bookForBounce =
      bookImbalance == null
        ? 'PENDING'
        : (z.side === 'LONG' && bookImbalance >= 12) ||
            (z.side === 'SHORT' && bookImbalance <= -12)
          ? 'MET'
          : (z.side === 'LONG' && bookImbalance <= -20) ||
              (z.side === 'SHORT' && bookImbalance >= 20)
            ? 'FAILED'
            : 'PENDING'

    const bouncePre: SetupPrecondition[] = [
      {
        id: 'touch',
        label: `Касание зоны ${z.label}`,
        status: inZone ? 'MET' : 'PENDING',
      },
      {
        id: 'book',
        label: 'Стакан за отскок',
        status: bookForBounce,
      },
      {
        id: 'confirm',
        label: 'Реакция / reclaim',
        status: 'PENDING',
      },
    ]

    const bounceSide = z.side
    out.push({
      id: `${z.id}_bounce`,
      kind: z.source === 'SSL' ? 'BOUNCE_SSL' : z.source === 'BSL' ? 'BOUNCE_BSL' : 'SURGICAL',
      side: bounceSide,
      title: `↗ Отскок · ${z.label}`,
      probability: Math.min(
        76,
        40 + z.strength * 3 + (inZone ? 8 : 0) + (bookForBounce === 'MET' ? 10 : 0)
      ),
      preconditions: bouncePre,
      entryZone: { top: z.top, bottom: z.bottom },
      limitEntry: z.limitEntry,
      target: z.target,
      invalidation: z.invalidation,
      triggerSummary: `Отскок от ${z.source}: лимит ${z.limitEntry.toPrecision(6)} → TP ${z.target.toPrecision(6)}`,
      reasoning: [
        'Основной сценарий: ликвидность собрана → реакция',
        `SL за зоной @ ${z.invalidation.toPrecision(6)}`,
      ],
      chartPath: buildZoneBouncePath(z, price),
      status: statusFromPre(bouncePre),
      symbol,
      internalSymbol,
      createdAt: Date.now(),
    })

    // Break / stop-run — opposite continuation after sweep
    const breakSide: 'LONG' | 'SHORT' = z.side === 'LONG' ? 'SHORT' : 'LONG'
    const breakEntry =
      z.side === 'LONG' ? z.invalidation * 0.999 : z.invalidation * 1.001
    const breakTp =
      z.side === 'LONG' ? z.mid * 0.982 : z.mid * 1.018
    const breakInv = z.mid
    const bookForBreak =
      bookImbalance == null
        ? 'PENDING'
        : (breakSide === 'LONG' && bookImbalance >= 12) ||
            (breakSide === 'SHORT' && bookImbalance <= -12)
          ? 'MET'
          : 'PENDING'

    const breakPre: SetupPrecondition[] = [
      {
        id: 'sweep',
        label: `Свип через ${z.label}`,
        status: 'PENDING',
      },
      {
        id: 'break',
        label: 'Закрытие за зоной / нет reclaim',
        status: 'PENDING',
      },
      {
        id: 'book',
        label: 'Стакан за продолжение',
        status: bookForBreak,
      },
    ]

    out.push({
      id: `${z.id}_break`,
      kind: 'STOP_THEN_REVERSE',
      side: breakSide,
      title: `↯ Слом · ${z.label}`,
      probability: Math.min(68, 32 + z.strength * 2 + (bookForBreak === 'MET' ? 8 : 0)),
      preconditions: breakPre,
      entryZone: {
        top: Math.max(breakEntry, z.invalidation),
        bottom: Math.min(breakEntry, z.invalidation),
      },
      limitEntry: breakEntry,
      target: breakTp,
      invalidation: breakInv,
      triggerSummary: `Слом ${z.source}: если заберут стопы → ${breakSide} к ${breakTp.toPrecision(6)}`,
      reasoning: [
        'Альтернатива: ложный отскок / stop-run через зону',
        `Inv (возврат в зону) @ ${breakInv.toPrecision(6)}`,
      ],
      chartPath: buildZoneBreakPath(z, price),
      status: statusFromPre(breakPre),
      symbol,
      internalSymbol,
      createdAt: Date.now(),
    })
  }

  return out
}
