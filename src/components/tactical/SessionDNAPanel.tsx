import type { SessionDNA, SessionStat } from '../../engine/types'

interface Props {
  dna: SessionDNA
}

/** Цвета для каждой сессии — соответствуют SessionOverlay */
const SESSION_COLORS: Record<
  string,
  { text: string; bg: string; border: string }
> = {
  ASIA: {
    text: 'text-indigo-400',
    bg: 'bg-indigo-400/10',
    border: 'border-indigo-400/30',
  },
  LONDON: {
    text: 'text-amber-400',
    bg: 'bg-amber-400/10',
    border: 'border-amber-400/30',
  },
  OVERLAP: {
    text: 'text-red-400',
    bg: 'bg-red-400/10',
    border: 'border-red-400/30',
  },
  NEW_YORK: {
    text: 'text-matrix',
    bg: 'bg-matrix/10',
    border: 'border-matrix/30',
  },
}

/** Цвет personality-бейджа */
const PERSONALITY_COLORS: Record<string, string> = {
  FAKEOUT_KING: 'text-purple-400 bg-purple-400/15 border-purple-400/30',
  TREND_FOLLOWER: 'text-matrix bg-matrix/15 border-matrix/30',
  ASIA_RANGER: 'text-indigo-400 bg-indigo-400/15 border-indigo-400/30',
  OVERLAP_BEAST: 'text-red-400 bg-red-400/15 border-red-400/30',
  LONDON_BREAKER: 'text-amber-400 bg-amber-400/15 border-amber-400/30',
  NY_REVERSAL: 'text-orange-400 bg-orange-400/15 border-orange-400/30',
  STEADY_MOVER: 'text-holo/60 bg-hull-light border-hull-border',
  UNKNOWN: 'text-holo/30 bg-hull border-hull-border',
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
  <div className="h-1 flex-1 overflow-hidden rounded-full bg-hull-border">
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
      <span className="w-28 font-mono text-[10px] text-holo/40 shrink-0">
        {label}
      </span>
      <StatBar value={value} color={isHot ? color : 'bg-hull-light'} />
      <span
        className={`w-10 text-right font-mono text-[10px] font-bold shrink-0 ${
          isHot
            ? color.replace('bg-', 'text-').replace('/10', '')
            : 'text-holo/40'
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
    <div className={`rounded-lg border ${colors.border} ${colors.bg} p-2.5`}>
      {/* Заголовок сессии */}
      <div className="mb-2 flex items-center justify-between">
        <span className={`font-mono text-xs font-bold ${colors.text}`}>
          {stat.label}
        </span>
        <div className="flex items-center gap-1.5">
          {stat.isHighestVolume && (
            <span className="rounded bg-yellow-400/20 px-1 font-mono text-[9px] text-yellow-400">
              VOL★
            </span>
          )}
          <span className="font-mono text-[10px] text-holo/40">
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
          color="bg-holo/60"
          threshold={1.5}
        />
        <StatRow
          label="Fakeout"
          value={stat.fakeoutPct}
          color="bg-purple-400"
          threshold={50}
        />
        <StatRow
          label="Сносит хай"
          value={stat.breaksPrevHighPct}
          color="bg-matrix"
          threshold={60}
        />
        <StatRow
          label="Сносит лоу"
          value={stat.breaksPrevLowPct}
          color="bg-alert"
          threshold={60}
        />
        <StatRow
          label="Бычьих дней"
          value={stat.bullishPct}
          color="bg-matrix"
          threshold={55}
        />
      </div>
    </div>
  )
}

const SessionDNAPanel = ({ dna }: Props) => {
  if (dna.personality === 'UNKNOWN' || dna.sessions.length === 0) {
    return (
      <div className="rounded-xl border border-hull-border bg-hull p-3">
        <div className="flex items-center gap-2">
          <span className="text-base">🔍</span>
          <span className="font-mono text-xs text-holo/40">
            ДНК сессии: недостаточно данных ({dna.candlesAnalyzed} свечей)
          </span>
        </div>
      </div>
    )
  }

  const personalityClass =
    PERSONALITY_COLORS[dna.personality] ?? PERSONALITY_COLORS.UNKNOWN

  return (
    <div className="rounded-xl border border-hull-border bg-hull p-3">
      {/* Заголовок */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-base">🧬</span>
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          ДНК сессии
        </span>
        <span
          className={`ml-auto flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[10px] font-bold ${personalityClass}`}
        >
          <span>{dna.personalityIcon}</span>
          <span>{dna.personalityLabel}</span>
        </span>
      </div>

      {/* Ключевой инсайт */}
      <div className="mb-3 rounded-lg bg-black/20 px-3 py-2">
        <p className="font-mono text-xs leading-relaxed text-holo/70">
          {dna.keyInsight}
        </p>
      </div>

      {/* Карточки сессий — 2 колонки */}
      <div className="grid grid-cols-2 gap-2">
        {dna.sessions.map((stat) => (
          <SessionCard key={stat.session} stat={stat} />
        ))}
      </div>

      {/* Подпись */}
      <p className="mt-2 font-mono text-[9px] text-holo/20">
        Анализ {dna.candlesAnalyzed} свечей · {dna.sessions[0]?.totalDays ?? 0}
        + дней истории
      </p>
    </div>
  )
}

export default SessionDNAPanel

