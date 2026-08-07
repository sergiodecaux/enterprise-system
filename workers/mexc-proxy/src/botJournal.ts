/**
 * Journal of bot/cron scanner signals → outcomes for Lab + adaptive filters.
 * Persisted in Cloudflare KV, exposed to Mini App via HTTP.
 */
import { listPaperTrades, type PaperTrade } from './paperTrades'
import {
  analyzeTradeOutcome,
  type TradeOutcomeAnalysis,
} from './tradeOutcomeAnalysis'
import { kvPutThrottled } from './kvWrite'
import { attachPeakOutcome } from './peakDecisionLog'

/** Bump key + cache URL when wiping lab — old Cache must not resurrect stats */
const JOURNAL_KEY = 'telegram:bot_journal_v288'
/** Long-term closed trades for analysis (not pruned with live open book) */
const ARCHIVE_KEY = 'telegram:bot_journal_archive'
const GATES_KEY = 'telegram:bot_gates'
const MAX_ENTRIES = 500
const MAX_ARCHIVE = 1200
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

/** One timeline beat for later autopsy */
export interface BotJournalEvent {
  at: number
  kind: string
  detail: string
}

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
  resolveSource: 'AUTO' | 'TIMEOUT' | 'MANUAL' | null
  /** Paper / resolve close code: tp | sl | trail | dead_entry | … */
  closeReason?: string | null
  /** Immediate autopsy after resolve */
  outcomePrimaryTag?: string | null
  outcomeTags?: string[]
  outcomeHeadline?: string | null
  outcomeDetail?: string | null
  outcomeLesson?: string | null
  /** Why we entered (peak reasons etc.) — for error analysis */
  entryReasons?: string[] | null
  entryNotes?: string | null
  qualityTier?: 'A' | 'B' | null
  /** Engine / build that opened the trade */
  engineId?: string | null
  /** Linked paper companion id */
  paperId?: string | null
  /** true if entry TG was actually delivered (false → orphan result risk) */
  tgEntrySent?: boolean | null
  /** Hold duration ms after fill/create */
  holdMs?: number | null
  /** Snapshot of planned risk at entry (before paper adjusts) */
  initialSl?: number | null
  initialTp?: number | null
  /** Parsed helpers from entryReasons for filters */
  entryMeta?: {
    chg24hPct?: number | null
    distToHighPct?: number | null
    fuelScore?: number | null
    confidence?: number | null
  } | null
  /** Append-only timeline for analysis */
  events?: BotJournalEvent[]
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
  /** PEAK entry reason tags with toxic live WR — demote A→skip */
  peakAvoidReasons?: string[]
  /** PEAK reason tags that win more often */
  peakPreferReasons?: string[]
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
  entryReasons?: string[]
  entryNotes?: string
  qualityTier?: 'A' | 'B'
  engineId?: string
  paperId?: string
  tgEntrySent?: boolean
}

function parseEntryMeta(reasons: string[] | null | undefined): BotJournalEntry['entryMeta'] {
  if (!reasons?.length) return null
  const num = (prefix: string) => {
    const hit = reasons.find((r) => r.startsWith(prefix))
    if (!hit) return null
    const n = Number(hit.slice(prefix.length))
    return Number.isFinite(n) ? n : null
  }
  return {
    chg24hPct: num('chg24:'),
    distToHighPct: num('dist_high:'),
    fuelScore: num('fuel:'),
    confidence: num('conf:'),
  }
}

function pushEvent(
  entry: BotJournalEntry,
  kind: string,
  detail: string,
  at = Date.now()
): BotJournalEntry {
  const events = [...(entry.events ?? []), { at, kind, detail }].slice(-24)
  return { ...entry, events }
}

const memoryArchive: BotJournalEntry[] = []

