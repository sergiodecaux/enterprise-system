/**
 * Journal of bot/cron scanner signals → outcomes for Lab + adaptive filters.
 * Persisted in Cloudflare KV, exposed to Mini App via HTTP.
 */

const JOURNAL_KEY = 'telegram:bot_journal'
const GATES_KEY = 'telegram:bot_gates'
const MAX_ENTRIES = 400
const OPEN_TTL_MS = 4 * 60 * 60_000
const MEXC = 'https://contract.mexc.com'

export type BotJournalStatus =
  | 'OPEN'
  | 'WIN'
  | 'LOSS'
  | 'TIMEOUT'
  | 'INVALIDATED'

export type BotAlertKind = 'SNIPER' | 'MEME'

export interface BotJournalEntry {
  id: string
  symbol: string
  displayName: string
  side: 'LONG' | 'SHORT'
  alertType: BotAlertKind
  setup: string
  score: number
  entryPrice: number
  sl: number
  tp: number
  invalidate: number
  createdAt: number
  expiresAt: number
  status: BotJournalStatus
  resolvedAt: number | null
  exitPrice: number | null
  pnlPercent: number | null
  rMultiple: number | null
  mfePercent: number
  maePercent: number
  dedupeKey: string
  resolveSource: 'AUTO' | 'TIMEOUT' | null
}

export interface BotSetupStats {
  setup: string
  alertType: BotAlertKind | 'ALL'
  total: number
  wins: number
  losses: number
  timeouts: number
  open: number
  winRate: number
  avgR: number
  avgPnl: number
  avgMfe: number
  avgMae: number
  expectancyR: number
}

export interface BotJournalInsight {
  id: string
  severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'POSITIVE'
  title: string
  detail: string
  setup?: string
}

export interface BotJournalAnalytics {
  total: number
  resolved: number
  wins: number
  losses: number
  timeouts: number
  open: number
  winRate: number
  avgR: number
  avgPnl: number
  bySetup: BotSetupStats[]
  byAlertType: BotSetupStats[]
  insights: BotJournalInsight[]
  updatedAt: number
}

/** Adaptive scanner gates derived from outcomes */
export interface WinPctCalibrationEntry {
  setup: string
  sampleN: number
  historicalWr: number
  avgR: number
}

export interface BotAdaptiveGates {
  /** Min score to emit MEME alerts */
  minMemeScore: number
  /** Min score for SNIPER */
  minSniperScore: number
  /** Block setups with poor expectancy */
  blockedSetups: string[]
  /** Prefer setups with good WR */
  boostedSetups: string[]
  /** Require stronger confirmation for weak setups */
  requireHighBrokenForSqueeze: boolean
  /** Empirical win% by setup for display calibration */
  winPctBySetup: WinPctCalibrationEntry[]
  updatedAt: number
  sampleSize: number
}


export interface TradePlanLike {
  side: 'LONG' | 'SHORT'
  symbol: string
  setup: string
  signalPrice: number
  entryIdeal: number
  zoneLow: number
  zoneHigh: number
  invalidate: number
  sl: number
  tp: number
}

interface Env {
  SUBSCRIBERS?: KVNamespace
}

const memoryJournal: BotJournalEntry[] = []
let memoryGates: BotAdaptiveGates | null = null

function avg(nums: number[]): number {
  if (!nums.length) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function pnlPct(side: 'LONG' | 'SHORT', entry: number, price: number): number {
  if (!(entry > 0)) return 0
  return side === 'LONG'
    ? ((price - entry) / entry) * 100
    : ((entry - price) / entry) * 100
}

function rMult(
  side: 'LONG' | 'SHORT',
  entry: number,
  sl: number,
  exit: number
): number {
  const risk = Math.abs(entry - sl)
  if (!(risk > 0)) return 0
  const pnl =
    side === 'LONG' ? exit - entry : entry - exit
  return pnl / risk
}

async function listJournal(env: Env): Promise<BotJournalEntry[]> {
  if (!env.SUBSCRIBERS) return [...memoryJournal]
  const raw = await env.SUBSCRIBERS.get(JOURNAL_KEY)
  if (!raw) return [...memoryJournal]
  try {
    return JSON.parse(raw) as BotJournalEntry[]
  } catch {
    return [...memoryJournal]
  }
}

async function saveJournal(
  env: Env,
  list: BotJournalEntry[]
): Promise<void> {
  const trimmed = list
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_ENTRIES)
  memoryJournal.length = 0
  memoryJournal.push(...trimmed)
  if (!env.SUBSCRIBERS) return
  await env.SUBSCRIBERS.put(JOURNAL_KEY, JSON.stringify(trimmed))
}

