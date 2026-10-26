import { ChevronRight, TrendingDown, TrendingUp } from 'lucide-react'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import { useAppStore } from '../../store/useAppStore'
import { directionLabel } from '../../i18n/displayMaps'
import type {
  LiveLimitSource,
  LiveLimitState,
  LiveLimitTrade,
} from '../../engine/sniper/liveLimits'

interface LiveLimitCardProps {
  trade: LiveLimitTrade
  isNew?: boolean
  isCommodity?: boolean
}

const STATE_META: Record<
  LiveLimitState,
  { label: string; className: string }
> = {
  IN_ZONE: {
    label: 'В зоне',
    className: 'border-matrix/50 bg-matrix/20 text-matrix',
  },
  APPROACHING: {
    label: 'Подход',
    className: 'border-yellow-400/45 bg-yellow-400/15 text-yellow-300',
  },
  WAITING: {
    label: 'Ждём',
    className: 'border-holo/20 bg-holo/10 text-holo/55',
  },
  FILLED: {
    label: 'Лимит в рынке',
    className: 'border-sky-400/45 bg-sky-400/15 text-sky-300',
  },
  INVALIDATED: {
    label: 'Сломан',
    className: 'border-alert/40 bg-alert/15 text-alert',
  },
}

const SOURCE_META: Record<
  LiveLimitSource,
  { label: string; className: string }
> = {
  SURGICAL: {
    label: '🎯 Surgical',
    className: 'bg-violet-400/15 text-violet-300',
  },
  MM_HUNT: {
    label: 'MM hunt',
    className: 'bg-sky-400/15 text-sky-300',
  },
  SSL: { label: 'SSL', className: 'bg-matrix/15 text-matrix' },
  BSL: { label: 'BSL', className: 'bg-alert/15 text-alert' },
  OTE: { label: 'OTE', className: 'bg-yellow-400/15 text-yellow-300' },
  SIGNAL: { label: 'Сигнал', className: 'bg-holo/10 text-holo/60' },
  RANGE: { label: '24ч', className: 'bg-holo/10 text-holo/50' },
}

const STYLE_META: Record<
  LiveLimitTrade['style'],
  { label: string; className: string }
