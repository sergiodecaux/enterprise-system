/**
 * Build bounce / break scenario paths for a liquidity zone.
 * Win% is side-aware (not a flat template).
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
 * Distinct win% per side / kind / distance / book / R:R.
 */
export function scoreZoneWinPct(opts: {
  kind: 'bounce' | 'break'
  side: 'LONG' | 'SHORT'
  zone: FoundTradeZone
  bookImbalance: number | null
  btcRs?: number | null
}): number {
  const { kind, side, zone, bookImbalance, btcRs } = opts
  const dist = Math.abs(zone.distancePct)
  const risk = Math.abs(zone.limitEntry - zone.invalidation)
  const reward = Math.abs(zone.target - zone.limitEntry)
  const rr = risk > 0 ? reward / risk : 1

  let p = kind === 'bounce' ? 46 : 34
  p += zone.strength * 2.4

  // Closer = better for bounce; break likes a bit of room
  if (kind === 'bounce') {
    p += Math.max(0, 12 - dist * 2.5)
  } else {
    p += Math.min(9, dist * 1.2)
  }

  if (zone.source === 'OTE') p += 6
  else if (zone.source === 'SSL' || zone.source === 'BSL') p += 4
  else if (zone.source === 'FIB') p += 2

  // Geometry: LONG bounce wants zone below; SHORT bounce wants zone above
  if (kind === 'bounce') {
    if (side === 'LONG' && zone.distancePct <= 0) p += 5
    if (side === 'SHORT' && zone.distancePct >= 0) p += 5
    if (side === 'LONG' && zone.distancePct > 0.4) p -= 8
    if (side === 'SHORT' && zone.distancePct < -0.4) p -= 8
  } else {
    // break: fade the zone's natural side
    if (side === 'SHORT' && zone.side === 'LONG') p += 3
    if (side === 'LONG' && zone.side === 'SHORT') p += 3
  }

  if (bookImbalance != null) {
    const aligned =
      (side === 'LONG' && bookImbalance >= 14) ||
      (side === 'SHORT' && bookImbalance <= -14)
    const against =
      (side === 'LONG' && bookImbalance <= -20) ||
      (side === 'SHORT' && bookImbalance >= 20)
    if (aligned) p += 10
    else if (against) p -= 14
    else p += Math.max(-4, Math.min(4, (side === 'LONG' ? 1 : -1) * bookImbalance * 0.12))
  }

  if (rr >= 2.2) p += 7
  else if (rr >= 1.5) p += 4
  else if (rr < 1.0) p -= 6

  if (btcRs != null) {
    if (side === 'LONG') {
      if (btcRs >= 3) p += 5
      else if (btcRs <= -4) p -= 7
    } else {
      if (btcRs <= -3) p += 5
      else if (btcRs >= 4) p -= 7
    }
  }

  if (kind === 'break') p -= 5

  // Tiny unique salt so two similar setups aren't pixel-identical
  const salt =
    Math.abs(Math.sin(zone.mid * 997 + (side === 'LONG' ? 3.1 : 7.7) + (kind === 'bounce' ? 1 : 2))) *
    4.5

  return Math.round(Math.min(84, Math.max(26, p + salt)))
}

/**
 * For each found zone: bounce setup + break/stop-run alternative.
 */
export function buildZoneTradeVariants(
  zones: FoundTradeZone[],
  price: number,
  bookImbalance: number | null,
  symbol?: string,
  internalSymbol?: string,
  btcRs?: number | null
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
    const bounceWin = scoreZoneWinPct({
      kind: 'bounce',
      side: bounceSide,
      zone: z,
      bookImbalance,
      btcRs,
    })

    out.push({
      id: `${z.id}_bounce`,
      kind: z.source === 'SSL' ? 'BOUNCE_SSL' : z.source === 'BSL' ? 'BOUNCE_BSL' : 'SURGICAL',
      side: bounceSide,
      title: `↗ Отскок · ${z.label}`,
      probability: bounceWin,
      preconditions: bouncePre,
      entryZone: { top: z.top, bottom: z.bottom },
      limitEntry: z.limitEntry,
      target: z.target,
      invalidation: z.invalidation,
      triggerSummary: `Отскок от ${z.source}: лимит ${z.limitEntry.toPrecision(6)} → TP ${z.target.toPrecision(6)} · ~${bounceWin}%`,
      reasoning: [
        'Основной сценарий: ликвидность собрана → реакция',
        `SL за зоной @ ${z.invalidation.toPrecision(6)}`,
        `Дистанция ${z.distancePct.toFixed(2)}% · сила ${z.strength}/10`,
      ],
      chartPath: buildZoneBouncePath(z, price),
      status: statusFromPre(bouncePre),
      symbol,
      internalSymbol,
      createdAt: Date.now(),
    })

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

    const breakZone: FoundTradeZone = {
      ...z,
      side: breakSide,
      limitEntry: breakEntry,
      target: breakTp,
      invalidation: breakInv,
    }
    const breakWin = scoreZoneWinPct({
      kind: 'break',
      side: breakSide,
      zone: breakZone,
      bookImbalance,
      btcRs,
    })

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
      probability: breakWin,
      preconditions: breakPre,
      entryZone: {
        top: Math.max(breakEntry, z.invalidation),
        bottom: Math.min(breakEntry, z.invalidation),
      },
      limitEntry: breakEntry,
      target: breakTp,
      invalidation: breakInv,
      triggerSummary: `Слом ${z.source}: если заберут стопы → ${breakSide} к ${breakTp.toPrecision(6)} · ~${breakWin}%`,
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
