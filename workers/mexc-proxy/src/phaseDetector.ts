/**
 * MM phase machine — events build a phase; only phase transitions give entries.
 *
 * LONG:  ACCUMULATION (steps 1–4) → MARKUP
 * SHORT: DISTRIBUTION (steps 1–4) → MARKDOWN
 * Window: 3–8 minutes of ordered steps. Broken order → reset / CHOP.
 */

export type Phase =
  | 'ACCUMULATION'
  | 'DISTRIBUTION'
  | 'MARKUP'
  | 'MARKDOWN'
  | 'CHOP'
  | 'UNKNOWN'

export interface PhaseState {
  phase: Phase
  confidence: number
  duration_seconds: number
  steps_confirmed: number
  /** True when ready to enter on ACCUMULATION→MARKUP or DISTRIBUTION→MARKDOWN */
  transitionReady: boolean
  reasons: string[]
}

export interface PhaseTickInput {
  now?: number
  /** Prior persisted state for this symbol */
  prev?: PhasePersist | null
  buyFlowPct?: number | null
  priceMoveBps?: number | null
  obi?: number | null
  prevObi?: number | null
  wallPersisted?: boolean
  absorptionLong?: boolean
  absorptionShort?: boolean
  /** Last closed 1m candles (newest last) */
  closed1m?: Array<[number, number, number, number, number, number]>
}

export interface PhasePersist {
  phase: Phase
  steps: number
  startedAt: number
  lastStepAt: number
  lastTapeSide: 'BUY' | 'SELL' | 'FLAT' | null
  tapeFlips60s: number
  windowStart: number
}

const WINDOW_MIN_MS = 3 * 60_000
const WINDOW_MAX_MS = 8 * 60_000
const STEP_STALE_MS = 10 * 60_000

function seriesRedsThenGreen(
  closed: Array<[number, number, number, number, number, number]>
): boolean {
  if (closed.length < 4) return false
  const w = closed.slice(-5)
  const last = w[w.length - 1]!
  if (!(last[4] > last[1])) return false
  let reds = 0
  for (let i = 0; i < w.length - 1; i++) {
    if (w[i]![4] < w[i]![1]) reds++
  }
  return reds >= 2
}

function seriesGreensThenRed(
  closed: Array<[number, number, number, number, number, number]>
): boolean {
  if (closed.length < 4) return false
  const w = closed.slice(-5)
  const last = w[w.length - 1]!
  if (!(last[4] < last[1])) return false
  let greens = 0
  for (let i = 0; i < w.length - 1; i++) {
    if (w[i]![4] > w[i]![1]) greens++
  }
  return greens >= 2
}

function emptyPersist(now: number): PhasePersist {
  return {
    phase: 'UNKNOWN',
    steps: 0,
    startedAt: now,
    lastStepAt: now,
    lastTapeSide: null,
    tapeFlips60s: 0,
    windowStart: now,
  }
}

/**
 * Advance / evaluate phase for one symbol tick.
 * Returns UI state + updated persist blob for KV.
 */