async function listArchive(env: Env): Promise<BotJournalEntry[]> {
  if (memoryArchive.length) return [...memoryArchive]
  if (!env.SUBSCRIBERS) return []
  try {
    const raw = await env.SUBSCRIBERS.get(ARCHIVE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as BotJournalEntry[]
    if (!Array.isArray(parsed)) return []
    memoryArchive.length = 0
    memoryArchive.push(...parsed.slice(0, MAX_ARCHIVE))
    return [...memoryArchive]
  } catch {
    return []
  }
}

async function archiveClosedTrades(
  env: Env,
  closed: BotJournalEntry[]
): Promise<void> {
  if (!closed.length) return
  const arch = await listArchive(env)
  const ids = new Set(arch.map((e) => e.id))
  for (const e of closed) {
    if (e.status === 'OPEN' || ids.has(e.id)) continue
    // Prefer keeping PEAK + all decided meme/sniper for analysis
    arch.unshift(e)
    ids.add(e.id)
  }
  const trimmed = arch.slice(0, MAX_ARCHIVE)
  memoryArchive.length = 0
  memoryArchive.push(...trimmed)
  if (!env.SUBSCRIBERS) return
  try {
    // Archive writes are rarer — allow up to ~every 5m
    await kvPutThrottled(
      env.SUBSCRIBERS,
      ARCHIVE_KEY,
      JSON.stringify(trimmed),
      5 * 60_000
    )
  } catch {
    /* quota */
  }
}

interface Env {
  SUBSCRIBERS?: KVNamespace
}

const memoryJournal: BotJournalEntry[] = []

function journalCacheRequest(): Request {
  return new Request('https://enterprise-system-runtime.invalid/bot-journal-v288')
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
  // KV is source of truth — Cache-first resurrected wiped journals
  if (env.SUBSCRIBERS) {
    try {
      const raw = await env.SUBSCRIBERS.get(JOURNAL_KEY)
      if (raw != null) {
        const parsed = JSON.parse(raw) as BotJournalEntry[]
        if (Array.isArray(parsed)) {
          memoryJournal.length = 0
          memoryJournal.push(...parsed)
          await writeJournalCache(parsed)
          return [...parsed]
        }
      }
    } catch {
      /* fallthrough */
    }
  }
  const cached = await readJournalCache()
  if (cached) return cached
  return [...memoryJournal]
}

async function saveJournal(
  env: Env,
  list: BotJournalEntry[],
  checkpoint = false,
  forceKv = false
): Promise<void> {
  const trimmed = list
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_ENTRIES)
  memoryJournal.length = 0
  memoryJournal.push(...trimmed)
  await writeJournalCache(trimmed)
  if (!env.SUBSCRIBERS || (!checkpoint && !forceKv)) return
  if (forceKv) {
    await env.SUBSCRIBERS.put(JOURNAL_KEY, JSON.stringify(trimmed))
    return
  }
  // Free KV budget: checkpoint at most ~every 10m (Cache holds live journal)
  await kvPutThrottled(
    env.SUBSCRIBERS,
    JOURNAL_KEY,
    JSON.stringify(trimmed),
    10 * 60_000
  )
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
  // Meme journal: PEAK fuel short only
  if (input.alertType === 'MEME') {
    if (
      input.plan.setup !== 'PEAK_FUEL_FAIL' ||
      input.plan.side !== 'SHORT'
    ) {
      return null
    }
  }
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
  // Memes: block same symbol any side for 35m (WR hygiene).
  if (
    input.alertType === 'MEME' &&
    list.some(
      (e) =>
        e.alertType === 'MEME' &&
        e.symbol === input.plan.symbol &&
        nowGate - e.createdAt < 35 * 60_000
    )
  ) {
    return null
  }

  const now = Date.now()
  const memeImpulse = input.alertType === 'MEME'
  const reasons = input.plan.entryReasons ?? null
  let entry: BotJournalEntry = {
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
    entryReasons: reasons,
    entryNotes: input.plan.entryNotes ?? null,
    qualityTier: input.plan.qualityTier ?? null,
    engineId: input.plan.engineId ?? null,
    paperId: input.plan.paperId ?? null,
    tgEntrySent: input.plan.tgEntrySent ?? null,
    holdMs: null,
    initialSl: input.plan.sl,
    initialTp: input.plan.tp,
    entryMeta: parseEntryMeta(reasons),
    events: [],
  }
  entry = pushEvent(
    entry,
    'OPEN',
    [
      `${entry.side} ${entry.setup}`,
      `entry ${entry.entryPrice}`,
      `SL ${entry.sl} TP ${entry.tp}`,
      reasons?.length ? `reasons: ${reasons.slice(0, 10).join(' · ')}` : null,
      entry.qualityTier ? `Q${entry.qualityTier}` : null,
      entry.engineId ? `engine ${entry.engineId}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    now
  )

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
    exit = paper.sl
    const slPnl = pnlPct(entry.side, fill, exit)
    // Profit-lock BE only when exit is flat/tiny green — real stops stay LOSS
    status =
      Math.abs(slPnl) < 0.08 || (paper.beSent && slPnl >= -0.05 && slPnl < 0.25)
        ? 'BE'
        : 'LOSS'
  } else if (paper.closeReason === 'trail') {
    exit = paper.trailingStop ?? fill
    const pnl = pnlPct(entry.side, fill, exit)
    status = Math.abs(pnl) < 0.05 ? 'BE' : pnl > 0 ? 'WIN' : 'LOSS'
  } else if (
    paper.closeReason === 'invalidate' ||
    paper.closeReason === 'timeout_waiting' ||
    paper.closeReason === 'stale_entry'
  ) {
    status = 'INVALIDATED'
  } else if (
    paper.closeReason === 'dead_entry' ||
    paper.closeReason === 'timeout_open' ||
    paper.closeReason === 'time_stop'
  ) {
    // Cut losers / time-outs were TIMEOUT and inflated WR — count as LOSS if red
    exit = paper.trailingStop ?? paper.peak ?? fill
    // Prefer last known adverse: use SL distance proxy when peak never moved
    if (paper.closeReason === 'dead_entry') {
      exit = fill // ~flat cut; still LOSS for hygiene
      status = 'LOSS'
    } else {
      const pnl = pnlPct(entry.side, fill, exit)
      status = pnl < -0.05 ? 'LOSS' : Math.abs(pnl) < 0.05 ? 'BE' : 'TIMEOUT'
    }
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
    entryReasons: entry.entryReasons ?? null,
    qualityTier: entry.qualityTier ?? null,
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
  const peakResolved: BotJournalEntry[] = []

  const pushOutcome = (prev: BotJournalEntry, next: BotJournalEntry) => {
    let analyzed = attachOutcomeAnalysis(next, list)
    if (prev.status === 'OPEN' && analyzed.status !== 'OPEN') {
      const start = analyzed.filledAt ?? analyzed.createdAt
      const holdMs =
        analyzed.resolvedAt != null ? analyzed.resolvedAt - start : null
      const paper = matchingPaper(analyzed, papers)
      analyzed = {
        ...analyzed,
        holdMs,
        paperId: analyzed.paperId ?? paper?.id ?? null,
        entryMeta: analyzed.entryMeta ?? parseEntryMeta(analyzed.entryReasons),
      }
      analyzed = pushEvent(
        analyzed,
        'CLOSE',
        [
          analyzed.status,
          analyzed.closeReason ? `via ${analyzed.closeReason}` : null,
          analyzed.pnlPercent != null
            ? `pnl ${analyzed.pnlPercent >= 0 ? '+' : ''}${analyzed.pnlPercent.toFixed(2)}%`
            : null,
          `MFE +${analyzed.mfePercent.toFixed(2)}% MAE −${analyzed.maePercent.toFixed(2)}%`,
          analyzed.outcomePrimaryTag,
          holdMs != null ? `hold ${Math.round(holdMs / 1000)}s` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        analyzed.resolvedAt ?? now
      )
      if (
        analyzed.setup === 'PEAK_FUEL_FAIL' ||
        analyzed.setup === 'DUMP_FUEL_FAIL' ||
        analyzed.setup === 'PUMP_CONTINUE'
      )
        peakResolved.push(analyzed)
      if (
        prev.createdAt >= RESULT_NOTIFICATIONS_SINCE
      ) {
        outcomes.push(analyzed)
      }
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
      // Last-price resolve can overshoot SL by 10%+ after a gap — clamp to planned SL
      let exit = price
      if (status === 'LOSS' && closeReason === 'sl') {
        exit = working.sl
      } else if (status === 'WIN' && closeReason === 'tp') {
        exit = working.tp
      }
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

  // Persist closed trades into long-term archive for analysis
  if (outcomes.length || peakResolved.length) {
    const toArch = [
      ...outcomes,
      ...peakResolved.filter((p) => !outcomes.some((o) => o.id === p.id)),
    ]
    // Also archive any newly closed rows still on the live list
    const closedNow = list.filter(
      (e) => e.status !== 'OPEN' && e.resolvedAt && now - e.resolvedAt < 15 * 60_000
    )
    await archiveClosedTrades(env, [...toArch, ...closedNow])
  }

  // Refresh adaptive gates after resolves
  if (changed > 0) {
    await recomputeAndSaveGates(env)
  }

  // Link peak decision log ↔ journal outcomes for autopsy
  for (const o of peakResolved) {
    try {
      await attachPeakOutcome(env.SUBSCRIBERS, {
        symbol: o.symbol,
        createdAt: o.createdAt,
        status: o.status,
        pnlPercent: o.pnlPercent,
        closeReason: o.closeReason ?? null,
        lesson: o.outcomeLesson ?? null,
      })
    } catch {
      /* best-effort */
    }
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
  analytics: BotJournalAnalytics,
  entries: BotJournalEntry[] = []
): BotAdaptiveGates {
  const blocked: string[] = []
  const boosted: string[] = []
  let minMemeScore = 58
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
        s.setup === 'ABSORPTION' ||
        s.setup.startsWith('TRAP_'))
    if (earlyBlock) {
      if (!blocked.includes(s.setup)) blocked.push(s.setup)
      continue
    }
    // Never block PEAK — capacity goes here; learn reason hygiene from outcomes
    if (s.setup === 'PEAK_FUEL_FAIL') {
      if (n >= 3 && s.winRate >= 55) {
        if (!boosted.includes(s.setup)) boosted.push(s.setup)
      }
      // Soft score nudge from PEAK sample (used by scanner gates)
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

  // Meme bot = PEAK SHORT only — calibrate floor from PEAK sample, never dual LONG noise
  const peak = analytics.bySetup.find((x) => x.setup === 'PEAK_FUEL_FAIL')
  if (peak) {
    const decided = peak.wins + peak.losses
    const wr = peak.winRate
    if (decided >= 5) {
      if (wr < 42) minMemeScore = 62
      else if (wr < 50) minMemeScore = 60
      else if (wr >= 60) minMemeScore = 56
    }
  }

  const sniper = analytics.byAlertType.find((x) => x.alertType === 'SNIPER')
  if (sniper && sniper.wins + sniper.losses >= 6) {
    // Floor stays scalp-friendly — never silence early moves
    if (sniper.winRate < 45) minSniperScore = 52
    else if (sniper.winRate >= 60) minSniperScore = 46
  }

  const { avoid: peakAvoidReasons, prefer: peakPreferReasons } =
    learnPeakReasonTags(entries)

  return {
    minMemeScore,
    minSniperScore,
    blockedSetups: blocked,
    boostedSetups: boosted,
    requireHighBrokenForSqueeze: false,
    winPctBySetup: buildWinPctCalibration(analytics),
    peakAvoidReasons,
    peakPreferReasons,
    updatedAt: Date.now(),
    sampleSize: analytics.resolved,
  }
}

/** Learn which PEAK entry reason tags lose / win in live journal. */
function learnPeakReasonTags(entries: BotJournalEntry[]): {
  avoid: string[]
  prefer: string[]
} {
  const peak = entries.filter(
    (e) =>
      e.setup === 'PEAK_FUEL_FAIL' &&
      (e.status === 'WIN' || e.status === 'LOSS') &&
      (e.entryReasons?.length ?? 0) > 0
  )
  const map = new Map<string, { w: number; l: number }>()
  for (const e of peak) {
    for (const raw of e.entryReasons ?? []) {
      const tag = raw.includes(':') ? raw.split(':')[0]! : raw
      if (
        tag === 'quality' ||
        tag === 'fuel' ||
        tag === 'conf' ||
        tag === 'chg24' ||
        tag === 'dist_high' ||
        tag === 'realFuel'
      ) {
        continue
      }
      const row = map.get(tag) ?? { w: 0, l: 0 }
      if (e.status === 'WIN') row.w++
      else row.l++
      map.set(tag, row)
    }
  }
  const avoid: string[] = []
  const prefer: string[] = []
  for (const [tag, s] of map) {
    const n = s.w + s.l
    if (n < 4) continue
    const wr = (100 * s.w) / n
    if (wr < 35) avoid.push(tag)
    if (wr >= 60) prefer.push(tag)
  }
  return { avoid, prefer }
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
  const gates = deriveAdaptiveGates(analytics, list)
  memoryGates = gates
  if (env.SUBSCRIBERS) {
    await kvPutThrottled(
      env.SUBSCRIBERS,
      GATES_KEY,
      JSON.stringify(gates),
      30 * 60_000
    )
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
  archive?: BotJournalEntry[]
  archiveCount?: number
}> {
  const entries = await listJournal(env)
  const analytics = computeBotAnalytics(entries)
  const gates = await getAdaptiveGates(env)
  // Backfill autopsy for older rows that closed before the analyzer existed.
  const enriched = entries.slice(0, 200).map((e) =>
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

/**
 * Archive all PEAK rows, clear them from live journal, recompute gates.
 * Starts a clean honest-WR window after paper/accounting fixes.
 */
export async function resetPeakJournalLive(env: Env): Promise<{
  archived: number
  remaining: number
  gates: BotAdaptiveGates
}> {
  const list = await listJournal(env)
  const peak = list.filter((e) => e.setup === 'PEAK_FUEL_FAIL')
  const keep = list.filter((e) => e.setup !== 'PEAK_FUEL_FAIL')
  if (peak.length) {
    await archiveClosedTrades(
      env,
      peak.map((e) =>
        e.status === 'OPEN'
          ? {
              ...e,
              status: 'INVALIDATED' as const,
              resolvedAt: Date.now(),
              closeReason: 'reset_epoch',
              resolveSource: 'MANUAL' as const,
              pnlPercent: 0,
              rMultiple: 0,
            }
          : e
      )
    )
  }
  await saveJournal(env, keep, true, true)
  const gates = await recomputeAndSaveGates(env)
  return { archived: peak.length, remaining: keep.length, gates }
}

/**
 * Full clean slate for PEAK SHORT lab: wipe live meme PEAK + archive PEAK
 * + gates (recomputed empty). SNIPER rows stay.
 */
export async function resetAllPeakStats(env: Env): Promise<{
  liveRemoved: number
  archiveRemoved: number
  gates: BotAdaptiveGates
}> {
  const list = await listJournal(env)
  const keepLive = list.filter(
    (e) => !(e.alertType === 'MEME' || e.setup === 'PEAK_FUEL_FAIL')
  )
  const liveRemoved = list.length - keepLive.length
  await saveJournal(env, keepLive, true, true)

  const arch = await listArchive(env)
  const keepArch = arch.filter(
    (e) => !(e.alertType === 'MEME' || e.setup === 'PEAK_FUEL_FAIL')
  )
  const archiveRemoved = arch.length - keepArch.length
  memoryArchive.length = 0
  memoryArchive.push(...keepArch.slice(0, MAX_ARCHIVE))
  if (env.SUBSCRIBERS) {
    await env.SUBSCRIBERS.put(ARCHIVE_KEY, JSON.stringify(memoryArchive))
  }

  memoryGates = null
  const gates = await recomputeAndSaveGates(env)
  return { liveRemoved, archiveRemoved, gates }
}

/** Full analysis dump: live + archive, optional setup filter. */
export async function getJournalAnalysisDump(
  env: Env,
  opts?: { setup?: string; limit?: number; includeArchive?: boolean }
): Promise<{
  ok: true
  live: BotJournalEntry[]
  archive: BotJournalEntry[]
  merged: BotJournalEntry[]
  analytics: BotJournalAnalytics
  peakSummary?: {
    alerts: number
    skips: number
    alertWins: number
    alertLosses: number
    topSkipReasons: Array<{ reason: string; n: number }>
  }
  peakDecisions?: Array<Record<string, unknown>>
}> {
  const live = await listJournal(env)
  const archive = opts?.includeArchive === false ? [] : await listArchive(env)
  const byId = new Map<string, BotJournalEntry>()
  for (const e of [...archive, ...live]) byId.set(e.id, e)
  let merged = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt)
  if (opts?.setup) {
    merged = merged.filter((e) => e.setup === opts.setup)
  }
  const limit = opts?.limit ?? 400
  merged = merged.slice(0, limit)
  const analytics = computeBotAnalytics(opts?.setup ? merged : [...live])
  return {
    ok: true,
    live: live.slice(0, 200),
    archive: archive.slice(0, limit),
    merged,
    analytics,
  }
}

export function journalToCsv(rows: BotJournalEntry[]): string {
  const header = [
    'id',
    'createdAt',
    'resolvedAt',
    'holdMs',
    'symbol',
    'side',
    'setup',
    'alertType',
    'qualityTier',
    'status',
    'score',
    'entryPrice',
    'exitPrice',
    'sl',
    'tp',
    'pnlPercent',
    'rMultiple',
    'mfePercent',
    'maePercent',
    'closeReason',
    'outcomePrimaryTag',
    'outcomeLesson',
    'entryReasons',
    'entryNotes',
    'engineId',
    'paperId',
    'chg24',
    'distHigh',
    'fuel',
  ]
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return `"${s.replace(/"/g, '""')}"`
  }
  const lines = [header.join(',')]
  for (const e of rows) {
    lines.push(
      [
        e.id,
        e.createdAt,
        e.resolvedAt ?? '',
        e.holdMs ?? '',
        e.symbol,
        e.side,
        e.setup,
        e.alertType,
        e.qualityTier ?? '',
        e.status,
        e.score,
        e.entryPrice,
        e.exitPrice ?? '',
        e.sl,
        e.tp,
        e.pnlPercent ?? '',
        e.rMultiple ?? '',
        e.mfePercent,
        e.maePercent,
        e.closeReason ?? '',
        e.outcomePrimaryTag ?? '',
        e.outcomeLesson ?? '',
        (e.entryReasons ?? []).join('|'),
        e.entryNotes ?? '',
        e.engineId ?? '',
        e.paperId ?? '',
        e.entryMeta?.chg24hPct ?? '',
        e.entryMeta?.distToHighPct ?? '',
        e.entryMeta?.fuelScore ?? '',
      ]
        .map(esc)
        .join(',')
    )
  }
  return lines.join('\n')
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
  if (setup !== 'PEAK_FUEL_FAIL') return 0
  const { wr, n, avgR } = setupHistoricalWr(gates, setup)
  let rank = conf + 20
  if (n >= 3) {
    rank += wr * 0.35
    rank += Math.max(-8, Math.min(8, avgR * 4))
    if (wr < 30) rank -= 40
    if (wr >= 60) rank += 12
  }
  if (gates && isSetupBoosted(gates, parseBotSetup(setup).base, setup)) {
    rank += 10
  }
  return rank
}

