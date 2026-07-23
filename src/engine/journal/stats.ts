import type {
  ConfidenceBucketStats,
  ImprovementInsight,
  JournalAnalytics,
  JournalOutcome,
  JournalSource,
  SetupStats,
  SignalJournalEntry,
  JournalSetupType,
} from './types'
import { SETUP_LABELS } from './classify'

const RESOLVED: JournalOutcome[] = ['WIN', 'LOSS', 'TIMEOUT', 'MANUAL', 'INVALIDATED']

function isResolved(e: SignalJournalEntry): boolean {
  return RESOLVED.includes(e.status)
}

function isWin(e: SignalJournalEntry): boolean {
  return e.status === 'WIN' || (e.status === 'MANUAL' && (e.pnlPercent ?? 0) > 0)
}

function isLoss(e: SignalJournalEntry): boolean {
  return (
    e.status === 'LOSS' ||
    e.status === 'INVALIDATED' ||
    (e.status === 'MANUAL' && (e.pnlPercent ?? 0) <= 0)
  )
}

function avg(nums: number[]): number {
  if (!nums.length) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function buildSetupStats(
  entries: SignalJournalEntry[],
  setupType: JournalSetupType
): SetupStats {
  const subset = entries.filter((e) => e.setupType === setupType)
  const resolved = subset.filter(isResolved)
  const wins = subset.filter(isWin)
  const losses = subset.filter(isLoss)
  const timeouts = subset.filter((e) => e.status === 'TIMEOUT')
  const open = subset.filter((e) => e.status === 'OPEN')
  const withR = resolved.filter((e) => e.rMultiple != null)
  const winRate =
    wins.length + losses.length > 0
      ? (wins.length / (wins.length + losses.length)) * 100
      : 0
  const avgR = avg(withR.map((e) => e.rMultiple!))
  const avgWinR = avg(wins.filter((e) => e.rMultiple != null).map((e) => e.rMultiple!))
  const avgLossR = avg(
    losses.filter((e) => e.rMultiple != null).map((e) => Math.abs(e.rMultiple!))
  )
  const wr = winRate / 100
  const expectancyR = wr * avgWinR - (1 - wr) * avgLossR

  return {
    setupType,
    total: subset.length,
    wins: wins.length,
    losses: losses.length,
    timeouts: timeouts.length,
    open: open.length,
    winRate,
    avgR,
    avgPnl: avg(resolved.filter((e) => e.pnlPercent != null).map((e) => e.pnlPercent!)),
    avgConfidence: avg(subset.map((e) => e.confidenceAtSignal)),
    avgMfe: avg(subset.map((e) => e.mfePercent)),
    avgMae: avg(subset.map((e) => e.maePercent)),
    expectancyR: Number.isFinite(expectancyR) ? expectancyR : 0,
  }
}

function buildInsights(
  bySetup: SetupStats[],
  byConfidence: ConfidenceBucketStats[],
  overall: { winRate: number; resolved: number }
): ImprovementInsight[] {
  const insights: ImprovementInsight[] = []
  const scored = bySetup.filter((s) => s.wins + s.losses >= 5)

  for (const s of scored) {
    const label = SETUP_LABELS[s.setupType]
    if (s.winRate < 40 && s.expectancyR < 0) {
      insights.push({
        id: `weak-${s.setupType}`,
        severity: 'HIGH',
        setupType: s.setupType,
        title: `${label}: слабая отработка ${s.winRate.toFixed(0)}%`,
        detail: `WR ${s.winRate.toFixed(0)}% · E[R]=${s.expectancyR.toFixed(2)} · avg MAE ${s.avgMae.toFixed(1)}%. Ужесточи фильтры или отключи сетап.`,
      })
    } else if (s.winRate >= 65 && s.expectancyR > 0.3) {
      insights.push({
        id: `strong-${s.setupType}`,
        severity: 'POSITIVE',
        setupType: s.setupType,
        title: `${label}: сильный край ${s.winRate.toFixed(0)}%`,
        detail: `WR ${s.winRate.toFixed(0)}% · E[R]=${s.expectancyR.toFixed(2)}. Можно повышать размер / приоритет в сканере.`,
      })
    }

    if (s.avgMae > s.avgMfe * 0.85 && s.losses >= 3) {
      insights.push({
        id: `mae-${s.setupType}`,
        severity: 'MEDIUM',
        setupType: s.setupType,
        title: `${label}: большой откат до цели`,
        detail: `MAE ${s.avgMae.toFixed(1)}% ≈ MFE ${s.avgMfe.toFixed(1)}%. Ранний БУ или тесный стоп выбивает — проверь ATR-буфер / Time-Delay BE.`,
      })
    }

    if (s.avgConfidence >= 70 && s.winRate < 45) {
      insights.push({
        id: `conf-lie-${s.setupType}`,
        severity: 'HIGH',
        setupType: s.setupType,
        title: `${label}: высокая уверенность врёт`,
        detail: `Avg confidence ${s.avgConfidence.toFixed(0)}% при WR ${s.winRate.toFixed(0)}%. Effort-vs-Result / Triple Filter недожимают этот сетап.`,
      })
    }
  }

  const buckets = byConfidence.filter((b) => b.total >= 5)
  for (const b of buckets) {
    if (b.max <= 75 && b.winRate < 45) {
      insights.push({
        id: `bucket-${b.label}`,
        severity: 'MEDIUM',
        title: `Порог ${b.label}: WR ${b.winRate.toFixed(0)}%`,
        detail: `Сигналы с confidence ${b.label} отрабатывают слабо. Подними approve-порог выше ${b.max}%.`,
      })
    }
    if (b.min >= 85 && b.winRate >= 60) {
      insights.push({
        id: `elite-${b.label}`,
        severity: 'POSITIVE',
        title: `Элита ${b.label} работает`,
        detail: `WR ${b.winRate.toFixed(0)}% · avg R ${b.avgR.toFixed(2)}. Фокус сканера на score ≥ ${b.min}.`,
      })
    }
  }

  if (overall.resolved < 10) {
    insights.push({
      id: 'sample-small',
      severity: 'LOW',
      title: 'Мало статистики',
      detail: `Всего ${overall.resolved} закрытых сигналов. Нужно ≥20–30 для надёжных выводов — оставь радар включённым.`,
    })
  }

  const order = { HIGH: 0, MEDIUM: 1, LOW: 2, POSITIVE: 3 }
  return insights.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 12)
}

