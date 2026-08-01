/**
 * Journal of bot/cron scanner signals → outcomes for Lab + adaptive filters.
 * Persisted in Cloudflare KV, exposed to Mini App via HTTP.
 */
import { listPaperTrades, type PaperTrade } from './paperTrades'
import {
  analyzeTradeOutcome,
  type TradeOutcomeAnalysis,
} from './tradeOutcomeAnalysis'

const JOURNAL_KEY = 'telegram:bot_journal'
const GATES_KEY = 'telegram:bot_gates'
const MAX_ENTRIES = 400
const OPEN_TTL_MS = 4 * 60 * 60_000
const MEXC = 'https://contract.mexc.com'
const RESULT_NOTIFICATIONS_SINCE = 1_784_898_000_000

export type BotJournalStatus =
  | 'OPEN'
  | 'WIN'
  | 'LOSS'
  | 'BE'
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
  target1?: number
  target3?: number
  invalidate: number
  zoneLow?: number
  zoneHigh?: number
  filledAt?: number | null
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
  /** Paper / resolve close code: tp | sl | trail | dead_entry | … */
  closeReason?: string | null
  /** Immediate autopsy after resolve */
  outcomePrimaryTag?: string | null
  outcomeTags?: string[]
  outcomeHeadline?: string | null
  outcomeDetail?: string | null
  outcomeLesson?: string | null
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
  target1?: number
  target3?: number
}

interface Env {
  SUBSCRIBERS?: KVNamespace
}

const memoryJournal: BotJournalEntry[] = []

function journalCacheRequest(): Request {
  return new Request('https://enterprise-system-runtime.invalid/bot-journal')
}

async function readJournalCache(): Promise<BotJournalEntry[] | null> {
  try {
    const response = await caches.default.match(journalCacheRequest())
    if (!response) return null
    return (await response.json()) as BotJournalEntry[]
  } catch {
    return null
  }
}

