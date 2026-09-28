import type { Radar141Row } from '../radar141/types'
import type { WatchedSetup } from '../setups/types'
import type { CoinSignal } from '../types'
import { clip, num, px } from './format'
import type { AdvisorHunt, AdvisorHuntRow } from './types'

const READY_CAP = 8
const NEAR_CAP = 5

function rr(
  dir: string | null | undefined,
  price: number,
  sl: number | null | undefined,
  tp: number | null | undefined
): number | null {
  if (!dir || !(price > 0) || sl == null || tp == null) return null
  const risk = Math.abs(price - sl)
  const reward = Math.abs(tp - price)
  if (!(risk > 0) || !(reward > 0)) return null
  return num(reward / risk, 1)
}

function rowFromSignal(
  s: CoinSignal,
  radar: Radar141Row | undefined,
  kind: AdvisorHuntRow['kind'],
  why: string,
  rank: number
): AdvisorHuntRow {
  const sur = s.surgicalEntry
  const mm = s.mmIntent
  const zone =
    sur?.zoneBottom != null && sur?.zoneTop != null
      ? ([px(sur.zoneBottom) ?? 0, px(sur.zoneTop) ?? 0] as [number, number])
      : undefined
  return {
    s: s.symbol,
    dir: s.direction ?? radar?.preferredSide ?? 'WAIT',
    kind,
    rank,
    px: px(s.price) ?? 0,
    sl: px(s.sl) ?? undefined,
    tp1: px(s.tp1) ?? undefined,
    tp2: px(s.tp2) ?? undefined,
    rr: rr(s.direction, s.price, s.sl, s.tp1) ?? undefined,
    zone,
    grade: s.scoreCard?.grade,
    ready: s.scoreCard?.ready || undefined,
    missing: s.scoreCard?.missingFactors.slice(0, 2),
    style: s.tradeStyle ?? undefined,
    prob: Math.round(s.probabilityPct),
    score: num(s.score, 1) ?? undefined,
    trig: radar?.trigger,
    d141: num(radar?.dist141Pct) ?? undefined,
    gap: num(radar?.gapPct) ?? undefined,
    mm: mm ? clip(`${mm.drive} ${mm.preferredSide ?? ''} ${Math.round(mm.confidence)}%`, 40) : undefined,
    surgi: sur && sur.status !== 'IDLE' ? clip(`${sur.status} ${sur.side}`, 40) : undefined,
    why: clip(why, 90),
  }
}

function rankOf(s: CoinSignal, radar: Radar141Row | undefined): { score: number; kind: AdvisorHuntRow['kind']; why: string } {
  const card = s.scoreCard
  const sur = s.surgicalEntry
  let score = Math.round(s.probabilityPct) + (s.score ?? 0) * 4
  let kind: AdvisorHuntRow['kind'] = 'near'
  const why: string[] = []

  if (card?.ready) {
    score += 120
    kind = 'ready'
    why.push(`ScoreCard ${card.grade} готов`)
  } else if (card?.grade === 'A+' || card?.grade === 'A') {
    score += 40
    why.push(`Grade ${card.grade}, не ready`)
  }
  if (sur?.status === 'READY') {
    score += 90
    kind = kind === 'near' ? 'surgical' : kind
    why.push('surgical READY')
  } else if (sur?.status === 'WAITING_CONFIRM' || sur?.status === 'WAITING_SWEEP') {
    score += 25
    why.push(sur.status)
  }
  if (s.hasActiveSetup) {
    score += 35
    if (kind === 'near') kind = 'setup'
    why.push('активный сетап')
  }
  if (radar) {
    if (radar.trigger === 'INSIDE_141' || radar.trigger === 'APPROACH_141') {
      score += 45 + Math.round(radar.opportunityScore / 4)
      if (kind === 'near') kind = 'radar141'
      why.push(`${radar.triggerLabel || radar.trigger} gap ${radar.gapPct.toFixed(1)}%`)
    } else if (radar.opportunityScore >= 70) {
      score += 20
      why.push(`радар ${Math.round(radar.opportunityScore)}`)
    }
  }
  if (s.mmIntent?.preferredSide && s.mmIntent.preferredSide === s.direction && s.mmIntent.confidence >= 55) {
    score += 12
  }
  if (!s.direction) score -= 30
  if (card && !card.ready && card.missingFactors.length) {
    why.push(`нет: ${card.missingFactors.slice(0, 2).join(', ')}`)
  }

  return { score, kind, why: why.slice(0, 3).join(' · ') || 'слабый сигнал' }
}

