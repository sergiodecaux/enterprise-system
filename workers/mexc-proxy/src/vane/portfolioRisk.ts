import { VANE_RISK_KEY, type Side, type VaneKv, type VaneTier } from './types'

export interface VanePortfolioRisk {
  dayKey: string
  equityUsd: number
  dayPnlPct: number
  consecutiveLosses: number
  pausedUntil: number | null
  openSymbols: string[]
  openSides: Partial<Record<string, Side>>
  updatedAt: number
}

const MAX_OPEN = 3
const MAX_CORR_ALT_LONGS = 2
const DAY_LOSS_PCT = -3
const LOSS_STREAK = 2

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

function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

export function vaneTradingPaused(risk: VanePortfolioRisk): {
  paused: boolean
  reason?: string
} {
  if (risk.pausedUntil != null && Date.now() < risk.pausedUntil) {
    return { paused: true, reason: 'circuit breaker до UTC midnight' }
  }
  return { paused: false }
}

const HIGH_BETA_ALTS = new Set([
  'SOL_USDT',
  'AVAX_USDT',
  'NEAR_USDT',
  'ADA_USDT',
  'DOT_USDT',
  'SUI_USDT',
  'APT_USDT',
  'LINK_USDT',
  'ATOM_USDT',
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

  if (opts.side === 'LONG' && opts.symbol !== 'BTC_USDT') {
    const corrLongs = open.filter(
      (s) =>
        HIGH_BETA_ALTS.has(s) &&
        opts.risk.openSides[s] === 'LONG' &&
        s !== 'BTC_USDT' &&
        s !== 'ETH_USDT'
    )
    if (
      HIGH_BETA_ALTS.has(opts.symbol) &&
      corrLongs.length >= MAX_CORR_ALT_LONGS
    ) {
      return {
        ok: false,
        reason: `correlation: уже ${corrLongs.length} alt LONGs`,
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
    next.pausedUntil = nextUtcMidnight()
  }
  return next
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