export function advancePhase(input: PhaseTickInput): {
  state: PhaseState
  persist: PhasePersist
} {
  const now = input.now ?? Date.now()
  let p = input.prev ? { ...input.prev } : emptyPersist(now)

  if (now - p.lastStepAt > STEP_STALE_MS) {
    p = emptyPersist(now)
  }
  if (now - p.windowStart > WINDOW_MAX_MS && p.steps > 0 && p.steps < 4) {
    // Window blown before completion
    p = { ...emptyPersist(now), phase: 'CHOP' }
  }

  const buy = input.buyFlowPct
  const move = input.priceMoveBps
  const obi = input.obi
  const prevObi = input.prevObi
  const closed = input.closed1m ?? []

  // Tape side tracking for coherence (exported via persist)
  let tapeSide: 'BUY' | 'SELL' | 'FLAT' = 'FLAT'
  if (buy != null) {
    if (buy >= 55) tapeSide = 'BUY'
    else if (buy <= 45) tapeSide = 'SELL'
  }
  if (p.lastTapeSide && tapeSide !== 'FLAT' && tapeSide !== p.lastTapeSide) {
    p.tapeFlips60s += 1
  }
  if (tapeSide !== 'FLAT') p.lastTapeSide = tapeSide

  const reasons: string[] = []

  // --- DISTRIBUTION path (SHORT setup) ---
  // Step 1: buy tape strong, price NOT rising
  const dist1 =
    input.absorptionShort ||
    (buy != null &&
      move != null &&
      buy >= 55 &&
      Math.abs(move) <= 12)
  // Step 2: ask walls persist
  const dist2 = Boolean(input.wallPersisted && (obi == null || obi <= 5))
  // Step 3: OBI falling (smooth, not spike)
  const dist3 =
    obi != null &&
    prevObi != null &&
    obi < prevObi - 2 &&
    obi - prevObi > -25
  // Step 4: first red after greens
  const dist4 = seriesGreensThenRed(closed)

  // --- ACCUMULATION path (LONG setup) ---
  const acc1 =
    input.absorptionLong ||
    (buy != null &&
      move != null &&
      buy <= 45 &&
      Math.abs(move) <= 12)
  const acc2 = Boolean(input.wallPersisted && (obi == null || obi >= -5))
  const acc3 =
    obi != null &&
    prevObi != null &&
    obi > prevObi + 2 &&
    obi - prevObi < 25
  const acc4 = seriesRedsThenGreen(closed)

  // Prefer continuing current path; else pick unambiguous fresh path
  const buildingDist =
    p.phase === 'DISTRIBUTION' ||
    p.phase === 'MARKDOWN' ||
    (dist1 && !acc1) ||
    (dist1 && p.phase !== 'ACCUMULATION' && p.phase !== 'MARKUP')
  const buildingAcc =
    p.phase === 'ACCUMULATION' ||
    p.phase === 'MARKUP' ||
    (acc1 && !dist1) ||
    (acc1 && p.phase !== 'DISTRIBUTION' && p.phase !== 'MARKDOWN')

  let steps = p.steps
  let phase: Phase = p.phase
  let transitionReady = false

  if (buildingDist && (dist1 || steps >= 1) && !(buildingAcc && !dist1)) {
    phase = 'DISTRIBUTION'
    if (steps < 1 && dist1) {
      steps = 1
      p.windowStart = now
      reasons.push('dist_step1:absorb_buy')
    }
    if (steps === 1 && dist2) {
      steps = 2
      reasons.push('dist_step2:ask_wall')
    }
    if (steps === 2 && dist3) {
      steps = 3
      reasons.push('dist_step3:obi_fade')
    }
    if (steps >= 3 && dist4) {
      steps = 4
      reasons.push('dist_step4:first_red')
      const winOk =
        now - p.windowStart >= WINDOW_MIN_MS &&
        now - p.windowStart <= WINDOW_MAX_MS
      if (winOk || steps === 4) {
        phase = 'MARKDOWN'
        transitionReady = true
        reasons.push('transition:DISTRIBUTION→MARKDOWN')
      }
    }
  } else if (buildingAcc && (acc1 || steps >= 1)) {
    phase = 'ACCUMULATION'
    if (steps < 1 && acc1) {
      steps = 1
      p.windowStart = now
      reasons.push('acc_step1:absorb_sell')
    }
    if (steps === 1 && acc2) {
      steps = 2
      reasons.push('acc_step2:bid_wall')
    }
    if (steps === 2 && acc3) {
      steps = 3
      reasons.push('acc_step3:obi_build')
    }
    if (steps >= 3 && acc4) {
      steps = 4
      reasons.push('acc_step4:first_green')
      const winOk =
        now - p.windowStart >= WINDOW_MIN_MS &&
        now - p.windowStart <= WINDOW_MAX_MS
      if (winOk || steps === 4) {
        phase = 'MARKUP'
        transitionReady = true
        reasons.push('transition:ACCUMULATION→MARKUP')
      }
    }
  } else if (dist1 && acc1) {
    phase = 'CHOP'
    steps = 0
    reasons.push('phase:chop_conflict')
  } else if (!dist1 && !acc1 && steps === 0) {
    phase = 'UNKNOWN'
  }

  // Soft same-tick complete when all 4 evidence bits present (lab / fast books)
  if (!transitionReady) {
    if (dist1 && dist2 && dist3 && dist4) {
      phase = 'MARKDOWN'
      steps = 4
      transitionReady = true
      reasons.push('dist_same_tick:1-4')
    } else if (acc1 && acc2 && acc3 && acc4) {
      phase = 'MARKUP'
      steps = 4
      transitionReady = true
      reasons.push('acc_same_tick:1-4')
    }
  }

  if (steps > p.steps) p.lastStepAt = now
  p.steps = steps
  p.phase = phase
  if (phase === 'UNKNOWN' || phase === 'CHOP') {
    p.startedAt = now
  }

  const duration_seconds = Math.round((now - p.startedAt) / 1000)
  let confidence = 40 + steps * 12
  if (transitionReady) confidence += 15
  if (phase === 'CHOP') confidence = 20
  confidence = Math.min(95, confidence)

  return {
    state: {
      phase,
      confidence,
      duration_seconds,
      steps_confirmed: steps,
      transitionReady,
      reasons,
    },
    persist: p,
  }
}

/** Soft A-gate: allow when transition ready OR ≥3 steps on correct side. */
export function phaseAllowsEntry(
  state: PhaseState,
  side: 'LONG' | 'SHORT'
): boolean {
  if (side === 'SHORT') {
    return (
      state.transitionReady &&
      (state.phase === 'MARKDOWN' || state.phase === 'DISTRIBUTION')
    ) || (state.phase === 'DISTRIBUTION' && state.steps_confirmed >= 3)
  }
  return (
    state.transitionReady &&
    (state.phase === 'MARKUP' || state.phase === 'ACCUMULATION')
  ) || (state.phase === 'ACCUMULATION' && state.steps_confirmed >= 3)
}
