import { ChevronRight, TrendingDown, TrendingUp } from 'lucide-react'
import Badge, { type BadgeTone } from '../ui/Badge'
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

const STATE_LABEL: Record<LiveLimitState, string> = {
  IN_ZONE: 'В зоне',
  APPROACHING: 'Подход',
  WAITING: 'Ждём',
  FILLED: 'Лимит в рынке',
  INVALIDATED: 'Сломан',
}

const STATE_TONE: Record<LiveLimitState, BadgeTone> = {
  IN_ZONE: 'long',
  APPROACHING: 'warning',
  WAITING: 'neutral',
  FILLED: 'info',
  INVALIDATED: 'short',
}

const SOURCE_LABEL: Record<LiveLimitSource, string> = {
  SURGICAL: 'Surgical',
  MM_HUNT: 'MM hunt',
  SSL: 'SSL',
  BSL: 'BSL',
  OTE: 'OTE',
  SIGNAL: 'Сигнал',
  RANGE: '24ч',
}

const STYLE_LABEL: Record<LiveLimitTrade['style'], string> = {
  SCALP: 'скальп',
  INTRADAY: 'интрадей',
  SWING: 'свинг',
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

  const filled = trade.state === 'FILLED'
  const inZone = trade.state === 'IN_ZONE'
  const nearEntry = trade.distancePct <= 0.3

  const progress = inZone || filled
    ? 100
    : clamp(100 - (trade.distancePct / 2.5) * 100, 4, 96)
  const progressColor =
    inZone || filled
      ? isLong
        ? 'bg-market-long'
        : 'bg-market-short'
      : trade.state === 'APPROACHING'
        ? 'bg-market-warning'
        : 'bg-text-muted/50'

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
      className={`relative w-full overflow-hidden rounded-lg border bg-bg-panel p-3 pl-4 text-left transition-colors hover:border-border-active active:bg-bg-elevated/50 ${
        isNew ? 'border-brand/30' : 'border-border'
      }`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-[2px] ${
          isLong ? 'bg-market-long/70' : 'bg-market-short/70'
        }`}
      />

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-mono text-[13px] font-semibold leading-5 text-text-primary">
              {trade.displayName}
            </span>
            <Badge tone={isLong ? 'long' : 'short'} uppercase>
              <DirectionIcon className="h-3 w-3" strokeWidth={2} />
              {directionLabel(trade.side)}
            </Badge>
            <Badge tone={STATE_TONE[trade.state]}>
              {STATE_LABEL[trade.state]}
            </Badge>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] leading-4 text-text-muted">
            <span className="tnum text-text-secondary">
              ${formatPrice(trade.price)}
            </span>
            <span
              className={
                trade.change24h >= 0
                  ? 'text-market-long/80'
                  : 'text-market-short/80'
              }
            >
              {trade.change24h >= 0 ? '+' : ''}
              {trade.change24h.toFixed(2)}%
            </span>
            <span aria-hidden>·</span>
            <span
              className={
                filled
                  ? 'text-market-info'
                  : nearEntry
                    ? 'text-market-warning'
                    : ''
              }
            >
              {filled
                ? 'заявка исполнена'
                : `до лимита ${trade.distancePct.toFixed(2)}%`}
            </span>
            <span aria-hidden>·</span>
            <span>{SOURCE_LABEL[trade.source]}</span>
            <span aria-hidden>·</span>
            <span>{STYLE_LABEL[trade.style]}</span>
            {isCommodity && (
              <>
                <span aria-hidden>·</span>
                <span className="text-market-warning/80">сырьё</span>
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge
            tone={
              trade.riskReward >= 3
                ? 'long'
                : trade.riskReward >= 2
                  ? 'warning'
                  : 'neutral'
            }
            uppercase
            title="Риск к доходу"
          >
            1 : {trade.riskReward.toFixed(1)}
          </Badge>
          {isNew && (
            <Badge tone="brand" dot>
              NEW
            </Badge>
          )}
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-3 divide-x divide-border-subtle overflow-hidden rounded-md border border-border bg-bg-base/50">
        <div className="px-2.5 py-1.5">
          <div className="font-sans text-[11px] leading-4 text-text-muted">
            Вход
          </div>
          <div className="tnum truncate font-mono text-[13px] font-medium leading-4 text-text-primary">
            {formatPrice(trade.entry)}
          </div>
        </div>
        <div className="px-2.5 py-1.5">
          <div className="flex items-center justify-between font-sans text-[11px] leading-4 text-text-muted">
            <span>Цель</span>
            <span className="tnum font-mono text-market-long">
              +{trade.potentialPct.toFixed(2)}%
            </span>
          </div>
          <div className="tnum truncate font-mono text-[13px] font-medium leading-4 text-market-long">
            {formatPrice(trade.target)}
          </div>
        </div>
        <div className="px-2.5 py-1.5">
          <div className="flex items-center justify-between font-sans text-[11px] leading-4 text-text-muted">
            <span>Стоп</span>
            <span className="tnum font-mono text-market-short">
              −{trade.riskPct.toFixed(2)}%
            </span>
          </div>
          <div className="tnum truncate font-mono text-[13px] font-medium leading-4 text-market-short">
            {formatPrice(trade.invalidation)}
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <div className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-bg-surface">
          <div
            className={`h-full rounded-full ${progressColor}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="tnum shrink-0 font-mono text-[11px] leading-4 text-text-muted">
          {trade.confidence}%
        </span>
      </div>

      {trade.reasons.length > 0 && (
        <div className="mt-1.5 flex items-center gap-1 font-mono text-[11px] leading-4 text-text-muted">
          <span className="truncate">{trade.reasons[0]}</span>
          <ChevronRight className="h-3 w-3 shrink-0" />
        </div>
      )}
    </button>
  )
}

export default LiveLimitCard
