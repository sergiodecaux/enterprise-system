import { TrendingUp, TrendingDown, AlertTriangle, CheckCircle } from 'lucide-react'
import type { ActiveTrade } from '../../engine/types'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import { directionLabel } from '../../i18n/displayMaps'
import { useAppStore } from '../../store/useAppStore'

interface TradeCardProps {
  trade: ActiveTrade
}

const TradeCard = ({ trade }: TradeCardProps) => {
  const { haptic } = useTelegramWebApp()
  const closeTrade = useAppStore((s) => s.closeTrade)

  const isLong = trade.direction === 'LONG'
  const isProfit = trade.pnlPercent > 0
  const isInvalidated = trade.status === 'INVALIDATED'

  const directionColor = isLong ? 'text-matrix' : 'text-alert'
  const directionBg = isLong ? 'bg-matrix/10' : 'bg-alert/10'
  const directionBorder = isLong ? 'border-matrix/30' : 'border-alert/30'
  const DirectionIcon = isLong ? TrendingUp : TrendingDown

  const pnlColor = isProfit ? 'text-matrix' : 'text-alert'

  const statusEmoji =
    trade.status === 'ACTIVE'
      ? '🟢'
      : trade.status === 'BREAKEVEN'
        ? '💎'
        : trade.status === 'INVALIDATED'
          ? '🔴'
          : trade.status === 'CLOSED_WIN'
            ? '✅'
            : '❌'

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
      className={`rounded-xl border ${directionBorder} ${directionBg} p-4 ${
        isInvalidated ? 'opacity-60' : ''
      }`}
    >
      <div className="mb-3 flex items-start justify-between">
        <div className="flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-base">{statusEmoji}</span>
            <h3 className="font-mono text-lg font-bold text-holo">
              {trade.symbol.replace('USDT', '/USDT')}
            </h3>
            <span
              className={`flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-xs font-bold uppercase ${directionColor}`}
            >
              <DirectionIcon className="h-3 w-3" />
              {directionLabel(trade.direction)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-holo/40">Уверенность:</span>
            <span
              className={`font-mono text-xs font-bold ${
                trade.confidenceScore >= 85
                  ? 'text-matrix'
                  : trade.confidenceScore >= 70
                    ? 'text-yellow-400'
                    : 'text-holo/50'
              }`}
            >
              {trade.confidenceScore}%
            </span>
          </div>
        </div>

        <div className="text-right">
          <div className={`mb-0.5 font-mono text-2xl font-bold ${pnlColor}`}>
            {isProfit ? '+' : ''}
            {trade.pnlPercent.toFixed(2)}%
          </div>
          {trade.pnlUsd != null && (
            <div className={`font-mono text-xs ${pnlColor}`}>
              {isProfit ? '+' : ''}${trade.pnlUsd.toFixed(2)}
            </div>
          )}
        </div>
      </div>

      <div className="mb-3 grid grid-cols-3 gap-2 rounded-lg bg-black/20 p-2">
        <div>
          <div className="mb-0.5 font-mono text-[10px] uppercase text-holo/40">
            Вход
          </div>
          <div className="font-mono text-sm font-bold text-holo">
            {trade.entryPrice.toFixed(4)}
          </div>
        </div>

        <div>
          <div className="mb-0.5 font-mono text-[10px] uppercase text-holo/40">
            Текущая
          </div>
          <div className={`font-mono text-sm font-bold ${pnlColor}`}>
            {trade.currentPrice.toFixed(4)}
          </div>
        </div>

        <div>
          <div className="mb-0.5 font-mono text-[10px] uppercase text-holo/40">
            TP1
          </div>
          <div className="font-mono text-sm font-bold text-matrix">
            {trade.tp1.toFixed(4)}
          </div>
        </div>
      </div>

      {(trade.status === 'ACTIVE' || trade.status === 'BREAKEVEN') && (
        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase text-holo/40">
              Прогресс до TP1
            </span>
            <span className="font-mono text-xs font-bold text-holo/70">
              {progressPercent.toFixed(0)}%
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-hull-border">
            <div
              className="h-full rounded-full bg-gradient-to-r from-matrix/60 to-matrix transition-all"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}

      {isInvalidated && (
        <div className="mb-3 rounded-lg border border-alert/30 bg-alert/5 p-2.5">
          <div className="mb-1 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-alert" />
            <span className="font-mono text-xs font-bold uppercase text-alert">
              Сетап сломан
            </span>
          </div>
          <p className="font-mono text-[10px] leading-relaxed text-alert/80">
            {trade.events.find((e) => e.type === 'INVALIDATION')?.message ??
              'Структура нарушена'}
          </p>
        </div>
      )}

      {trade.breakevenAlertShown && trade.status === 'ACTIVE' && (
        <div className="mb-3 rounded-lg border border-yellow-400/30 bg-yellow-400/5 p-2.5">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-yellow-400" />
            <span className="font-mono text-xs font-bold text-yellow-400">
              Рекомендация: SL → Безубыток
            </span>
          </div>
        </div>
      )}

      {(trade.status === 'ACTIVE' ||
        trade.status === 'BREAKEVEN' ||
        trade.status === 'INVALIDATED') && (
        <div className="space-y-2">
          {trade.isMemeTrade && trade.trailingStop != null && (
            <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-2.5">
              <div className="mb-0.5 font-mono text-[10px] uppercase text-orange-400/70">
                Shadow Trailing
              </div>
              <div className="flex justify-between font-mono text-xs">
                <span className="text-holo/60">
                  Peak: {(trade.peakPrice ?? trade.entryPrice).toFixed(6)}
                </span>
                <span className="font-bold text-orange-400">
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
                  `🚨 PANIC SELL ${trade.symbol}?\n\nСРОЧНО ИДИ В MEXC И ЖМИ SELL MARKET!\n\nЗакрыть локальный трек сделки?`
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
              className="w-full animate-pulse rounded-xl border-2 border-alert bg-gradient-to-r from-alert to-orange-600 px-4 py-4 font-mono text-base font-black uppercase tracking-wider text-white shadow-[0_0_24px_rgba(255,0,60,0.45)] transition-all active:scale-95"
            >
              🚨 PANIC SELL / BAIL OUT
            </button>
          )}

          <button
            type="button"
            onClick={handleClose}
            className="w-full rounded-lg border border-hull-border bg-hull-light px-4 py-2 font-mono text-xs font-bold uppercase text-holo transition-colors hover:bg-hull hover:text-matrix active:scale-95"
          >
            Закрыть сделку вручную
          </button>
        </div>
      )}
    </div>
  )
}

export default TradeCard
