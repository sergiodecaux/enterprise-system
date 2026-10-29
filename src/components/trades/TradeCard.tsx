import {
  AlertTriangle,
  Bot,
  CheckCircle,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import Badge, { type BadgeTone } from '../ui/Badge'
import Button from '../ui/Button'
import type { ActiveTrade } from '../../engine/types'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import { directionLabel } from '../../i18n/displayMaps'
import { useAppStore } from '../../store/useAppStore'
import { useAdvisorStore } from '../../store/useAdvisorStore'

interface TradeCardProps {
  trade: ActiveTrade
}

const STATUS_LABEL: Partial<Record<ActiveTrade['status'], string>> = {
  ACTIVE: 'Активна',
  BREAKEVEN: 'Безубыток',
  INVALIDATED: 'Сломан',
  CLOSED_WIN: 'Прибыль',
  CLOSED_LOSS: 'Убыток',
  PARTIAL_CLOSE: 'Частично закрыта',
}

const STATUS_TONE: Partial<Record<ActiveTrade['status'], BadgeTone>> = {
  ACTIVE: 'neutral',
  BREAKEVEN: 'info',
  INVALIDATED: 'warning',
  CLOSED_WIN: 'long',
  CLOSED_LOSS: 'short',
  PARTIAL_CLOSE: 'info',
}

const TradeCard = ({ trade }: TradeCardProps) => {
  const { haptic } = useTelegramWebApp()
  const closeTrade = useAppStore((s) => s.closeTrade)
  const askAdvisor = useAdvisorStore((s) => s.ask)

  const isLong = trade.direction === 'LONG'
  const isProfit = trade.pnlPercent > 0
  const isInvalidated = trade.status === 'INVALIDATED'

  const DirectionIcon = isLong ? TrendingUp : TrendingDown
  const pnlColor = isProfit ? 'text-market-long' : 'text-market-short'

  const distanceToTP1 = Math.abs(trade.tp1 - trade.entryPrice)
  const currentDistance = Math.abs(trade.currentPrice - trade.entryPrice)
  const progressPercent =
    distanceToTP1 > 0
      ? Math.min((currentDistance / distanceToTP1) * 100, 100)
      : 0

  const handleClose = () => {
    haptic.impact()
    const confirmed = window.confirm(
      `Закрыть сделку ${trade.symbol} ${trade.direction} вручную?\nТекущий P&L: ${trade.pnlPercent.toFixed(2)}%`
    )
    if (confirmed) {
      closeTrade(trade.id, isProfit ? 'WIN' : 'LOSS', trade.currentPrice)
    }
  }

  return (
    <div
      className={`relative overflow-hidden rounded-lg border bg-bg-panel p-3 pl-4 ${
        isInvalidated ? 'border-border opacity-70' : 'border-border'
      }`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-[2px] ${
          isLong ? 'bg-market-long/70' : 'bg-market-short/70'
        }`}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate font-mono text-[15px] font-semibold leading-5 text-text-primary">
              {trade.symbol.replace('USDT', '/USDT')}
            </h3>
            <Badge tone={isLong ? 'long' : 'short'} uppercase>
              <DirectionIcon className="h-3 w-3" strokeWidth={2} />
              {directionLabel(trade.direction)}
            </Badge>
            {STATUS_LABEL[trade.status] && (
              <Badge tone={STATUS_TONE[trade.status] ?? 'neutral'}>
                {STATUS_LABEL[trade.status]}
              </Badge>
            )}
          </div>
          {trade.tradeStyle && (
            <div className="mt-1 font-mono text-[11px] leading-4 text-text-muted">
              {trade.tradeStyle === 'SCALP'
                ? 'скальп'
                : trade.tradeStyle === 'SWING'
                  ? 'свинг'
                  : 'интрадей'}
            </div>
          )}
        </div>

        <div className="shrink-0 text-right">
          <div className={`tnum font-mono text-[18px] font-medium leading-[22px] ${pnlColor}`}>
            {isProfit ? '+' : ''}
            {trade.pnlPercent.toFixed(2)}%
          </div>
          {trade.pnlUsd != null && (
            <div className={`tnum font-mono text-[11px] leading-4 ${pnlColor}`}>
              {isProfit ? '+' : ''}${trade.pnlUsd.toFixed(2)}
            </div>
          )}
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-3 divide-x divide-border-subtle overflow-hidden rounded-md border border-border bg-bg-base/50">
        <div className="px-2.5 py-1.5">
          <div className="font-sans text-[11px] leading-4 text-text-muted">
            Вход
          </div>
          <div className="tnum truncate font-mono text-[13px] font-medium leading-4 text-text-primary">
            {trade.entryPrice.toFixed(4)}
          </div>
        </div>
        <div className="px-2.5 py-1.5">
          <div className="font-sans text-[11px] leading-4 text-text-muted">
            Сейчас
          </div>
          <div className={`tnum truncate font-mono text-[13px] font-medium leading-4 ${pnlColor}`}>
            {trade.currentPrice.toFixed(4)}
          </div>
        </div>
        <div className="px-2.5 py-1.5">
          <div className="flex items-center justify-between gap-1 font-sans text-[11px] leading-4 text-text-muted">
            <span>TP1</span>
            <span className="tnum font-mono text-market-long">
              {trade.tp1.toFixed(4)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-1 font-sans text-[11px] leading-4 text-text-muted">
            <span>SL</span>
            <span className="tnum font-mono text-market-short">
              {trade.sl.toFixed(4)}
            </span>
          </div>
        </div>
      </div>

      {(trade.status === 'ACTIVE' || trade.status === 'BREAKEVEN') && (
        <div className="mt-2">
          <div className="flex items-center justify-between gap-2 font-sans text-[11px] leading-4 text-text-muted">
            <span>Прогресс до TP1</span>
            <span className="tnum font-mono text-text-secondary">
              {progressPercent.toFixed(0)}%
            </span>
          </div>
          <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-bg-surface">
            <div
              className={`h-full rounded-full transition-[width] ${
                isLong ? 'bg-market-long' : 'bg-market-short'
              }`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}

      {isInvalidated && (
        <div className="mt-2.5 rounded-md border border-market-warning/20 bg-market-warning/[0.06] px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-market-warning" />
            <span className="font-sans text-[12px] font-medium text-market-warning">
              Сетап сломан
            </span>
          </div>
          <p className="mt-0.5 font-sans text-[11px] leading-4 text-text-muted">
            {trade.events.find((e) => e.type === 'INVALIDATION')?.message ??
              'Структура нарушена'}
          </p>
        </div>
      )}

      {trade.breakevenAlertShown && trade.status === 'ACTIVE' && (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-md border border-market-warning/20 bg-market-warning/[0.06] px-2.5 py-2">
          <CheckCircle className="h-3.5 w-3.5 text-market-warning" />
          <span className="font-sans text-[12px] text-market-warning">
            Рекомендация: перевести SL в безубыток
          </span>
        </div>
      )}

      {(trade.status === 'ACTIVE' ||
        trade.status === 'BREAKEVEN' ||
        trade.status === 'INVALIDATED') && (
        <div className="mt-2.5 space-y-2">
          {trade.isMemeTrade && trade.trailingStop != null && (
            <div className="rounded-md border border-border bg-bg-base/50 px-2.5 py-2">
              <div className="font-sans text-[11px] leading-4 text-text-muted">
                Shadow trailing
              </div>
              <div className="mt-0.5 flex justify-between font-mono text-[11px] leading-4">
                <span className="text-text-secondary">
                  Peak: {(trade.peakPrice ?? trade.entryPrice).toFixed(6)}
                </span>
                <span className="font-medium text-market-warning">
                  Trail: {trade.trailingStop.toFixed(6)}
                </span>
              </div>
            </div>
          )}

          {trade.isMemeTrade && (
            <button
              type="button"
              onClick={() => {
                haptic.error()
                const confirmed = window.confirm(
                  `PANIC SELL ${trade.symbol}?\n\nСРОЧНО ИДИ В MEXC И ЖМИ SELL MARKET!\n\nЗакрыть локальный трек сделки?`
                )
                if (confirmed) {
                  try {
                    void navigator.clipboard?.writeText(
                      `MEXC PANIC SELL MARKET ${trade.symbol.replace('USDT', '/USDT')} ${trade.direction}`
                    )
                  } catch {
                    /* ignore */
                  }
                  closeTrade(trade.id, 'MANUAL', trade.currentPrice)
                }
              }}
              className="flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-market-short/40 bg-market-short/15 px-3 py-2 font-sans text-[12px] font-semibold text-market-short transition-colors hover:bg-market-short/20"
            >
              <AlertTriangle className="h-4 w-4" />
              PANIC SELL · выйти в рынок
            </button>
          )}

          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                askAdvisor({
                  mode: 'trade',
                  symbol: trade.symbol,
                  tradeId: trade.id,
                  text: `Мнение по моей сделке ${trade.symbol} ${trade.direction}: держать, сократить или закрыть?`,
                })
              }
              className="flex-1"
            >
              <Bot className="h-3.5 w-3.5" />
              Советник
            </Button>

            <Button
              variant="secondary"
              size="sm"
              onClick={handleClose}
              className="flex-1"
            >
              Закрыть вручную
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export default TradeCard
