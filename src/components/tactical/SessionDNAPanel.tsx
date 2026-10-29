import {
  Drama,
  Flame,
  Moon,
  RefreshCw,
  Scale,
  Search,
  Sunrise,
  TrendingUp,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { SessionDNA, SessionPersonality, SessionStat } from '../../engine/types'

interface Props {
  dna: SessionDNA
}

/** Цвета для каждой сессии — соответствуют SessionOverlay */
const SESSION_COLORS: Record<
  string,
  { text: string; bg: string; border: string }
> = {
  ASIA: {
    text: 'text-market-purple',
    bg: 'bg-market-purple/[0.08]',
    border: 'border-market-purple/25',
  },
  LONDON: {
    text: 'text-market-warning',
    bg: 'bg-market-warning/[0.08]',
    border: 'border-market-warning/25',
  },
  OVERLAP: {
    text: 'text-market-short',
    bg: 'bg-market-short/[0.08]',
    border: 'border-market-short/25',
  },
  NEW_YORK: {
    text: 'text-market-long',
    bg: 'bg-market-long/[0.08]',
    border: 'border-market-long/25',
  },
}

/** Цвет personality-бейджа */
const PERSONALITY_COLORS: Record<string, string> = {
  FAKEOUT_KING:
    'text-market-purple bg-market-purple/10 border-market-purple/30',
  TREND_FOLLOWER: 'text-market-long bg-market-long/10 border-market-long/25',
  ASIA_RANGER:
    'text-market-purple bg-market-purple/10 border-market-purple/25',
  OVERLAP_BEAST: 'text-market-short bg-market-short/10 border-market-short/25',
  LONDON_BREAKER:
    'text-market-warning bg-market-warning/10 border-market-warning/25',
  NY_REVERSAL: 'text-market-info bg-market-info/10 border-market-info/25',
  STEADY_MOVER: 'text-text-secondary bg-bg-elevated border-border',
  UNKNOWN: 'text-text-muted bg-bg-panel border-border',
}

const PERSONALITY_ICONS: Record<SessionPersonality, LucideIcon> = {
  FAKEOUT_KING: Drama,
  TREND_FOLLOWER: TrendingUp,
  ASIA_RANGER: Moon,
  OVERLAP_BEAST: Zap,
  LONDON_BREAKER: Sunrise,
  NY_REVERSAL: RefreshCw,
  STEADY_MOVER: Scale,
  UNKNOWN: Search,
}

/** Полоска статистики — визуальный индикатор % */
const StatBar = ({
  value,
  color,
  max = 100,
}: {
  value: number
  color: string
  max?: number
}) => (
  <div className="h-1 flex-1 overflow-hidden rounded-full bg-bg-elevated">
    <div
      className={`h-full rounded-full ${color}`}
      style={{ width: `${Math.min((value / max) * 100, 100)}%` }}
    />
  </div>
)

/** Строка одной метрики сессии */
const StatRow = ({
  label,
  value,
  suffix = '%',
  color,
  threshold,
}: {
  label: string
  value: number
  suffix?: string
  color: string
  threshold?: number
}) => {
  const isHot = threshold !== undefined && value >= threshold
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 font-sans text-[11px] leading-4 text-text-muted">
        {label}
      </span>
      <StatBar value={value} color={isHot ? color : 'bg-bg-elevated'} />
      <span
        className={`tnum w-10 shrink-0 text-right font-mono text-[11px] font-medium leading-4 ${
          isHot
            ? color.replace('bg-', 'text-').replace('/10', '')
            : 'text-text-muted'
        }`}
      >
        {value.toFixed(0)}
        {suffix}
      </span>
    </div>
  )
}

/** Карточка одной сессии */
const SessionCard = ({ stat }: { stat: SessionStat }) => {
  const colors = SESSION_COLORS[stat.session] ?? SESSION_COLORS.ASIA

  return (
    <div className={`rounded-md border ${colors.border} ${colors.bg} p-2.5`}>
      {/* Заголовок сессии */}
      <div className="mb-2 flex items-center justify-between gap-1">
        <span className={`font-sans text-[11px] font-medium leading-4 ${colors.text}`}>
          {stat.label}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {stat.isHighestVolume && (
            <span className="flex items-center gap-0.5 rounded-sm bg-market-warning/15 px-1 py-0.5 font-mono text-[11px] leading-4 text-market-warning">
              <Flame className="h-2.5 w-2.5" />
              VOL
            </span>
          )}
          <span className="tnum font-mono text-[11px] leading-4 text-text-muted">
            {stat.totalDays}д
          </span>
        </div>
      </div>

      {/* Метрики */}
      <div className="space-y-1.5">
        <StatRow
          label="Диапазон"
          value={stat.avgRangePct}
          suffix="%"
          color="bg-text-secondary"
          threshold={1.5}
        />
        <StatRow
          label="Fakeout"
          value={stat.fakeoutPct}
          color="bg-market-purple"
          threshold={50}
        />
        <StatRow
          label="Сносит хай"
          value={stat.breaksPrevHighPct}
          color="bg-market-long"
          threshold={60}
        />
        <StatRow
          label="Сносит лоу"
          value={stat.breaksPrevLowPct}
          color="bg-market-short"
          threshold={60}
        />
        <StatRow
          label="Бычьих дней"
          value={stat.bullishPct}
          color="bg-market-long"
          threshold={55}
        />
      </div>
    </div>
  )
}

const SessionDNAPanel = ({ dna }: Props) => {
  if (dna.personality === 'UNKNOWN' || dna.sessions.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-bg-panel p-3">
        <div className="flex items-center gap-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          <span className="font-sans text-[11px] leading-4 text-text-muted">
            ДНК сессии: недостаточно данных ({dna.candlesAnalyzed} свечей)
          </span>
        </div>
      </div>
    )
  }

  const personalityClass =
    PERSONALITY_COLORS[dna.personality] ?? PERSONALITY_COLORS.UNKNOWN
  const PersonalityIcon = PERSONALITY_ICONS[dna.personality] ?? Search

  return (
    <div className="rounded-lg border border-border bg-bg-panel p-3">
      {/* Заголовок */}
      <div className="mb-2.5 flex items-center gap-2">
        <PersonalityIcon className="h-3.5 w-3.5 shrink-0 text-market-info" strokeWidth={1.9} />
        <span className="font-sans text-[13px] font-medium leading-5 text-text-primary">
          ДНК сессии
        </span>
        <span
          className={`ml-auto flex items-center gap-1 rounded-sm border px-2 py-0.5 font-mono text-[11px] leading-4 ${personalityClass}`}
        >
          <PersonalityIcon className="h-2.5 w-2.5" />
          <span>{dna.personalityLabel}</span>
        </span>
      </div>

      {/* Ключевой инсайт */}
      <div className="mb-2.5 rounded-md border border-border bg-bg-base/40 px-2.5 py-2">
        <p className="font-sans text-[11px] leading-4 text-text-secondary">
          {dna.keyInsight}
        </p>
      </div>

      {/* Карточки сессий — 2 колонки */}
      <div className="grid grid-cols-2 gap-1.5">
        {dna.sessions.map((stat) => (
          <SessionCard key={stat.session} stat={stat} />
        ))}
      </div>

      {/* Подпись */}
      <p className="mt-2 font-mono text-[11px] leading-4 text-text-muted">
        Анализ {dna.candlesAnalyzed} свечей · {dna.sessions[0]?.totalDays ?? 0}
        + дней истории
      </p>
    </div>
  )
}

export default SessionDNAPanel