export function huntMarketSetups(input: {
  signals: CoinSignal[]
  radarRows: Radar141Row[]
  watches?: WatchedSetup[]
}): AdvisorHunt {
  const radarBySym = new Map<string, Radar141Row>()
  for (const r of input.radarRows) {
    radarBySym.set(r.symbol, r)
    radarBySym.set(r.internalSymbol, r)
  }

  const scored = input.signals
    .map((s) => {
      const radar = radarBySym.get(s.symbol) ?? radarBySym.get(s.internalSymbol)
      const r = rankOf(s, radar)
      return { s, radar, ...r }
    })
    .filter((x) => x.score >= 35 && (x.s.direction || x.kind === 'radar141'))
    .sort((a, b) => b.score - a.score)

  const readyKinds = new Set<AdvisorHuntRow['kind']>(['ready', 'surgical', 'setup', 'radar141'])
  const ready = scored
    .filter((x) => readyKinds.has(x.kind))
    .slice(0, READY_CAP)
    .map((x) => rowFromSignal(x.s, x.radar, x.kind, x.why, x.score))
  const readySyms = new Set(ready.map((r) => r.s))
  const near = scored
    .filter((x) => !readySyms.has(x.s.symbol) && x.kind === 'near')
    .slice(0, NEAR_CAP)
    .map((x) => rowFromSignal(x.s, x.radar, 'near', x.why, x.score))

  const signalSyms = new Set(input.signals.map((s) => s.symbol))
  for (const r of input.radarRows) {
    if (signalSyms.has(r.symbol) || readySyms.has(r.symbol)) continue
    if (r.trigger !== 'INSIDE_141' && r.trigger !== 'APPROACH_141' && r.opportunityScore < 72) continue
    if (ready.length >= READY_CAP) break
    ready.push({
      s: r.symbol,
      dir: r.preferredSide ?? 'WAIT',
      kind: 'radar141',
      rank: Math.round(r.opportunityScore),
      px: px(r.price) ?? 0,
      trig: r.trigger,
      d141: num(r.dist141Pct) ?? undefined,
      gap: num(r.gapPct) ?? undefined,
      why: clip(`${r.triggerLabel} score ${Math.round(r.opportunityScore)}`, 90),
    })
    readySyms.add(r.symbol)
  }

  const watches = (input.watches ?? [])
    .filter((w) => w.setup.status !== 'INVALIDATED' && w.setup.status !== 'EXPIRED')
    .slice(0, 6)
    .map((w) => ({
      s: w.symbol,
      dir: w.setup.side,
      kind: 'watch' as const,
      rank: w.setup.status === 'READY' ? 80 : 40,
      px: px(w.setup.limitEntry) ?? 0,
      sl: px(w.setup.invalidation) ?? undefined,
      tp1: px(w.setup.target) ?? undefined,
      rr: rr(w.setup.side, w.setup.limitEntry, w.setup.invalidation, w.setup.target) ?? undefined,
      zone: [px(w.setup.entryZone.bottom) ?? 0, px(w.setup.entryZone.top) ?? 0] as [number, number],
      style: w.setup.tradeStyle,
      prob: Math.round(w.setup.probability),
      why: clip(`${w.setup.status} ${w.setup.title}`, 80),
    }))

  return {
    scanned: input.signals.length,
    ready,
    near,
    watches: watches.length ? watches : undefined,
  }
}