async function writeJournalCache(list: BotJournalEntry[]): Promise<void> {
  try {
    await caches.default.put(
      journalCacheRequest(),
      new Response(JSON.stringify(list), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
        },
      })
    )
  } catch {
    // Warm-isolate memory remains as a fallback.
  }
}
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
  const cached = await readJournalCache()
  if (cached) return cached
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
  list: BotJournalEntry[],
  checkpoint = false
): Promise<void> {
  const trimmed = list
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_ENTRIES)
  memoryJournal.length = 0
  memoryJournal.push(...trimmed)
  await writeJournalCache(trimmed)
  if (!env.SUBSCRIBERS || !checkpoint) return
  try {
    await env.SUBSCRIBERS.put(JOURNAL_KEY, JSON.stringify(trimmed))
  } catch {
    // New signals continue through Telegram/cache while daily KV is exhausted.
  }
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
  const nowGate = Date.now()
  if (
    list.some(
      (e) =>
        e.status === 'OPEN' &&
        (e.dedupeKey === input.dedupeKey ||
          (e.symbol === input.plan.symbol && e.side === input.plan.side))
    )
  ) {
    return null
  }
  // Memes: block same symbol any side for 45m (trap flip spam).
  if (
    input.alertType === 'MEME' &&
    list.some(
      (e) =>
        e.alertType === 'MEME' &&
        e.symbol === input.plan.symbol &&
        nowGate - e.createdAt < 45 * 60_000
    )
  ) {
    return null
  }

  const now = Date.now()
  const memeImpulse = input.alertType === 'MEME'
  const entry: BotJournalEntry = {
    id: `bj_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    symbol: input.plan.symbol,
    displayName: input.plan.symbol.replace('_USDT', '/USDT'),
    side: input.plan.side,
    alertType: input.alertType,
    setup: input.plan.setup,
    score: input.score,
    entryPrice: input.plan.signalPrice || input.plan.entryIdeal,
    sl: input.plan.sl,
    tp: input.plan.tp,
    target1: input.plan.target1,
    target3: input.plan.target3,
    invalidate: input.plan.invalidate,
    zoneLow: input.plan.zoneLow,
    zoneHigh: input.plan.zoneHigh,
    // Memes enter at market immediately — no zone wait accounting.
    filledAt: memeImpulse ? now : null,
    createdAt: now,
    expiresAt: now + (memeImpulse ? 90 * 60_000 : OPEN_TTL_MS),
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
  await saveJournal(env, list, true)
  return entry
}

async function fetchLastPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>()
  try {
    const res = await fetch(`${MEXC}/api/v1/contract/ticker`)
    if (!res.ok) return prices
    const json = (await res.json()) as {
      data?: Array<{
        symbol?: string
        lastPrice?: number
        fairPrice?: number
      }>
    }
    for (const row of json.data ?? []) {
      const symbol = String(row.symbol ?? '')
      const price = Number(row.lastPrice ?? row.fairPrice ?? 0)
      if (symbol && price > 0) prices.set(symbol, price)
    }
  } catch {
    // Best effort: next cron retries.
  }
  return prices
}

function matchingPaper(
  entry: BotJournalEntry,
  papers: PaperTrade[]
): PaperTrade | null {
  const matches = papers.filter(
    (paper) =>
      paper.symbol === entry.symbol &&
      paper.side === entry.side &&
      paper.setup === entry.setup &&
      Math.abs(paper.createdAt - entry.createdAt) <= 15_000
  )
  return (
    matches.sort(
      (a, b) =>
        Math.abs(a.createdAt - entry.createdAt) -
        Math.abs(b.createdAt - entry.createdAt)
    )[0] ?? null
  )
}

function paperMfeMae(
  entry: BotJournalEntry,
  paper: PaperTrade,
  fill: number
): { mfePercent: number; maePercent: number } {
  let mfe = entry.mfePercent
  let mae = entry.maePercent
  if (paper.peak != null && fill > 0) {
    const peakPnl = pnlPct(entry.side, fill, paper.peak)
    if (peakPnl > 0) mfe = Math.max(mfe, peakPnl)
    else mae = Math.max(mae, -peakPnl)
  }
  if (paper.sl > 0 && fill > 0) {
    const adverse = pnlPct(entry.side, fill, paper.sl)
    if (adverse < 0) mae = Math.max(mae, -adverse)
  }
  return {
    mfePercent: Number(mfe.toFixed(3)),
    maePercent: Number(mae.toFixed(3)),
  }
}

function paperOutcome(
  entry: BotJournalEntry,
  paper: PaperTrade
): Pick<
  BotJournalEntry,
  | 'status'
  | 'exitPrice'
  | 'pnlPercent'
  | 'rMultiple'
  | 'resolveSource'
  | 'closeReason'
  | 'mfePercent'
  | 'maePercent'
> | null {
  if (paper.status !== 'CLOSED' || !paper.closeReason) return null

  const fill = paper.fillPrice ?? entry.entryPrice
  let status: BotJournalStatus
  let exit = fill
  if (paper.closeReason === 'tp') {
    status = 'WIN'
    exit = paper.tp
  } else if (paper.closeReason === 'sl') {
    status = paper.beSent ? 'BE' : 'LOSS'
    exit = paper.sl
  } else if (paper.closeReason === 'trail') {
    exit = paper.trailingStop ?? fill
    const pnl = pnlPct(entry.side, fill, exit)
    status = Math.abs(pnl) < 0.05 ? 'BE' : pnl > 0 ? 'WIN' : 'LOSS'
  } else if (
    paper.closeReason === 'invalidate' ||
    paper.closeReason === 'timeout_waiting'
  ) {
    status = 'INVALIDATED'
  } else {
    status = 'TIMEOUT'
  }

  const pnl = status === 'INVALIDATED' ? 0 : pnlPct(entry.side, fill, exit)
  const { mfePercent, maePercent } = paperMfeMae(entry, paper, fill)
  return {
    status,
    exitPrice: exit,
    pnlPercent: Number(pnl.toFixed(3)),
    rMultiple:
      status === 'INVALIDATED'
        ? 0
        : Number(rMult(entry.side, fill, entry.sl, exit).toFixed(3)),
    resolveSource: status === 'TIMEOUT' ? 'TIMEOUT' : 'AUTO',
    closeReason: paper.closeReason,
    mfePercent,
    maePercent,
  }
}

function setupHistFor(
  entries: BotJournalEntry[],
  setup: string
): { wr: number | null; n: number } {
  const decided = entries.filter(
    (e) =>
      e.setup === setup && (e.status === 'WIN' || e.status === 'LOSS')
  )
  if (decided.length < 5) return { wr: null, n: decided.length }
  const wins = decided.filter((e) => e.status === 'WIN').length
  return { wr: (wins / decided.length) * 100, n: decided.length }
}

function attachOutcomeAnalysis(
  entry: BotJournalEntry,
  journalForHist: BotJournalEntry[]
): BotJournalEntry {
  if (entry.status === 'OPEN') return entry
  const hist = setupHistFor(journalForHist, entry.setup)
  const analysis = analyzeTradeOutcome({
    status: entry.status,
    side: entry.side,
    setup: entry.setup,
    alertType: entry.alertType,
    pnlPercent: entry.pnlPercent,
    rMultiple: entry.rMultiple,
    mfePercent: entry.mfePercent,
    maePercent: entry.maePercent,
    closeReason: entry.closeReason ?? null,
    resolveSource: entry.resolveSource,
    setupWinRate: hist.wr,
    setupSampleN: hist.n,
  })
  if (!analysis) return entry
  return applyAnalysisFields(entry, analysis)
}

function applyAnalysisFields(
  entry: BotJournalEntry,
  analysis: TradeOutcomeAnalysis
): BotJournalEntry {
  return {
    ...entry,
    closeReason: analysis.closeReason ?? entry.closeReason ?? null,
    outcomePrimaryTag: analysis.primaryTag,
    outcomeTags: analysis.tags,
    outcomeHeadline: analysis.headline,
    outcomeDetail: analysis.detail,
    outcomeLesson: analysis.lesson,
  }
}

/**
 * Resolve OPEN bot journal rows vs live price (TP / SL / invalidate / timeout).
 */
export interface BotJournalResolution {
  changed: number
  outcomes: BotJournalEntry[]
}

export async function resolveBotJournal(
  env: Env
): Promise<BotJournalResolution> {
  const list = await listJournal(env)
  const papers = await listPaperTrades(env)
  const prices = await fetchLastPrices()
  const now = Date.now()
  let changed = 0
  const outcomes: BotJournalEntry[] = []

  const pushOutcome = (prev: BotJournalEntry, next: BotJournalEntry) => {
    const analyzed = attachOutcomeAnalysis(next, list)
    if (
      prev.createdAt >= RESULT_NOTIFICATIONS_SINCE &&
      prev.status === 'OPEN' &&
      analyzed.status !== 'OPEN'
    ) {
      outcomes.push(analyzed)
    }
    return analyzed
  }

  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    const paper = matchingPaper(e, papers)
    if (paper) {
      const outcome = paperOutcome(e, paper)
      if (outcome) {
        if (
          e.status !== outcome.status ||
          e.exitPrice !== outcome.exitPrice ||
          e.pnlPercent !== outcome.pnlPercent ||
          !e.outcomeHeadline
        ) {
          const resolved: BotJournalEntry = {
            ...e,
            ...outcome,
            resolvedAt: paper.closedAt ?? now,
          }
          list[i] = pushOutcome(e, resolved)
          changed++
        }
        continue
      }
      // Paper lifecycle owns fill, BE and trailing while the trade is active.
      if (paper.status === 'WAITING' || paper.status === 'OPEN') continue
    }
    if (e.status !== 'OPEN') continue

    const price = prices.get(e.symbol) ?? null
    if (price == null) {
      if (now >= e.expiresAt) {
        list[i] = pushOutcome(e, {
          ...e,
          status: 'TIMEOUT',
          resolvedAt: now,
          exitPrice: e.entryPrice,
          pnlPercent: 0,
          rMultiple: 0,
          resolveSource: 'TIMEOUT',
          closeReason: 'timeout_open',
        })
        changed++
      }
      continue
    }

    // Journal starts as waiting for the limit zone. Do not award a WIN when
    // price ran directly to target without giving the planned pullback entry.
    let working = e
    if (!working.filledAt) {
      const zoneLow = working.zoneLow ?? working.entryPrice
      const zoneHigh = working.zoneHigh ?? working.entryPrice
      const noEntry =
        (working.side === 'LONG' && price >= working.invalidate) ||
        (working.side === 'SHORT' && price <= working.invalidate)
      const touched =
        working.side === 'LONG'
          ? price <= zoneHigh && price > working.sl
          : price >= zoneLow && price < working.sl
      if (noEntry && !touched) {
        list[i] = pushOutcome(working, {
          ...working,
          status: 'INVALIDATED',
          resolvedAt: now,
          exitPrice: working.entryPrice,
          pnlPercent: 0,
          rMultiple: 0,
          resolveSource: 'AUTO',
          closeReason: 'invalidate',
        })
        changed++
        continue
      }
      if (!touched) {
        if (now >= working.expiresAt) {
          list[i] = pushOutcome(working, {
            ...working,
            status: 'INVALIDATED',
            resolvedAt: now,
            exitPrice: working.entryPrice,
            pnlPercent: 0,
            rMultiple: 0,
            resolveSource: 'TIMEOUT',
            closeReason: 'timeout_waiting',
          })
          changed++
        }
        continue
      }
      working = { ...working, filledAt: now }
      list[i] = working
      changed++
    }

    const fav = pnlPct(working.side, working.entryPrice, price)
    const mfePercent = Math.max(working.mfePercent, fav)
    const maePercent = Math.max(working.maePercent, -fav)

    let status: BotJournalStatus | null = null
    let closeReason: string | null = null
    if (working.side === 'LONG') {
      if (price >= working.tp) {
        status = 'WIN'
        closeReason = 'tp'
      } else if (price <= working.sl) {
        status = 'LOSS'
        closeReason = 'sl'
      }
    } else {
      if (price <= working.tp) {
        status = 'WIN'
        closeReason = 'tp'
      } else if (price >= working.sl) {
        status = 'LOSS'
        closeReason = 'sl'
      }
    }

    if (!status && now >= working.expiresAt) {
      status = 'TIMEOUT'
      closeReason = 'timeout_open'
    }

    if (status) {
      const exit = price
      const pnl = pnlPct(working.side, working.entryPrice, exit)
      list[i] = pushOutcome(working, {
        ...working,
        status,
        resolvedAt: now,
        exitPrice: exit,
        pnlPercent: Number(pnl.toFixed(3)),
        rMultiple: Number(
          rMult(working.side, working.entryPrice, working.sl, exit).toFixed(3)
        ),
        mfePercent: Number(mfePercent.toFixed(3)),
        maePercent: Number(maePercent.toFixed(3)),
        resolveSource: status === 'TIMEOUT' ? 'TIMEOUT' : 'AUTO',
        closeReason,
      })
      changed++
    } else {
      list[i] = {
        ...working,
        mfePercent: Number(mfePercent.toFixed(3)),
        maePercent: Number(maePercent.toFixed(3)),
      }
    }
  }

  if (changed > 0) await saveJournal(env, list, outcomes.length > 0)

  // Refresh adaptive gates after resolves
  if (changed > 0) {
    await recomputeAndSaveGates(env)
  }

  return { changed, outcomes }
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
  const losses = subset.filter((e) => e.status === 'LOSS')
  const timeouts = subset.filter((e) => e.status === 'TIMEOUT')
  const open = subset.filter((e) => e.status === 'OPEN')
  const decided = wins.length + losses.length
  const winRate = decided > 0 ? (wins.length / decided) * 100 : 0
  const withR = subset.filter(
    (e) =>
      e.rMultiple != null && (e.status === 'WIN' || e.status === 'LOSS')
  )
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
  const losses = entries.filter((e) => e.status === 'LOSS')
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
      const l = subset.filter((e) => e.status === 'LOSS')
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
            .filter(
              (e) =>
                e.rMultiple != null &&
                (e.status === 'WIN' || e.status === 'LOSS')
            )
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

  const sniper = byAlertType.find((x) => x.alertType === 'SNIPER')
  if (sniper && sniper.wins + sniper.losses >= 6 && sniper.winRate < 45) {
    insights.push({
      id: 'alts_overall',
      severity: 'HIGH',
      title: 'Альты (Vane): низкий WR',
      detail: `WR альтов ${sniper.winRate.toFixed(0)}% · ${sniper.wins}W/${sniper.losses}L. Поднимаем min sniper score / ужесточаем зоны.`,
    })
  } else if (
    sniper &&
    sniper.wins + sniper.losses >= 8 &&
    sniper.winRate >= 60
  ) {
    insights.push({
      id: 'alts_hot',
      severity: 'POSITIVE',
      title: 'Альты (Vane): сильный коридор',
      detail: `WR ${sniper.winRate.toFixed(0)}% · Avg R ${sniper.avgR.toFixed(2)}. Можно чуть снизить порог входа.`,
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
  let minMemeScore = 62
  let minSniperScore = 48

  for (const s of analytics.bySetup) {
    const n = s.wins + s.losses
    const parsed = parseBotSetup(s.setup)
    // Fast block for proven losers (meme CONT era needs n≥3, not 8)
    const earlyBlock =
      n >= 3 &&
      (s.winRate < 25 || s.expectancyR < -0.5) &&
      (s.setup.startsWith('SPOOF') ||
        s.setup.startsWith('LIQ_') ||
        s.setup.startsWith('FADE_BOOK') ||
        s.setup === 'BOOK_RELEASE' ||
        s.setup === 'ABSORPTION')
    if (earlyBlock) {
      if (!blocked.includes(s.setup)) blocked.push(s.setup)
      continue
    }
    if (n < 8) {
      // Early boost for high-WR CONT with small but clean sample
      if (
        n >= 3 &&
        s.winRate >= 60 &&
        s.expectancyR >= 0 &&
        (s.setup.startsWith('CONT_') || s.setup.startsWith('PUMP_') || s.setup.startsWith('DUMP_'))
      ) {
        if (!boosted.includes(s.setup)) boosted.push(s.setup)
      }
      continue
    }
    // Block only the specific composite tag — never the whole base family
    if (s.winRate < 38 || s.expectancyR < -0.15) {
      if (!blocked.includes(s.setup)) blocked.push(s.setup)
      // Also block BASE_STYLE_ALIGN if journal stored bare-ish keys
      if (parsed.style && parsed.align) {
        const tag = `${parsed.base}_${parsed.style}_${parsed.align}`
        if (!blocked.includes(tag)) blocked.push(tag)
      }
    } else if (s.winRate >= 62 && s.expectancyR >= 0.25) {
      if (!boosted.includes(s.setup)) boosted.push(s.setup)
    }
  }

  const meme = analytics.byAlertType.find((x) => x.alertType === 'MEME')
  if (meme && meme.wins + meme.losses >= 8) {
    // Cap cold-streak floor — never silence healthy impulse tags
    if (meme.winRate < 42) minMemeScore = 66
    else if (meme.winRate < 50) minMemeScore = 64
    else if (meme.winRate >= 60) minMemeScore = 60
  }

  const sniper = analytics.byAlertType.find((x) => x.alertType === 'SNIPER')
  if (sniper && sniper.wins + sniper.losses >= 6) {
    // Floor stays scalp-friendly — never silence early moves
    if (sniper.winRate < 45) minSniperScore = 52
    else if (sniper.winRate >= 60) minSniperScore = 46
  }

  return {
    minMemeScore,
    minSniperScore,
    blockedSetups: blocked,
    boostedSetups: boosted,
    requireHighBrokenForSqueeze: false,
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
  // Only block specific tags (e.g. PUMP_SCALP_COUNTER), never blanket-silence a base like PUMP
  return gates.blockedSetups.some((b) => {
    if (b === compositeSetup) return true
    const pb = parseBotSetup(b)
    const pc = parseBotSetup(compositeSetup)
    if (!pb.style || !pc.style) return false
    if (pb.base !== pc.base || pb.base !== setupBase) return false
    // Same base+style+align
    if (pb.align && pc.align && pb.style === pc.style && pb.align === pc.align) {
      return true
    }
    // Blocked as BASE_STYLE (all aligns of that style)
    if (!pb.align && pb.style === pc.style) return true
    return false
  })
}

export function isSetupBoosted(
  gates: BotAdaptiveGates,
  setupBase: string,
  compositeSetup: string
): boolean {
  return gates.boostedSetups.some((b) => {
    if (b === compositeSetup) return true
    const pb = parseBotSetup(b)
    const pc = parseBotSetup(compositeSetup)
    if (pb.base !== setupBase && b !== setupBase) return false
    if (pb.base === pc.base && pb.style && pc.style && pb.style === pc.style) {
      if (!pb.align || pb.align === pc.align) return true
    }
    return b === setupBase
  })
}


async function recomputeAndSaveGates(env: Env): Promise<BotAdaptiveGates> {
  const list = await listJournal(env)
  const analytics = computeBotAnalytics(list)
  const gates = deriveAdaptiveGates(analytics)
  memoryGates = gates
  if (env.SUBSCRIBERS) {
    try {
      await env.SUBSCRIBERS.put(GATES_KEY, JSON.stringify(gates))
    } catch {
      // Adaptive gates remain available in memory for this runtime.
    }
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
  // Backfill autopsy for older rows that closed before the analyzer existed.
  const enriched = entries.slice(0, 160).map((e) =>
    e.status !== 'OPEN' && !e.outcomeHeadline
      ? attachOutcomeAnalysis(e, entries)
      : e
  )
  return {
    analytics,
    entries: enriched,
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

/** Historical WR for a setup from gates (0 if unknown / thin sample) */
export function setupHistoricalWr(
  gates: BotAdaptiveGates | null | undefined,
  setup: string
): { wr: number; n: number; avgR: number } {
  if (!gates?.winPctBySetup?.length) return { wr: 0, n: 0, avgR: 0 }
  const exact = gates.winPctBySetup.find((x) => x.setup === setup)
  if (exact) return { wr: exact.historicalWr, n: exact.sampleN, avgR: exact.avgR }
  // Prefix match CONT_BOOK_RELEASE vs BOOK_RELEASE
  const soft = gates.winPctBySetup.find(
    (x) => setup.startsWith(x.setup) || x.setup.startsWith(setup)
  )
  if (soft) return { wr: soft.historicalWr, n: soft.sampleN, avgR: soft.avgR }
  return { wr: 0, n: 0, avgR: 0 }
}

/**
 * Rank for meme emit: highest historical WR first.
 * Unknown setups get mid prior; known losers get 0.
 */
export function memeSetupRankScore(
  gates: BotAdaptiveGates | null | undefined,
  setup: string,
  conf: number
): number {
  const { wr, n, avgR } = setupHistoricalWr(gates, setup)
  let rank = conf
  // Hard priority: CONT_BOOK_RELEASE (journal best)
  if (setup === 'CONT_BOOK_RELEASE') rank += 18
  else if (setup.startsWith('CONT_')) rank += 8
  if (n >= 3) {
    rank += wr * 0.35
    rank += Math.max(-8, Math.min(8, avgR * 4))
    if (wr < 30) rank -= 40
    if (wr >= 60) rank += 12
  }
  if (gates && isSetupBoosted(gates, parseBotSetup(setup).base, setup)) {
    rank += 10
  }
  if (gates && isSetupBlocked(gates, parseBotSetup(setup).base, setup)) {
    rank -= 50
  }
  return rank
}

/** True if setup is among top historical WR meme families we want to hunt */
export function isHighWrMemeSetup(
  gates: BotAdaptiveGates | null | undefined,
  setup: string
): boolean {
  if (setup === 'CONT_BOOK_RELEASE') return true
  const { wr, n } = setupHistoricalWr(gates, setup)
  if (n >= 3 && wr >= 55) return true
  if (gates && isSetupBoosted(gates, parseBotSetup(setup).base, setup)) {
    return true
  }
  return false
}

export interface CorridorWrRow {
  key: string
  n: number
  wins: number
  losses: number
  winRate: number
  expectancyR: number
}

/** Aggregate WR by SCALP/INTRA/SWING × TREND/COUNTER (+ optional TF tag in setup) */
export function computeCorridorStats(
  entries: BotJournalEntry[]
): CorridorWrRow[] {
  const buckets = new Map<string, BotJournalEntry[]>()
  for (const e of entries) {
    const p = parseBotSetup(e.setup)
    const style = p.style ?? 'OTHER'
    const align = p.align ?? 'NA'
    const key = `${style}_${align}`
    const arr = buckets.get(key) ?? []
    arr.push(e)
    buckets.set(key, arr)
  }
  const rows: CorridorWrRow[] = []
  for (const [key, subset] of buckets) {
    const wins = subset.filter((e) => e.status === 'WIN').length
    const losses = subset.filter((e) => e.status === 'LOSS').length
    const decided = wins + losses
    if (decided < 1) continue
    const rs = subset
      .filter(
        (e) =>
          e.rMultiple != null && (e.status === 'WIN' || e.status === 'LOSS')
      )
      .map((e) => e.rMultiple!)
    const expectancyR =
      rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : 0
    rows.push({
      key,
      n: decided,
      wins,
      losses,
      winRate: (wins / decided) * 100,
      expectancyR,
    })
  }
  return rows.sort((a, b) => b.n - a.n)
}

export function formatCorridorWrReport(
  analytics: BotJournalAnalytics,
  entries: BotJournalEntry[],
  gates: BotAdaptiveGates
): string {
  const corridors = computeCorridorStats(entries)
  const lines: string[] = [
    `Журнал: ${analytics.resolved} закрытых · WR ${analytics.winRate.toFixed(0)}%`,
  ]
  if (corridors.length === 0) {
    lines.push('Коридоры: мало данных (нужно ≥1 закрытая сделка на тег)')
  } else {
    lines.push('WR по коридорам (#SCALP/#INTRA × #TREND/#COUNTER):')
    for (const c of corridors.slice(0, 8)) {
      const tag = c.key
        .replace('INTRADAY', 'INTRA')
        .replace('WITH_TREND', 'TREND')
        .replace('_', ' · ')
      lines.push(
        `  · ${tag}: ${c.winRate.toFixed(0)}% (${c.wins}W/${c.losses}L) E[R]=${c.expectancyR.toFixed(2)}`
      )
    }
  }
  if (gates.blockedSetups.length) {
    lines.push(
      `Режем слабые теги: ${gates.blockedSetups.slice(0, 6).join(', ')}${
        gates.blockedSetups.length > 6 ? '…' : ''
      }`
    )
  } else {
    lines.push('Заблокированных тегов пока нет')
  }
  if (gates.boostedSetups.length) {
    lines.push(`Буст сильных: ${gates.boostedSetups.slice(0, 4).join(', ')}`)
  }
  return lines.join('\n')
}