export async function recordBotAlert(
  env: Env,
  input: {
    alertType: BotAlertKind
    score: number
    dedupeKey: string
    plan: TradePlanLike
  }
): Promise<BotJournalEntry | null> {
  const list = await listJournal(env)
  if (list.some((e) => e.dedupeKey === input.dedupeKey && e.status === 'OPEN')) {
    return null
  }

  const entry: BotJournalEntry = {
    id: `bj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    symbol: input.plan.symbol,
    displayName: input.plan.symbol.replace('_USDT', '/USDT'),
    side: input.plan.side,
    alertType: input.alertType,
    setup: input.plan.setup,
    score: input.score,
    entryPrice: input.plan.entryIdeal || input.plan.signalPrice,
    sl: input.plan.sl,
    tp: input.plan.tp,
    invalidate: input.plan.invalidate,
    createdAt: Date.now(),
    expiresAt: Date.now() + OPEN_TTL_MS,
    status: 'OPEN',
    resolvedAt: null,
    exitPrice: null,
    pnlPercent: null,
    rMultiple: null,
    mfePercent: 0,
    maePercent: 0,
    dedupeKey: input.dedupeKey,
    resolveSource: null,
  }

  list.unshift(entry)
  await saveJournal(env, list)
  return entry
}

async function fetchLastPrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(
      `${MEXC}/api/v1/contract/ticker?symbol=${encodeURIComponent(symbol)}`
    )
    if (!res.ok) return null
    const json = (await res.json()) as {
      data?: { lastPrice?: number; fairPrice?: number }
    }
    const p = Number(json.data?.lastPrice ?? json.data?.fairPrice ?? 0)
    return p > 0 ? p : null
  } catch {
    return null
  }
}

/**
 * Resolve OPEN bot journal rows vs live price (TP / SL / invalidate / timeout).
 */
export async function resolveBotJournal(env: Env): Promise<number> {
  const list = await listJournal(env)
  const now = Date.now()
  let changed = 0

  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    if (e.status !== 'OPEN') continue

    const price = await fetchLastPrice(e.symbol)
    if (price == null) {
      if (now >= e.expiresAt) {
        list[i] = {
          ...e,
          status: 'TIMEOUT',
          resolvedAt: now,
          exitPrice: e.entryPrice,
          pnlPercent: 0,
          rMultiple: 0,
          resolveSource: 'TIMEOUT',
        }
        changed++
      }
      continue
    }

    const fav = pnlPct(e.side, e.entryPrice, price)
    const mfePercent = Math.max(e.mfePercent, fav)
    const maePercent = Math.max(e.maePercent, -fav)

    let status: BotJournalStatus | null = null
    if (e.side === 'LONG') {
      if (price >= e.tp) status = 'WIN'
      else if (price <= e.sl || price <= e.invalidate) status = 'LOSS'
    } else {
      if (price <= e.tp) status = 'WIN'
      else if (price >= e.sl || price >= e.invalidate) status = 'LOSS'
    }

    if (!status && now >= e.expiresAt) {
      status = 'TIMEOUT'
    }

    if (status) {
      const exit = price
      const pnl = pnlPct(e.side, e.entryPrice, exit)
      list[i] = {
        ...e,
        status,
        resolvedAt: now,
        exitPrice: exit,
        pnlPercent: Number(pnl.toFixed(3)),
        rMultiple: Number(
          rMult(e.side, e.entryPrice, e.sl, exit).toFixed(3)
        ),
        mfePercent: Number(mfePercent.toFixed(3)),
        maePercent: Number(maePercent.toFixed(3)),
        resolveSource: status === 'TIMEOUT' ? 'TIMEOUT' : 'AUTO',
      }
      changed++
    } else {
      list[i] = {
        ...e,
        mfePercent: Number(mfePercent.toFixed(3)),
        maePercent: Number(maePercent.toFixed(3)),
      }
    }
  }

  if (changed > 0) await saveJournal(env, list)

  // Refresh adaptive gates after resolves
  if (changed > 0) {
    await recomputeAndSaveGates(env)
  }

  return changed
}

function setupStats(
  entries: BotJournalEntry[],
  setup: string,
  alertType: BotAlertKind | 'ALL'
): BotSetupStats {
  const subset = entries.filter(
    (e) =>
      e.setup === setup &&
      (alertType === 'ALL' || e.alertType === alertType)
  )
  const wins = subset.filter((e) => e.status === 'WIN')
  const losses = subset.filter(
    (e) => e.status === 'LOSS' || e.status === 'INVALIDATED'
  )
  const timeouts = subset.filter((e) => e.status === 'TIMEOUT')
  const open = subset.filter((e) => e.status === 'OPEN')
  const decided = wins.length + losses.length
  const winRate = decided > 0 ? (wins.length / decided) * 100 : 0
  const withR = subset.filter((e) => e.rMultiple != null && e.status !== 'OPEN')
  const avgR = avg(withR.map((e) => e.rMultiple!))
  const avgWinR = avg(wins.map((e) => e.rMultiple ?? 0))
  const avgLossR = avg(losses.map((e) => Math.abs(e.rMultiple ?? 0)))
  const wr = winRate / 100
  const expectancyR = wr * avgWinR - (1 - wr) * avgLossR

  return {
    setup,
    alertType,
    total: subset.length,
    wins: wins.length,
    losses: losses.length,
    timeouts: timeouts.length,
    open: open.length,
    winRate,
    avgR,
    avgPnl: avg(
      subset
        .filter((e) => e.pnlPercent != null)
        .map((e) => e.pnlPercent!)
    ),
    avgMfe: avg(subset.map((e) => e.mfePercent)),
    avgMae: avg(subset.map((e) => e.maePercent)),
    expectancyR: Number.isFinite(expectancyR) ? expectancyR : 0,
  }
}

export function computeBotAnalytics(
  entries: BotJournalEntry[]
): BotJournalAnalytics {
  const wins = entries.filter((e) => e.status === 'WIN')
  const losses = entries.filter(
    (e) => e.status === 'LOSS' || e.status === 'INVALIDATED'
  )
  const timeouts = entries.filter((e) => e.status === 'TIMEOUT')
  const open = entries.filter((e) => e.status === 'OPEN')
  const decided = wins.length + losses.length
  const winRate = decided > 0 ? (wins.length / decided) * 100 : 0

  const setups = [...new Set(entries.map((e) => e.setup))]
  const bySetup = setups
    .map((s) => setupStats(entries, s, 'ALL'))
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total)

  const byAlertType: BotSetupStats[] = (['MEME', 'SNIPER'] as BotAlertKind[]).map(
    (t) => {
      const subset = entries.filter((e) => e.alertType === t)
      const w = subset.filter((e) => e.status === 'WIN')
      const l = subset.filter(
        (e) => e.status === 'LOSS' || e.status === 'INVALIDATED'
      )
      const d = w.length + l.length
      return {
        setup: t,
        alertType: t,
        total: subset.length,
        wins: w.length,
        losses: l.length,
        timeouts: subset.filter((e) => e.status === 'TIMEOUT').length,
        open: subset.filter((e) => e.status === 'OPEN').length,
        winRate: d > 0 ? (w.length / d) * 100 : 0,
        avgR: avg(
          subset
            .filter((e) => e.rMultiple != null)
            .map((e) => e.rMultiple!)
        ),
        avgPnl: avg(
          subset
            .filter((e) => e.pnlPercent != null)
            .map((e) => e.pnlPercent!)
        ),
        avgMfe: avg(subset.map((e) => e.mfePercent)),
        avgMae: avg(subset.map((e) => e.maePercent)),
        expectancyR: 0,
      }
    }
  )

  const insights: BotJournalInsight[] = []
  for (const s of bySetup) {
    if (s.wins + s.losses < 5) continue
    if (s.winRate < 40 && s.expectancyR < 0) {
      insights.push({
        id: `weak_${s.setup}`,
        severity: 'HIGH',
        title: `${s.setup}: слабый сетап`,
        detail: `WR ${s.winRate.toFixed(0)}% · E[R]=${s.expectancyR.toFixed(2)} на ${s.wins + s.losses} сделках. Повышаем порог / блок.`,
        setup: s.setup,
      })
    } else if (s.winRate >= 65 && s.expectancyR > 0.3) {
      insights.push({
        id: `strong_${s.setup}`,
        severity: 'POSITIVE',
        title: `${s.setup}: сильный сетап`,
        detail: `WR ${s.winRate.toFixed(0)}% · E[R]=${s.expectancyR.toFixed(2)}. Можно усиливать вес в сканере.`,
        setup: s.setup,
      })
    }
    if (s.avgMae > Math.abs(s.avgMfe) * 0.9 && s.losses >= 3) {
      insights.push({
        id: `mae_${s.setup}`,
        severity: 'MEDIUM',
        title: `${s.setup}: глубокие просадки`,
        detail: `MAE ${s.avgMae.toFixed(2)}% vs MFE ${s.avgMfe.toFixed(2)}%. Ужесточить SL / ждать reclaim.`,
        setup: s.setup,
      })
    }
  }

  const meme = byAlertType.find((x) => x.alertType === 'MEME')
  if (meme && meme.wins + meme.losses >= 8 && meme.winRate < 45) {
    insights.push({
      id: 'meme_overall',
      severity: 'HIGH',
      title: 'Мемы в боте: низкий WR',
      detail: `Общий WR мемов ${meme.winRate.toFixed(0)}%. Поднимаем min score и режем слабые setup.`,
    })
  }

  return {
    total: entries.length,
    resolved: entries.length - open.length,
    wins: wins.length,
    losses: losses.length,
    timeouts: timeouts.length,
    open: open.length,
    winRate,
    avgR: avg(
      entries.filter((e) => e.rMultiple != null).map((e) => e.rMultiple!)
    ),
    avgPnl: avg(
      entries.filter((e) => e.pnlPercent != null).map((e) => e.pnlPercent!)
    ),
    bySetup,
    byAlertType,
    insights,
    updatedAt: Date.now(),
  }
}

export function deriveAdaptiveGates(
  analytics: BotJournalAnalytics
): BotAdaptiveGates {
  const blocked: string[] = []
  const boosted: string[] = []
  let minMemeScore = 72
  let minSniperScore = 82

  for (const s of analytics.bySetup) {
    const n = s.wins + s.losses
    if (n < 5) continue
    const base = parseBotSetup(s.setup).base
    if (s.winRate < 38 || s.expectancyR < -0.15) {
      blocked.push(s.setup)
      if (base && !blocked.includes(base)) blocked.push(base)
    } else if (s.winRate >= 62 && s.expectancyR >= 0.25) {
      boosted.push(s.setup)
      if (base && !boosted.includes(base)) boosted.push(base)
    }
  }

  const meme = analytics.byAlertType.find((x) => x.alertType === 'MEME')
  if (meme && meme.wins + meme.losses >= 8) {
    // Cap adaptive floor — otherwise journal cold streak silences all memes
    if (meme.winRate < 42) minMemeScore = 82
    else if (meme.winRate < 50) minMemeScore = 78
    else if (meme.winRate >= 60) minMemeScore = 70
  }

  const sniper = analytics.byAlertType.find((x) => x.alertType === 'SNIPER')
  if (sniper && sniper.wins + sniper.losses >= 6) {
    if (sniper.winRate < 45) minSniperScore = 88
    else if (sniper.winRate >= 60) minSniperScore = 78
  }

  const squeezeBlocked = blocked.some(
    (b) => b === 'SQUEEZE' || b.startsWith('SQUEEZE_')
  )

  return {
    minMemeScore,
    minSniperScore,
    blockedSetups: blocked,
    boostedSetups: boosted,
    requireHighBrokenForSqueeze: squeezeBlocked || (meme?.winRate ?? 100) < 48,
    winPctBySetup: buildWinPctCalibration(analytics),
    updatedAt: Date.now(),
    sampleSize: analytics.resolved,
  }
}

/** Parse composite `PUMP_SCALP_TREND` → base / style / align */
export function parseBotSetup(setup: string): {
  base: string
  style: string | null
  align: string | null
} {
  const parts = setup.split('_')
  if (parts.length >= 3) {
    const align = parts[parts.length - 1]
    const style = parts[parts.length - 2]
    if (
      (align === 'TREND' || align === 'COUNTER') &&
      (style === 'SCALP' || style === 'INTRADAY' || style === 'SWING')
    ) {
      return {
        base: parts.slice(0, -2).join('_'),
        style,
        align,
      }
    }
  }
  return { base: setup, style: null, align: null }
}

export function buildWinPctCalibration(
  analytics: BotJournalAnalytics
): WinPctCalibrationEntry[] {
  return analytics.bySetup
    .map((s) => {
      const n = s.wins + s.losses
      return {
        setup: s.setup,
        sampleN: n,
        historicalWr: s.winRate,
        avgR: s.avgR,
      }
    })
    .filter((s) => s.sampleN >= 3)
    .sort((a, b) => b.sampleN - a.sampleN)
}

/**
 * Shrink empirical WR toward model prior.
 * n=0 → prior; n≥20 → mostly historical.
 */
export function calibrateWinPct(
  priorWinPct: number,
  compositeSetup: string,
  calibration: WinPctCalibrationEntry[] | undefined | null
): { winPct: number; source: 'PRIOR' | 'BLEND' | 'EMPIRICAL'; sampleN: number } {
  if (!calibration?.length) {
    return { winPct: priorWinPct, source: 'PRIOR', sampleN: 0 }
  }
  const { base } = parseBotSetup(compositeSetup)
  const exact = calibration.find((c) => c.setup === compositeSetup)
  const byBase = calibration.find((c) => parseBotSetup(c.setup).base === base)
  const row =
    exact && exact.sampleN >= 3
      ? exact
      : byBase && byBase.sampleN >= 5
        ? byBase
        : exact ?? byBase
  if (!row || row.sampleN < 3) {
    return { winPct: priorWinPct, source: 'PRIOR', sampleN: 0 }
  }
  const w = Math.min(1, row.sampleN / 20)
  const blended = Math.round(priorWinPct * (1 - w) + row.historicalWr * w)
  return {
    winPct: Math.max(0, Math.min(92, blended)),
    source: w >= 0.85 ? 'EMPIRICAL' : 'BLEND',
    sampleN: row.sampleN,
  }
}

export function isSetupBlocked(
  gates: BotAdaptiveGates,
  setupBase: string,
  compositeSetup: string
): boolean {
  return gates.blockedSetups.some(
    (b) =>
      b === setupBase ||
      b === compositeSetup ||
      compositeSetup.startsWith(`${b}_`) ||
      b.startsWith(`${setupBase}_`)
  )
}

export function isSetupBoosted(
  gates: BotAdaptiveGates,
  setupBase: string,
  compositeSetup: string
): boolean {
  return gates.boostedSetups.some(
    (b) =>
      b === setupBase ||
      b === compositeSetup ||
      compositeSetup.startsWith(`${b}_`) ||
      b.startsWith(`${setupBase}_`)
  )
}


async function recomputeAndSaveGates(env: Env): Promise<BotAdaptiveGates> {
  const list = await listJournal(env)
  const analytics = computeBotAnalytics(list)
  const gates = deriveAdaptiveGates(analytics)
  memoryGates = gates
  if (env.SUBSCRIBERS) {
    await env.SUBSCRIBERS.put(GATES_KEY, JSON.stringify(gates))
  }
  return gates
}

export async function getAdaptiveGates(env: Env): Promise<BotAdaptiveGates> {
  if (memoryGates?.winPctBySetup) return memoryGates
  if (env.SUBSCRIBERS) {
    const raw = await env.SUBSCRIBERS.get(GATES_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as BotAdaptiveGates
        if (parsed.winPctBySetup) {
          memoryGates = parsed
          return memoryGates
        }
      } catch {
        /* fallthrough */
      }
    }
  }
  return recomputeAndSaveGates(env)
}

export async function getBotJournalPayload(env: Env): Promise<{
  analytics: BotJournalAnalytics
  entries: BotJournalEntry[]
  gates: BotAdaptiveGates
}> {
  const entries = await listJournal(env)
  const analytics = computeBotAnalytics(entries)
  const gates = await getAdaptiveGates(env)
  return {
    analytics,
    entries: entries.slice(0, 80),
    gates,
  }
}

/** Should scanner emit this setup given adaptive gates? */
export function allowSetupByGates(
  gates: BotAdaptiveGates,
  setup: string,
  score: number,
  alertType: BotAlertKind
): { ok: boolean; reason?: string } {
  const { base } = parseBotSetup(setup)
  if (isSetupBlocked(gates, base, setup) && score < 95) {
    return { ok: false, reason: `blocked_setup:${setup}` }
  }
  const min =
    alertType === 'MEME' ? gates.minMemeScore : gates.minSniperScore
  const boost = isSetupBoosted(gates, base, setup) ? -4 : 0
  if (score < min + boost) {
    return { ok: false, reason: `score<${min + boost}` }
  }
  return { ok: true }
}
