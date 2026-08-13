/**
 * Append-only PEAK decision log — why we fired or skipped.
 * Survives in KV for later autopsy (/journal peak or HTTP).
 */

const PEAK_LOG_KEY = 'telegram:peak_decision_log_v292'
const MAX_ROWS = 400

export type PeakDecisionAction =
  | 'ALERT'
  | 'SKIP_QUALITY'
  | 'SKIP_STRUCTURE'
  | 'SKIP_COOLDOWN'
  | 'SKIP_GATES'
  | 'SKIP_NOT_PUMP'

export interface PeakDecisionRow {
  id: string
  at: number
  symbol: string
  action: PeakDecisionAction
  confidence: number
  quality: 'A' | 'B' | 'NONE'
  reasons: string[]
  chg24hPct: number
  /** Distance under local high % */
  distToHighPct?: number | null
  journalId?: string | null
  /** Filled after resolve for ALERT rows */
  outcome?: {
    status: string
    pnlPercent: number | null
    closeReason: string | null
    lesson: string | null
  } | null
}

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<unknown>
}

const memory: PeakDecisionRow[] = []

async function load(kv?: KvLike): Promise<PeakDecisionRow[]> {
  if (memory.length) return memory
  if (!kv) return memory
  try {
    const raw = await kv.get(PEAK_LOG_KEY)
    if (!raw) return memory
    const parsed = JSON.parse(raw) as PeakDecisionRow[]
    if (Array.isArray(parsed)) {
      memory.length = 0
      memory.push(...parsed.slice(0, MAX_ROWS))
    }
  } catch {
    /* ignore */
  }
  return memory
}

async function save(kv: KvLike | undefined, rows: PeakDecisionRow[]) {
  memory.length = 0
  memory.push(...rows.slice(0, MAX_ROWS))
  if (!kv) return
  try {
    await kv.put(PEAK_LOG_KEY, JSON.stringify(memory))
  } catch {
    /* quota */
  }
}

export async function appendPeakDecision(
  kv: KvLike | undefined,
  row: Omit<PeakDecisionRow, 'id'>
): Promise<PeakDecisionRow> {
  const list = await load(kv)
  const full: PeakDecisionRow = {
    ...row,
    id: `pd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
  }
  list.unshift(full)
  await save(kv, list)
  return full
}

export async function listPeakDecisions(
  kv?: KvLike,
  limit = 80
): Promise<PeakDecisionRow[]> {
  const list = await load(kv)
  return list.slice(0, limit)
}

/** Wipe decision log for a clean post-fix autopsy window. */
export async function clearPeakDecisions(kv?: KvLike): Promise<number> {
  const list = await load(kv)
  const n = list.length
  await save(kv, [])
  return n
}

/** Attach resolve autopsy onto the matching ALERT decision (best-effort). */
export async function attachPeakOutcome(
  kv: KvLike | undefined,
  opts: {
    symbol: string
    createdAt: number
    status: string
    pnlPercent: number | null
    closeReason: string | null
    lesson: string | null
  }
): Promise<void> {
  const list = await load(kv)
  const hit = list.find(
    (r) =>
      r.action === 'ALERT' &&
      r.symbol === opts.symbol &&
      Math.abs(r.at - opts.createdAt) < 20 * 60_000 &&
      !r.outcome
  )
  if (!hit) return
  hit.outcome = {
    status: opts.status,
    pnlPercent: opts.pnlPercent,
    closeReason: opts.closeReason,
    lesson: opts.lesson,
  }
  await save(kv, list)
}

export function summarizePeakDecisions(rows: PeakDecisionRow[]): {
  alerts: number
  skips: number
  alertWins: number
  alertLosses: number
  topSkipReasons: Array<{ reason: string; n: number }>
} {
  let alerts = 0
  let skips = 0
  let alertWins = 0
  let alertLosses = 0
  const skipMap = new Map<string, number>()
  for (const r of rows) {
    if (r.action === 'ALERT') {
      alerts++
      if (r.outcome?.status === 'WIN') alertWins++
      if (r.outcome?.status === 'LOSS') alertLosses++
    } else {
      skips++
      const key = r.reasons[0] || r.action
      skipMap.set(key, (skipMap.get(key) ?? 0) + 1)
    }
  }
  const topSkipReasons = [...skipMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, n]) => ({ reason, n }))
  return { alerts, skips, alertWins, alertLosses, topSkipReasons }
}