> = {
  SCALP: {
    label: '⚡️ SCALP',
    className: 'border border-yellow-400/40 bg-yellow-400/10 text-yellow-300',
  },
  INTRADAY: {
    label: '🎯 INTRA',
    className: 'border border-sky-400/40 bg-sky-400/10 text-sky-300',
  },
  SWING: {
    label: '🕯 SWING',
    className: 'border border-violet-400/40 bg-violet-400/10 text-violet-300',
  },
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function formatPrice(price: number): string {
  if (price >= 1000) {
    return price.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  if (price >= 1) return price.toFixed(4)
  return price.toFixed(6)
}

const LiveLimitCard = ({
  trade,
  isNew = false,
  isCommodity = false,
}: LiveLimitCardProps) => {
  const { haptic } = useTelegramWebApp()
  const selectCoin = useAppStore((s) => s.selectCoin)
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen)

  const isLong = trade.side === 'LONG'
  const DirectionIcon = isLong ? TrendingUp : TrendingDown

  const directionColor = isLong ? 'text-matrix' : 'text-alert'
  const directionBg = isLong ? 'bg-matrix/10' : 'bg-alert/10'
  const directionBorder = isLong ? 'border-matrix/30' : 'border-alert/30'

  const stateMeta = STATE_META[trade.state]
  const sourceMeta = SOURCE_META[trade.source]
  const styleMeta = STYLE_META[trade.style]

  const filled = trade.state === 'FILLED'
  const progress =
    trade.state === 'IN_ZONE' || filled
      ? 100
      : clamp(100 - (trade.distancePct / 2.5) * 100, 4, 96)

  const progressColor =
    trade.state === 'IN_ZONE' || filled
      ? 'bg-matrix'
      : trade.state === 'APPROACHING'
        ? 'bg-yellow-400'
        : 'bg-holo/30'

  const confidenceColor =
    trade.confidence >= 70
      ? 'text-matrix'
      : trade.confidence >= 55
        ? 'text-yellow-300'
        : 'text-holo/55'

  const handleOpen = () => {
    haptic.impact()
    selectCoin(trade.symbol)
    setDrawerOpen(true)
  }

  return (
    <button
      type="button"
      onClick={handleOpen}
      data-live-limit="true"
      data-live-limit-state={trade.state}
      data-live-limit-source={trade.source}
      data-live-limit-side={trade.side}
      data-live-limit-potential={trade.potentialPct.toFixed(2)}
      data-live-limit-entry={trade.entry}
      className={`w-full rounded-xl border ${directionBorder} ${directionBg} p-2.5 text-left transition-all active:scale-[0.99]`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-mono text-sm font-bold text-holo">
              {trade.displayName}
            </span>
            <span
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase ${directionColor}`}
            >
              <DirectionIcon className="h-2.5 w-2.5" />
              {directionLabel(trade.side)}
            </span>
            <span
              className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold ${styleMeta.className}`}
            >
              {styleMeta.label}
            </span>
            {isCommodity && (
              <span className="rounded border border-amber-400/35 bg-amber-500/10 px-1 py-0.5 font-mono text-[8px] font-bold uppercase text-amber-200/90">
                Сырьё
              </span>
            )}
          </div>

          <div className="mt-1 flex items-center gap-1.5 font-mono text-[9px] text-holo/40">
            <span className={`rounded px-1 py-0.5 ${sourceMeta.className}`}>
              {sourceMeta.label}
            </span>
            <span>·</span>
            <span className="truncate">цель: {trade.targetLabel}</span>
            <span className="ml-auto flex shrink-0 items-center gap-0.5 text-holo/35">
              график
              <ChevronRight className="h-2.5 w-2.5" />
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={`rounded-md border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase ${stateMeta.className}`}
          >
            {stateMeta.label}
          </span>
          {isNew && (
            <span className="rounded border border-matrix/50 bg-matrix/20 px-1 py-0.5 font-mono text-[8px] font-bold uppercase text-matrix">
              NEW
            </span>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-2 font-mono text-[9px]">
        <span className="text-holo/40">
          Сейчас{' '}
          <span className="text-holo/70">${formatPrice(trade.price)}</span>
          <span
            className={`ml-1 ${
              trade.change24h >= 0 ? 'text-matrix/70' : 'text-alert/70'
            }`}
          >
            {trade.change24h >= 0 ? '+' : ''}
            {trade.change24h.toFixed(2)}%
          </span>
        </span>
        <span className="shrink-0 text-holo/45">
          {filled
            ? 'заявка исполнена'
            : `до лимита ${trade.distancePct.toFixed(2)}%`}
        </span>
      </div>

      <div className="mt-1.5 grid grid-cols-3 gap-1.5">
        <div className="rounded-lg bg-black/25 px-1.5 py-1">
          <div className="font-mono text-[8px] uppercase tracking-wide text-holo/35">
            Лимит
          </div>
          <div className="font-mono text-xs font-bold text-holo">
            {formatPrice(trade.entry)}
          </div>
          <div className="font-mono text-[8px] text-holo/30">
            {trade.style === 'SCALP'
              ? 'быстрый вход'
              : trade.style === 'SWING'
                ? 'держим'
                : 'интрадей'}
          </div>
        </div>

        <div className="rounded-lg bg-black/25 px-1.5 py-1">
          <div className="font-mono text-[8px] uppercase tracking-wide text-holo/35">
            Цель
          </div>
          <div className="font-mono text-xs font-bold text-matrix">
            {formatPrice(trade.target)}
          </div>
          <div className="font-mono text-[8px] text-matrix/60">
            +{trade.potentialPct.toFixed(2)}%
          </div>
        </div>

        <div className="rounded-lg bg-black/25 px-1.5 py-1">
          <div className="font-mono text-[8px] uppercase tracking-wide text-holo/35">
            Стоп
          </div>
          <div className="font-mono text-xs font-bold text-alert">
            {formatPrice(trade.invalidation)}
          </div>
          <div className="font-mono text-[8px] text-alert/60">
            −{trade.riskPct.toFixed(2)}%
          </div>
        </div>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-1.5 font-mono">
          <span className="text-[8px] uppercase tracking-wide text-holo/35">
            Потенциал
          </span>
          <span className="text-lg font-bold text-matrix">
            +{trade.potentialPct.toFixed(1)}%
          </span>
        </div>
        <div className="flex items-baseline gap-2 font-mono text-[9px]">
          <span className="text-holo/45">
            R:R 1:{trade.riskReward.toFixed(1)}
          </span>
          <span className={`font-bold ${confidenceColor}`}>
            {trade.confidence}%
          </span>
        </div>
      </div>

      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/30">
        <div
          className={`h-full rounded-full ${progressColor}`}
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1">
        {trade.reasons.slice(0, 2).map((reason) => (
          <span
            key={reason}
            className="max-w-full truncate rounded bg-black/20 px-1.5 py-0.5 font-mono text-[8px] text-holo/55"
          >
            {reason}
          </span>
        ))}
      </div>
    </button>
  )
}

export default LiveLimitCard