/** True if setup is the live meme hunt (PEAK SHORT only) */
export function isHighWrMemeSetup(
  _gates: BotAdaptiveGates | null | undefined,
  setup: string
): boolean {
  return setup === 'PEAK_FUEL_FAIL'
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

/** PEAK SHORT-only stats for meme /status and /journal */
export function formatPeakShortStatsReport(
  entries: BotJournalEntry[],
  gates: BotAdaptiveGates
): string {
  const peak = entries.filter(
    (e) => e.setup === 'PEAK_FUEL_FAIL' && e.side === 'SHORT'
  )
  const wins = peak.filter((e) => e.status === 'WIN')
  const losses = peak.filter((e) => e.status === 'LOSS')
  const open = peak.filter((e) => e.status === 'OPEN')
  const decided = wins.length + losses.length
  const wr = decided > 0 ? (100 * wins.length) / decided : 0
  const rs = peak
    .filter(
      (e) =>
        e.rMultiple != null && (e.status === 'WIN' || e.status === 'LOSS')
    )
    .map((e) => e.rMultiple!)
  const avgR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0
  const pnls = peak
    .filter(
      (e) =>
        e.pnlPercent != null && (e.status === 'WIN' || e.status === 'LOSS')
    )
    .map((e) => e.pnlPercent!)
  const avgPnl = pnls.length
    ? pnls.reduce((a, b) => a + b, 0) / pnls.length
    : 0
  const lines: string[] = [
    `<b>PEAK SHORT · своя статистика</b>`,
    decided
      ? `WR ${wr.toFixed(0)}% · ${wins.length}W/${losses.length}L · E[R]=${avgR.toFixed(2)} · avg PnL ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%`
      : `Закрытых пока нет — копим с нуля (open ${open.length})`,
    `Открыто: ${open.length} · порог score ≥${gates.minMemeScore}`,
  ]
  if (gates.peakPreferReasons?.length) {
    lines.push(
      `Учит + : ${gates.peakPreferReasons.slice(0, 4).join(', ')}`
    )
  }
  if (gates.peakAvoidReasons?.length) {
    lines.push(
      `Учит − : ${gates.peakAvoidReasons.slice(0, 4).join(', ')}`
    )
  }
  return lines.join('\n')
}

/**
 * Archive non-PEAK meme rows from live journal so PEAK keeps a clean book.
 * SNIPER / Elite rows untouched.
 */
export async function purgeNonPeakMemeJournal(env: Env): Promise<number> {
  const list = await listJournal(env)
  const drop = list.filter(
    (e) =>
      e.alertType === 'MEME' &&
      (e.setup !== 'PEAK_FUEL_FAIL' || e.side !== 'SHORT')
  )
  if (!drop.length) return 0
  const keep = list.filter(
    (e) =>
      e.alertType !== 'MEME' ||
      (e.setup === 'PEAK_FUEL_FAIL' && e.side === 'SHORT')
  )
  await archiveClosedTrades(
    env,
    drop.map((e) =>
      e.status === 'OPEN'
        ? {
            ...e,
            status: 'INVALIDATED' as const,
            resolvedAt: Date.now(),
            closeReason: 'non_peak_purged',
            resolveSource: 'MANUAL' as const,
            pnlPercent: 0,
            rMultiple: 0,
          }
        : e
    )
  )
  await saveJournal(env, keep, true, true)
  await recomputeAndSaveGates(env)
  return drop.length
}

export function formatCorridorWrReport(
  analytics: BotJournalAnalytics,
  entries: BotJournalEntry[],
  gates: BotAdaptiveGates
): string {
  const peak = entries.filter(
    (e) => e.setup === 'PEAK_FUEL_FAIL' && e.side === 'SHORT'
  )
  if (peak.length) {
    return formatPeakShortStatsReport(entries, gates)
  }
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
