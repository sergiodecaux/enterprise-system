/**
 * Rolling signal snapshots → «что изменилось» за 15–30 мин.
 */

import type { CoinSignal } from '../types'

export interface SignalSnapshot {
  at: number
  probabilityPct: number
  score: number
  direction: CoinSignal['direction']
  scoreGrade: string | null
  scoreReady: boolean
  surgicalStatus: string | null
  mmSide: string | null
  mmConfidence: number | null
  hasActiveSetup: boolean
  bookHint: string | null
}

export interface ChangeLine {
  id: string
  label: string
  from: string
  to: string
  tone: 'up' | 'down' | 'warn' | 'neutral'
}

export interface WhatChanged {
  ageMin: number
  lines: ChangeLine[]
  summary: string
}

const MAX_PER_SYMBOL = 24
const history = new Map<string, SignalSnapshot[]>()

function snapFrom(signal: CoinSignal): SignalSnapshot {
  return {
    at: Date.now(),
    probabilityPct: signal.probabilityPct,
    score: signal.score,
    direction: signal.direction,
    scoreGrade: signal.scoreCard?.grade ?? null,
    scoreReady: !!signal.scoreCard?.ready,
    surgicalStatus: signal.surgicalEntry?.status ?? null,
    mmSide: signal.mmIntent?.preferredSide ?? null,
    mmConfidence:
      signal.mmIntent != null ? Math.round(signal.mmIntent.confidence) : null,
    hasActiveSetup: signal.hasActiveSetup,
    bookHint: null,
  }
}

/** Push snapshot if material change or ≥3 min since last */
export function pushSignalSnapshot(signal: CoinSignal): void {
  const key = signal.internalSymbol
  const list = history.get(key) ?? []
  const next = snapFrom(signal)
  const prev = list[list.length - 1]
  if (prev) {
    const dt = next.at - prev.at
    const material =
      prev.direction !== next.direction ||
      prev.scoreGrade !== next.scoreGrade ||
      prev.surgicalStatus !== next.surgicalStatus ||
      prev.mmSide !== next.mmSide ||
      prev.scoreReady !== next.scoreReady ||
      Math.abs(prev.probabilityPct - next.probabilityPct) >= 4 ||
      Math.abs(prev.score - next.score) >= 0.4
    if (!material && dt < 3 * 60_000) return
  }
  list.push(next)
  while (list.length > MAX_PER_SYMBOL) list.shift()
  history.set(key, list)
}

function findBaseline(
  list: SignalSnapshot[],
  preferMs: number
): SignalSnapshot | null {
  if (list.length < 2) return null
  const now = list[list.length - 1].at
  const target = now - preferMs
  let best: SignalSnapshot | null = null
  let bestDist = Infinity
  for (let i = 0; i < list.length - 1; i++) {
    const d = Math.abs(list[i].at - target)
    if (d < bestDist) {
      bestDist = d
      best = list[i]
    }
  }
  // Accept if within ±12 min of preferred age
  if (best && bestDist <= 12 * 60_000) return best
  // Else oldest available if ≥10 min old
  const oldest = list[0]
  if (now - oldest.at >= 10 * 60_000) return oldest
  return list.length >= 2 ? list[0] : null
}

export function getWhatChanged(
  internalSymbol: string,
  preferMs = 20 * 60_000
): WhatChanged | null {
  const list = history.get(internalSymbol)
  if (!list || list.length < 2) return null
  const cur = list[list.length - 1]
  const base = findBaseline(list, preferMs)
  if (!base) return null

  const ageMin = Math.round((cur.at - base.at) / 60_000)
  const lines: ChangeLine[] = []

  if (base.direction !== cur.direction) {
    lines.push({
      id: 'dir',
      label: 'Направление',
      from: base.direction ?? '—',
      to: cur.direction ?? '—',
      tone: 'warn',
    })
  }
  if (Math.abs(base.probabilityPct - cur.probabilityPct) >= 3) {
    const up = cur.probabilityPct > base.probabilityPct
    lines.push({
      id: 'prob',
      label: 'Вероятность',
      from: `${Math.round(base.probabilityPct)}%`,
      to: `${Math.round(cur.probabilityPct)}%`,
      tone: up ? 'up' : 'down',
    })
  }
  if (base.scoreGrade !== cur.scoreGrade) {
    lines.push({
      id: 'grade',
      label: 'ScoreCard',
      from: base.scoreGrade ?? '—',
      to: cur.scoreGrade ?? '—',
      tone: cur.scoreReady ? 'up' : 'warn',
    })
  }
  if (base.surgicalStatus !== cur.surgicalStatus) {
    lines.push({
      id: 'surg',
      label: 'Surgical',
      from: base.surgicalStatus ?? '—',
      to: cur.surgicalStatus ?? '—',
      tone:
        cur.surgicalStatus === 'READY'
          ? 'up'
          : cur.surgicalStatus === 'INVALIDATED'
            ? 'down'
            : 'neutral',
    })
  }
  if (base.mmSide !== cur.mmSide || (base.mmConfidence != null &&
      cur.mmConfidence != null &&
      Math.abs(base.mmConfidence - cur.mmConfidence) >= 8)) {
    lines.push({
      id: 'mm',
      label: 'MM давление',
      from: `${base.mmSide ?? '—'} ${base.mmConfidence ?? ''}%`.trim(),
      to: `${cur.mmSide ?? '—'} ${cur.mmConfidence ?? ''}%`.trim(),
      tone: 'neutral',
    })
  }
  if (base.hasActiveSetup !== cur.hasActiveSetup) {
    lines.push({
      id: 'setup',
      label: 'Активный сетап',
      from: base.hasActiveSetup ? 'да' : 'нет',
      to: cur.hasActiveSetup ? 'да' : 'нет',
      tone: cur.hasActiveSetup ? 'up' : 'down',
    })
  }

  if (!lines.length) {
    return {
      ageMin,
      lines: [],
      summary: `За ${ageMin} мин без существенных сдвигов`,
    }
  }

  const summary = lines
    .slice(0, 3)
    .map((l) => `${l.label}: ${l.from}→${l.to}`)
    .join(' · ')

  return { ageMin, lines, summary }
}
