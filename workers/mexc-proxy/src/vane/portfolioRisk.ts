import { VANE_RISK_KEY, type Side, type VaneKv, type VaneTier } from './types'

export interface VanePortfolioRisk {
  dayKey: string
  equityUsd: number
  dayPnlPct: number
  consecutiveLosses: number
  pausedUntil: number | null
  pauseReason?: string | null
  openSymbols: string[]
  openSides: Partial<Record<string, Side>>
  updatedAt: number
}

const MAX_OPEN = 3
/** Max concurrent LONGs in the ETH/SOL/AVAX-style cluster */
const MAX_CORR_CLUSTER_LONGS = 2
const DAY_LOSS_PCT = -4
/** Was 2 — half-day silence after two quick LOSS */
const LOSS_STREAK = 3
/** Was until UTC midnight — now 3h cool-off */
const PAUSE_MS = 3 * 60 * 60_000

function utcDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function defaultVaneRisk(): VanePortfolioRisk {
  return {
    dayKey: utcDayKey(),
    equityUsd: 10_000,
    dayPnlPct: 0,
    consecutiveLosses: 0,
    pausedUntil: null,
    pauseReason: null,
    openSymbols: [],
    openSides: {},
    updatedAt: Date.now(),
  }
}

export async function loadVaneRisk(
  kv: VaneKv | undefined
): Promise<VanePortfolioRisk> {
  if (!kv) return defaultVaneRisk()
  const raw = await kv.get(VANE_RISK_KEY)
  if (!raw) return defaultVaneRisk()
  try {
    const r = JSON.parse(raw) as VanePortfolioRisk
    const day = utcDayKey()
    if (r.dayKey !== day) {
      return {
        ...defaultVaneRisk(),
        equityUsd: r.equityUsd,
        dayKey: day,
      }
    }
    return r
  } catch {
    return defaultVaneRisk()
  }
}

/** Cap legacy "until midnight" pauses to 3h remaining */
export function normalizeVanePause(
  risk: VanePortfolioRisk
): VanePortfolioRisk {
  if (risk.pausedUntil == null) return risk
  const left = risk.pausedUntil - Date.now()
  if (left <= 0) {
    return { ...risk, pausedUntil: null, pauseReason: null }
  }
  if (left > PAUSE_MS + 60_000) {
    return {
      ...risk,
      pausedUntil: Date.now() + PAUSE_MS,
      pauseReason:
        risk.pauseReason ??
        `legacy pause урезан до ${PAUSE_MS / 3600_000}ч`,
    }
  }
  return risk
}

export async function saveVaneRisk(
  kv: VaneKv | undefined,
  risk: VanePortfolioRisk
): Promise<void> {
  if (!kv) return
  try {
    await kv.put(VANE_RISK_KEY, JSON.stringify({ ...risk, updatedAt: Date.now() }))
  } catch {
    /* quota */
  }
}

export function vaneTradingPaused(risk: VanePortfolioRisk): {
  paused: boolean
  reason?: string
  remainingMs?: number
} {
  if (risk.pausedUntil != null && Date.now() < risk.pausedUntil) {
    return {
      paused: true,
      reason:
        risk.pauseReason ??
        `circuit breaker ещё ${Math.ceil((risk.pausedUntil - Date.now()) / 60_000)}м`,
      remainingMs: risk.pausedUntil - Date.now(),
    }
  }
  return { paused: false }
}

/**
 * Correlated majors — block 3rd simultaneous LONG in this cluster.
 * ETH was previously excluded → ETH+SOL+AVAX all LONGs slipped through.
 */
const CORR_LONG_CLUSTER = new Set([
  'ETH_USDT',
  'SOL_USDT',
  'AVAX_USDT',
  'BNB_USDT',
  'NEAR_USDT',
  'ADA_USDT',
  'DOT_USDT',
  'SUI_USDT',
  'APT_USDT',
  'LINK_USDT',
  'ATOM_USDT',
  'DOGE_USDT',
])

