import { useMemo, useState } from 'react'
import {
  Calculator,
  ChevronRight,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import Badge from '../ui/Badge'
import Button from '../ui/Button'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import { useAppStore } from '../../store/useAppStore'
import { DescriptiveNote } from '../tactical/DescriptiveNote'
import PositionSizeCalculator from '../trades/PositionSizeCalculator'
import { calculateConfidenceScore } from '../../engine/confidence'
import type { SniperSignal } from '../../engine/sniperMode'
import { directionLabel } from '../../i18n/displayMaps'

interface SniperCardProps {
  signal: SniperSignal
  firedAt?: number | null
  isNewFire?: boolean
  isCommodity?: boolean
}

const STYLE_LABEL: Record<string, string> = {
  SCALP: 'Скальп',
  INTRADAY: 'Интрадей',
  SWING: 'Свинг',
}

/** Engine reasons arrive with emoji prefixes; the redesign keeps them out. */
const stripEmoji = (value: string): string =>
  value.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '')

const formatPrice = (price: number): string => {
  if (!Number.isFinite(price)) return '—'
  if (price >= 1000)
    return price.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (price >= 1) return price.toFixed(4)
  return price.toFixed(6)
}

const formatTime = (ts: number): string =>
  new Date(ts).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })

const SniperCard = ({
  signal,
  firedAt = null,
  isNewFire = false,
  isCommodity = false,
}: SniperCardProps) => {
  const { haptic, showAlert } = useTelegramWebApp()
  const selectCoin = useAppStore((s) => s.selectCoin)
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen)
  const addTrade = useAppStore((s) => s.addTrade)
  const buyerAggression = useAppStore(
    (s) => s.buyerAggression[signal.internalSymbol] ?? null
  )
  const orderBookMetrics = useAppStore(
    (s) => s.orderBookMetrics[signal.internalSymbol] ?? null
  )
  const mmIntent = useAppStore(
    (s) => signal.mmIntent ?? s.mmIntent[signal.internalSymbol] ?? null
  )

  const [calculatorOpen, setCalculatorOpen] = useState(false)

  const enrichedSignal = useMemo(
    () => ({
      ...signal,
      buyerAggression: buyerAggression ?? signal.buyerAggression ?? null,
    }),
    [signal, buyerAggression]
  )

  const confidence = useMemo(
    () =>
      calculateConfidenceScore(enrichedSignal, orderBookMetrics, null, {
        isMeme: !!signal.memePulse,
      }),
    [enrichedSignal, orderBookMetrics, signal.memePulse]
  )

  const isLong = signal.direction === 'LONG'
  const DirectionIcon = isLong ? TrendingUp : TrendingDown

  const entry =
    signal.surgicalEntry?.status === 'READY' &&
    signal.surgicalEntry.limitEntry != null
      ? signal.surgicalEntry.limitEntry
      : signal.entryPrice

  const distancePct =
    entry > 0 && Number.isFinite(signal.price)
      ? ((signal.price - entry) / entry) * 100
      : 0
  const nearEntry = Math.abs(distancePct) <= 0.3

  const surgicalStatus = signal.surgicalEntry?.status
  const stateLabel =
    surgicalStatus === 'READY'
      ? 'Готов к входу'
      : surgicalStatus?.startsWith('WAITING')
        ? 'Ждём триггер'
        : surgicalStatus && surgicalStatus !== 'IDLE'
          ? 'Отменён'
          : STYLE_LABEL[signal.tradeStyle ?? ''] ?? 'Сетап'

  const stateTone =
    surgicalStatus === 'READY'
      ? 'brand'
      : surgicalStatus?.startsWith('WAITING')
        ? 'warning'
        : surgicalStatus && surgicalStatus !== 'IDLE'
          ? 'short'
          : 'neutral'

  const rrTone =
    signal.riskReward >= 8
      ? 'long'
      : signal.riskReward >= 5
        ? 'warning'
        : 'neutral'

  const handleOpenDrawer = () => {
    haptic.impact()
    selectCoin(signal.symbol)
    setDrawerOpen(true)
  }

  const handleOpenCalculator = () => {
    haptic.impact()
    if (!confidence.approved) {
      showAlert('Вход не открыт: статистика этого сетапа не подтверждена.')
      return
    }
    if (!signal.direction || signal.sl == null || signal.tp1 == null) return
    setCalculatorOpen(true)
  }

  const handleConfirmTrade = (positionSizeUsd: number) => {
    if (!signal.direction || signal.sl == null || signal.tp1 == null) return

    addTrade({
      symbol: signal.symbol,
      internalSymbol: signal.internalSymbol,
      direction: signal.direction,
      entryPrice: entry,
      entryTime: Date.now(),
      sl: signal.sl,
      tp1: signal.tp1,
      tp2: signal.tp2 ?? null,
      status: 'ACTIVE',
      currentPrice: signal.price,
      pnlPercent: 0,
      pnlUsd: null,
      confidenceScore: confidence.totalScore,
      confidenceFactors: confidence.factors.map((f) => f.name),
      positionSizeUsd,
      breakevenAlertShown: false,
      invalidationAlertShown: false,
      wallAlertShown: false,
      tradeStyle: signal.tradeStyle,
      invalidationPrice: signal.invalidationPrice ?? null,
    })

    haptic.success()
    showAlert(`Сделка открыта.\n${signal.direction} ${signal.displayName}`)
  }

  const reasons = signal.sniperReasons
    .map(stripEmoji)
    .filter((reason) => reason.length > 0)
    .slice(0, 3)

  return (
    <div
      className={`relative overflow-hidden rounded-lg border bg-bg-panel transition-colors hover:border-border-active ${
        isNewFire ? 'border-brand/30' : 'border-border'
      }`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-[2px] ${
          isLong ? 'bg-market-long/70' : 'bg-market-short/70'
        }`}
      />

      <div className="p-3 pl-4">
        <button
          type="button"
          onClick={handleOpenDrawer}
          className="block w-full text-left"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <h3 className="truncate font-mono text-[15px] font-semibold leading-5 text-text-primary">
                  {signal.displayName}
                </h3>
                <Badge tone={isLong ? 'long' : 'short'} uppercase>
                  <DirectionIcon className="h-3 w-3" strokeWidth={2} />
                  {directionLabel(signal.direction)}
                </Badge>
                <Badge tone={stateTone}>{stateLabel}</Badge>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] leading-4 text-text-muted">
                <span className="tnum text-text-secondary">
                  ${formatPrice(signal.price)}
                </span>
                <span aria-hidden>·</span>
                <span
                  className={
                    nearEntry && surgicalStatus !== 'READY'
                      ? 'text-market-warning'
                      : 'text-text-secondary'
                  }
                >
                  до входа {Math.abs(distancePct).toFixed(2)}%
                </span>
                <span aria-hidden>·</span>
                <span>{STYLE_LABEL[signal.tradeStyle ?? ''] ?? 'Сетап'}</span>
                {isCommodity && (
                  <>
                    <span aria-hidden>·</span>
                    <span>Сырьё</span>
                  </>
                )}
                {mmIntent?.preferredSide && (
                  <>
                    <span aria-hidden>·</span>
                    <span
                      className={
                        mmIntent.preferredSide === 'LONG'
                          ? 'text-market-long'
                          : 'text-market-short'
                      }
                    >
                      MM → {mmIntent.preferredSide}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex shrink-0 flex-col items-end gap-1">
              <Badge tone={rrTone} uppercase title="Риск к доходу до TP1">
                1 : {signal.riskReward.toFixed(1)}
              </Badge>
              {firedAt != null && (
                <span
                  className={`flex items-center gap-1 font-mono text-[11px] leading-4 ${
                    isNewFire ? 'text-brand' : 'text-text-muted'
                  }`}
                >
                  {isNewFire && (
                    <span className="h-1.5 w-1.5 rounded-full bg-brand" />
                  )}
                  {isNewFire ? 'новый' : formatTime(firedAt)}
                </span>
              )}
            </div>
          </div>
        </button>

        <div className="mt-2.5">
          <DescriptiveNote />
        </div>

        <div className="mt-2.5 grid grid-cols-3 divide-x divide-border-subtle overflow-hidden rounded-md border border-border bg-bg-base/50">
          <div className="px-2.5 py-2">
            <div className="font-sans text-[11px] leading-4 text-text-muted">
              Вход
            </div>
            <div className="tnum truncate font-mono text-[13px] font-medium leading-4 text-text-primary">
              {formatPrice(entry)}
            </div>
          </div>
          <div className="px-2.5 py-2">
            <div className="font-sans text-[11px] leading-4 text-text-muted">
              Стоп
            </div>
            <div className="tnum truncate font-mono text-[13px] font-medium leading-4 text-market-short">
              {formatPrice(signal.sl!)}
            </div>
            <div className="tnum font-mono text-[11px] leading-4 text-text-muted">
              −{signal.riskPercent.toFixed(2)}%
            </div>
          </div>
          <div className="px-2.5 py-2">
            <div className="font-sans text-[11px] leading-4 text-text-muted">
              TP1
            </div>
            <div className="tnum truncate font-mono text-[13px] font-medium leading-4 text-market-long">
              {formatPrice(signal.tp1!)}
            </div>
            <div className="tnum font-mono text-[11px] leading-4 text-text-muted">
              +{signal.rewardPercent.toFixed(2)}%
            </div>
          </div>
        </div>

        <div className="mt-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-sans text-[11px] leading-4 text-text-muted">
              Подтверждение сетапа
            </span>
            <span
              className={`tnum font-mono text-[11px] font-medium leading-4 ${
                confidence.approved ? 'text-text-primary' : 'text-market-warning'
              }`}
            >
              {confidence.totalScore}%
              {!confidence.approved && ' · не подтверждён'}
            </span>
          </div>
          <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-bg-surface">
            <div
              className={`h-full rounded-full transition-[width] duration-300 ${
                confidence.approved
                  ? isLong
                    ? 'bg-market-long'
                    : 'bg-market-short'
                  : 'bg-market-warning'
              }`}
              style={{
                width: `${Math.max(0, Math.min(100, confidence.totalScore))}%`,
              }}
            />
          </div>
        </div>

        {reasons.length > 0 && (
          <ul className="mt-2.5 space-y-1">
            {reasons.map((reason) => (
              <li
                key={reason}
                className="flex items-start gap-1.5 font-sans text-[11px] leading-4 text-text-secondary"
              >
                <span
                  aria-hidden
                  className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${
                    isLong ? 'bg-market-long/70' : 'bg-market-short/70'
                  }`}
                />
                <span className="min-w-0">{reason}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleOpenDrawer}
            className="flex-1"
          >
            На графике
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleOpenCalculator}
            className="flex-[1.35]"
          >
            {confidence.approved ? (
              <Calculator className="h-3.5 w-3.5" />
            ) : (
              <ShieldAlert className="h-3.5 w-3.5" />
            )}
            Рассчитать позицию
          </Button>
        </div>
      </div>

      <PositionSizeCalculator
        isOpen={calculatorOpen}
        onClose={() => setCalculatorOpen(false)}
        symbol={signal.symbol}
        displayName={signal.displayName}
        direction={isLong ? 'LONG' : 'SHORT'}
        entry={entry}
        sl={signal.sl ?? 0}
        tp1={signal.tp1}
        tp2={signal.tp2}
        onConfirm={handleConfirmTrade}
      />
    </div>
  )
}

export default SniperCard
