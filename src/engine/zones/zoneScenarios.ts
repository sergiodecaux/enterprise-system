/**
 * Build bounce / break scenario paths for a liquidity zone.
 * Win% is side-aware (not a flat template).
 */

import type { PathPoint } from '../prediction/types'
import type { FoundTradeZone } from './findTradeZones'
import type {
  ConditionalSetup,
  SetupPrecondition,
  SetupTradeStyle,
} from '../setups/types'
import { HORIZON_PROFILES } from './horizonProfiles'

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

function scalePath(points: PathPoint[], scale: number): PathPoint[] {
  return points.map((p) => ({
    ...p,
    timeOffsetSeconds: Math.round(p.timeOffsetSeconds * scale),
  }))
}

/** Retarget TP by style: farther flight for INTRA/SWING toward structural magnet */
function styleTarget(
  z: FoundTradeZone,
  style: SetupTradeStyle
): { target: number; invalidation: number } {
  const prof = HORIZON_PROFILES[style]
  const dir = z.side === 'LONG' ? 1 : -1
  const risk = Math.abs(z.limitEntry - z.invalidation) * prof.riskPad
  const inv =
    z.side === 'LONG'
      ? z.limitEntry - risk
      : z.limitEntry + risk
  // Blend structural zone target with R-multiple flight
  const struct = z.target
  const byR = z.limitEntry + dir * risk * prof.rMultiples[1]
  const aligned =
    (z.side === 'LONG' && struct > z.limitEntry) ||
    (z.side === 'SHORT' && struct < z.limitEntry)
  let target = aligned
    ? z.limitEntry + dir * Math.max(Math.abs(struct - z.limitEntry), Math.abs(byR - z.limitEntry)) * (0.55 + 0.45 * Math.min(prof.tpMult, 2))
    : byR
  // Prefer farther of structural vs R for swing
  if (style === 'SWING' && aligned) {
    target =
      z.side === 'LONG'
        ? Math.max(struct, byR)
        : Math.min(struct, byR)
  }
  return { target, invalidation: inv }
}

/** Bounce: touch zone → reclaim → target opposite liquidity */
export function buildZoneBouncePath(
  z: FoundTradeZone,
  price: number,
  pathScale = 1
): PathPoint[] {
  const t0 = 0
  const touch = Math.max(900, Math.abs(z.distancePct) * 120)
  const base =
    z.side === 'LONG'
      ? path([
          { t: t0, p: price, label: 'сейчас' },
          { t: touch, p: z.mid, label: 'касание SSL', key: true },
          { t: touch + 1800, p: z.limitEntry, label: 'лимит' },
          { t: touch + 7200, p: z.target, label: 'TP', key: true },
        ])
      : path([
          { t: t0, p: price, label: 'сейчас' },
          { t: touch, p: z.mid, label: 'касание BSL', key: true },
          { t: touch + 1800, p: z.limitEntry, label: 'лимит' },
          { t: touch + 7200, p: z.target, label: 'TP', key: true },
        ])
  return scalePath(base, pathScale)
}