export function computeJournalAnalytics(
  entries: SignalJournalEntry[]
): JournalAnalytics {
  const resolved = entries.filter(isResolved)
  const wins = entries.filter(isWin)
  const losses = entries.filter(isLoss)
  const timeouts = entries.filter((e) => e.status === 'TIMEOUT')
  const open = entries.filter((e) => e.status === 'OPEN')
  const decided = wins.length + losses.length
  const winRate = decided > 0 ? (wins.length / decided) * 100 : 0

  const withR = resolved.filter((e) => e.rMultiple != null)
  const avgR = avg(withR.map((e) => e.rMultiple!))
  const avgWinR = avg(wins.filter((e) => e.rMultiple != null).map((e) => e.rMultiple!))
  const avgLossAbs = avg(
    losses.filter((e) => e.rMultiple != null).map((e) => Math.abs(e.rMultiple!))
  )
  const wr = winRate / 100
  const expectancyR = decided > 0 ? wr * avgWinR - (1 - wr) * avgLossAbs : 0

  const grossWin = wins
    .filter((e) => e.pnlPercent != null && e.pnlPercent > 0)
    .reduce((s, e) => s + (e.pnlPercent ?? 0), 0)
  const grossLoss = Math.abs(
    losses
      .filter((e) => e.pnlPercent != null && e.pnlPercent < 0)
      .reduce((s, e) => s + (e.pnlPercent ?? 0), 0)
  )
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0

  const setupTypes = Array.from(new Set(entries.map((e) => e.setupType)))
  const bySetup = setupTypes
    .map((t) => buildSetupStats(entries, t))
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total)

  const sources: JournalSource[] = ['MEME', 'SNIPER', 'SMC', 'MANUAL']
  const bySource = sources
    .map((source) => {
      const subset = entries.filter((e) => e.source === source)
      const w = subset.filter(isWin)
      const l = subset.filter(isLoss)
      const d = w.length + l.length
      const r = subset.filter(isResolved).filter((e) => e.rMultiple != null)
      return {
        source,
        total: subset.length,
        winRate: d > 0 ? (w.length / d) * 100 : 0,
        avgR: avg(r.map((e) => e.rMultiple!)),
      }
    })
    .filter((s) => s.total > 0)

  const buckets: Array<{ label: string; min: number; max: number }> = [
    { label: '<60%', min: 0, max: 60 },
    { label: '60–70%', min: 60, max: 70 },
    { label: '70–80%', min: 70, max: 80 },
    { label: '80–90%', min: 80, max: 90 },
    { label: '90%+', min: 90, max: 101 },
  ]

  const byConfidence: ConfidenceBucketStats[] = buckets.map((b) => {
    const subset = entries.filter(
      (e) => e.confidenceAtSignal >= b.min && e.confidenceAtSignal < b.max
    )
    const w = subset.filter(isWin)
    const l = subset.filter(isLoss)
    const d = w.length + l.length
    const r = subset.filter(isResolved).filter((e) => e.rMultiple != null)
    return {
      label: b.label,
      min: b.min,
      max: b.max,
      total: subset.length,
      wins: w.length,
      winRate: d > 0 ? (w.length / d) * 100 : 0,
      avgR: avg(r.map((e) => e.rMultiple!)),
    }
  })

  const insights = buildInsights(bySetup, byConfidence, {
    winRate,
    resolved: resolved.length,
  })

  const recent = [...entries]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 25)

  return {
    total: entries.length,
    resolved: resolved.length,
    open: open.length,
    wins: wins.length,
    losses: losses.length,
    timeouts: timeouts.length,
    winRate,
    avgR,
    expectancyR: Number.isFinite(expectancyR) ? expectancyR : 0,
    avgPnl: avg(
      resolved.filter((e) => e.pnlPercent != null).map((e) => e.pnlPercent!)
    ),
    profitFactor,
    bySetup,
    bySource,
    byConfidence,
    insights,
    recent,
  }
}

/** PnL % and R from prices */
export function calcPnlAndR(params: {
  direction: 'LONG' | 'SHORT'
  entry: number
  exit: number
  sl: number
}): { pnlPercent: number; rMultiple: number } {
  const { direction, entry, exit, sl } = params
  const pnlPercent =
    direction === 'LONG'
      ? ((exit - entry) / entry) * 100
      : ((entry - exit) / entry) * 100
  const risk =
    direction === 'LONG'
      ? Math.abs(entry - sl) / entry
      : Math.abs(sl - entry) / entry
  const rMultiple = risk > 0 ? pnlPercent / 100 / risk : 0
  return { pnlPercent, rMultiple }
}