export function canOpenVanePosition(opts: {
  risk: VanePortfolioRisk
  symbol: string
  side: Side
  tier: VaneTier
}): { ok: boolean; reason?: string } {
  const pause = vaneTradingPaused(opts.risk)
  if (pause.paused) return { ok: false, reason: pause.reason }

  const open = opts.risk.openSymbols.filter(Boolean)
  if (open.length >= MAX_OPEN) {
    return { ok: false, reason: `max ${MAX_OPEN} vane позиций` }
  }
  if (open.includes(opts.symbol)) {
    return { ok: false, reason: 'уже есть позиция по символу' }
  }

  if (opts.side === 'LONG' && CORR_LONG_CLUSTER.has(opts.symbol)) {
    const corrLongs = open.filter(
      (s) =>
        CORR_LONG_CLUSTER.has(s) && opts.risk.openSides[s] === 'LONG'
    )
    if (corrLongs.length >= MAX_CORR_CLUSTER_LONGS) {
      return {
        ok: false,
        reason: `correlation: уже ${corrLongs.length} cluster LONGs (${corrLongs
          .map((s) => s.replace('_USDT', ''))
          .join(',')})`,
      }
    }
  }

  return { ok: true }
}

export function applyVaneOutcome(
  risk: VanePortfolioRisk,
  opts: { symbol: string; pnlPct: number; isLoss: boolean }
): VanePortfolioRisk {
  const next: VanePortfolioRisk = {
    ...risk,
    openSymbols: risk.openSymbols.filter((s) => s !== opts.symbol),
    openSides: { ...risk.openSides },
    dayPnlPct: risk.dayPnlPct + opts.pnlPct,
    consecutiveLosses: opts.isLoss ? risk.consecutiveLosses + 1 : 0,
    updatedAt: Date.now(),
  }
  delete next.openSides[opts.symbol]

  const trip =
    next.consecutiveLosses >= LOSS_STREAK || next.dayPnlPct <= DAY_LOSS_PCT
  if (trip) {
    next.pausedUntil = Date.now() + PAUSE_MS
    next.pauseReason =
      next.consecutiveLosses >= LOSS_STREAK
        ? `пауза ${PAUSE_MS / 3600_000}ч: ${LOSS_STREAK} LOSS подряд`
        : `пауза ${PAUSE_MS / 3600_000}ч: день ${next.dayPnlPct.toFixed(1)}% ≤ ${DAY_LOSS_PCT}%`
  }
  return next
}

/** Drop symbol from open book without counting PnL (WAIT timeout / invalidate) */
export function unregisterVaneSymbol(
  risk: VanePortfolioRisk,
  symbol: string
): VanePortfolioRisk {
  if (!risk.openSymbols.includes(symbol)) return risk
  const openSides = { ...risk.openSides }
  delete openSides[symbol]
  return {
    ...risk,
    openSymbols: risk.openSymbols.filter((s) => s !== symbol),
    openSides,
    updatedAt: Date.now(),
  }
}

/**
 * Rebuild open book from live paper — fixes stuck slots after WAIT timeout
 * (previously openSymbols never cleared → silent half-day).
 */
export function syncVaneOpenFromPapers(
  risk: VanePortfolioRisk,
  papers: Array<{
    symbol: string
    side: Side
    alertType: string
    status: string
  }>
): VanePortfolioRisk {
  const active = papers.filter(
    (t) =>
      t.alertType === 'SNIPER' &&
      (t.status === 'WAITING' || t.status === 'OPEN')
  )
  const openSymbols = active.map((t) => t.symbol)
  const openSides: Partial<Record<string, Side>> = {}
  for (const t of active) openSides[t.symbol] = t.side
  return {
    ...risk,
    openSymbols,
    openSides,
    updatedAt: Date.now(),
  }
}

export function registerVaneOpen(
  risk: VanePortfolioRisk,
  symbol: string,
  side: Side
): VanePortfolioRisk {
  if (risk.openSymbols.includes(symbol)) return risk
  return {
    ...risk,
    openSymbols: [...risk.openSymbols, symbol],
    openSides: { ...risk.openSides, [symbol]: side },
    updatedAt: Date.now(),
  }
}