/** Break: sweep through zone → continuation to next liquidity */
export function buildZoneBreakPath(
  z: FoundTradeZone,
  price: number,
  pathScale = 1
): PathPoint[] {
  const touch = Math.max(900, Math.abs(z.distancePct) * 100)
  const base =
    z.side === 'LONG'
      ? path([
          { t: 0, p: price, label: 'сейчас' },
          { t: touch, p: z.mid, label: 'свип SSL', key: true },
          { t: touch + 1200, p: z.invalidation, label: 'слом' },
          { t: touch + 5400, p: z.mid * 0.985, label: 'продолжение', key: true },
        ])
      : path([
          { t: 0, p: price, label: 'сейчас' },
          { t: touch, p: z.mid, label: 'свип BSL', key: true },
          { t: touch + 1200, p: z.invalidation, label: 'слом' },
          { t: touch + 5400, p: z.mid * 1.015, label: 'продолжение', key: true },
        ])
  return scalePath(base, pathScale)
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
 * `tradeStyle` shapes TP distance, path duration, and #SCALP/#INTRA/#SWING tag.
 */
export function buildZoneTradeVariants(
  zones: FoundTradeZone[],
  price: number,
  bookImbalance: number | null,
  symbol?: string,
  internalSymbol?: string,
  btcRs?: number | null,
  tradeStyle: SetupTradeStyle = 'INTRADAY'
): ConditionalSetup[] {
  const out: ConditionalSetup[] = []
  const prof = HORIZON_PROFILES[tradeStyle]

  for (const z of zones) {
    const dist = Math.abs(z.distancePct)
    if (dist > prof.maxDistPct) continue
    if (dist < prof.minDistPct && tradeStyle !== 'SCALP') continue

    const styled = styleTarget(z, tradeStyle)
    const zStyled: FoundTradeZone = {
      ...z,
      target: styled.target,
      invalidation: styled.invalidation,
    }

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
        label:
          tradeStyle === 'SWING'
            ? 'HTF закреп / дневная реакция'
            : tradeStyle === 'INTRADAY'
              ? 'Реакция 15m–1h'
              : 'Реакция / reclaim',
        status: 'PENDING',
      },
    ]

    const bounceSide = z.side
    const bounceWin = Math.round(
      Math.min(
        86,
        Math.max(
          28,
          scoreZoneWinPct({
            kind: 'bounce',
            side: bounceSide,
            zone: zStyled,
            bookImbalance,
            btcRs,
          }) + prof.winAdj
        )
      )
    )

    out.push({
      id: `${z.id}_bounce_${tradeStyle.toLowerCase()}`,
      kind: z.source === 'SSL' ? 'BOUNCE_SSL' : z.source === 'BSL' ? 'BOUNCE_BSL' : 'SURGICAL',
      side: bounceSide,
      title: `${prof.tag} ↗ ${prof.label} · ${z.label}`,
      probability: bounceWin,
      preconditions: bouncePre,
      entryZone: { top: z.top, bottom: z.bottom },
      limitEntry: z.limitEntry,
      target: styled.target,
      invalidation: styled.invalidation,
      triggerSummary: `${prof.tag} отскок ${z.source}: вход ${z.limitEntry.toPrecision(6)} → TP ${styled.target.toPrecision(6)} · ~${bounceWin}%`,
      reasoning: [
        `${prof.label}: ликвидность → реакция → полёт к ${styled.target.toPrecision(6)}`,
        `SL ${styled.invalidation.toPrecision(6)} · R≈${prof.rMultiples.join('/')}`,
        `Дистанция ${z.distancePct.toFixed(2)}% · сила ${z.strength}/10`,
      ],
      chartPath: buildZoneBouncePath(zStyled, price, prof.pathScale),
      status: statusFromPre(bouncePre),
      symbol,
      internalSymbol,
      createdAt: Date.now(),
      tradeStyle,
    })

    // Break alt — keep for SCALP/INTRA; for SWING only if near zone
    if (tradeStyle === 'SWING' && dist > 3.5) continue

    const breakSide: 'LONG' | 'SHORT' = z.side === 'LONG' ? 'SHORT' : 'LONG'
    const breakEntry =
      z.side === 'LONG' ? z.invalidation * 0.999 : z.invalidation * 1.001
    const breakRisk = Math.abs(breakEntry - z.mid) * prof.riskPad
    const breakTp =
      breakSide === 'LONG'
        ? breakEntry + breakRisk * prof.rMultiples[1]
        : breakEntry - breakRisk * prof.rMultiples[1]
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
    const breakWin = Math.round(
      Math.min(
        80,
        Math.max(
          24,
          scoreZoneWinPct({
            kind: 'break',
            side: breakSide,
            zone: breakZone,
            bookImbalance,
            btcRs,
          }) + Math.floor(prof.winAdj / 2)
        )
      )
    )

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
      id: `${z.id}_break_${tradeStyle.toLowerCase()}`,
      kind: 'STOP_THEN_REVERSE',
      side: breakSide,
      title: `${prof.tag} ↯ Слом · ${z.label}`,
      probability: breakWin,
      preconditions: breakPre,
      entryZone: {
        top: Math.max(breakEntry, z.invalidation),
        bottom: Math.min(breakEntry, z.invalidation),
      },
      limitEntry: breakEntry,
      target: breakTp,
      invalidation: breakInv,
      triggerSummary: `${prof.tag} слом ${z.source}: ${breakSide} → ${breakTp.toPrecision(6)} · ~${breakWin}%`,
      reasoning: [
        `${prof.label} альтернатива: stop-run через зону`,
        `Inv (возврат в зону) @ ${breakInv.toPrecision(6)}`,
      ],
      chartPath: buildZoneBreakPath(breakZone, price, prof.pathScale),
      status: statusFromPre(breakPre),
      symbol,
      internalSymbol,
      createdAt: Date.now(),
      tradeStyle,
    })
  }

  return out
}
