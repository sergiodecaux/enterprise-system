import { useState } from 'react'
import { TrendingUp, TrendingDown, Target, Shield } from 'lucide-react'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import { useAppStore } from '../../store/useAppStore'
import { calculateConfidenceScore } from '../../engine/confidence'
import type { SniperSignal } from '../../engine/sniperMode'
import { directionLabel } from '../../i18n/displayMaps'
import ConfidenceScore from '../trades/ConfidenceScore'

interface SniperCardProps {
  signal: SniperSignal
}

const SniperCard = ({ signal }: SniperCardProps) => {
  const { haptic, showAlert } = useTelegramWebApp()
  const selectCoin = useAppStore((s) => s.selectCoin)
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen)
  const addTrade = useAppStore((s) => s.addTrade)
  const buyerAggression = useAppStore(
    (s) => s.buyerAggression[signal.internalSymbol] ?? null
  )

  const [showConfidence, setShowConfidence] = useState(false)

  const enrichedSignal = {
    ...signal,
    buyerAggression: buyerAggression ?? signal.buyerAggression ?? null,
  }

  const confidence = calculateConfidenceScore(enrichedSignal, null, null)

  const isLong = signal.direction === 'LONG'

  const handleOpenDrawer = () => {
    haptic.impact()
    selectCoin(signal.symbol)
    setDrawerOpen(true)
  }

  const handleOpenTrade = () => {
    haptic.impact()

    if (!confidence.approved) {
      showAlert(
        `❌ Уверенность ${confidence.totalScore}% — слишком низкая для входа!`
      )
      return
    }

    if (!signal.direction || signal.sl == null || signal.tp1 == null) return

    const positionSize = window.prompt(
      `Открыть ${signal.direction} ${signal.displayName}?\nВведи размер позиции в USD (или оставь пустым):`,
      ''
    )

    if (positionSize === null) return

    const sizeUsd = positionSize.trim() ? parseFloat(positionSize) : null

    addTrade({
      symbol: signal.symbol,
      internalSymbol: signal.internalSymbol,
      direction: signal.direction,
      entryPrice: signal.entryPrice,
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
      positionSizeUsd: sizeUsd,
      breakevenAlertShown: false,
      invalidationAlertShown: false,
      wallAlertShown: false,
      tradeStyle: signal.tradeStyle,
      invalidationPrice: signal.invalidationPrice ?? null,
    })

    haptic.success()
    showAlert(
      `✅ Сделка открыта!\nУверенность: ${confidence.totalScore}%\n${confidence.recommendation}`
    )
  }

  const formatPrice = (price: number): string => {
    if (price >= 1000)
      return price.toLocaleString('en-US', { maximumFractionDigits: 2 })
    if (price >= 1) return price.toFixed(4)
    return price.toFixed(6)
  }

  const directionColor = isLong ? 'text-matrix' : 'text-alert'
  const directionBg = isLong ? 'bg-matrix/10' : 'bg-alert/10'
  const directionBorder = isLong ? 'border-matrix/30' : 'border-alert/30'
  const DirectionIcon = isLong ? TrendingUp : TrendingDown

  const winRateColor =
    signal.calibratedWinRate >= 80
      ? 'text-matrix'
      : signal.calibratedWinRate >= 70
        ? 'text-yellow-400'
        : 'text-holo'

  const rrColor =
    signal.riskReward >= 8
      ? 'text-matrix'
      : signal.riskReward >= 5
        ? 'text-yellow-400'
        : 'text-holo'

  return (
    <div
      className={`rounded-xl border ${directionBorder} ${directionBg} p-4`}
    >
      <button
        type="button"
        onClick={handleOpenDrawer}
        className="w-full text-left"
      >
        <div className="mb-3 flex items-start justify-between">
          <div className="flex-1">
            <div className="mb-1 flex items-center gap-2">
              <h3 className="font-mono text-lg font-bold text-holo">
                {signal.displayName}
              </h3>
              <span
                className={`flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-xs font-bold uppercase ${directionColor}`}
              >
                <DirectionIcon className="h-3 w-3" />
                {directionLabel(signal.direction)}
              </span>
              <span
                className={`rounded-md px-2 py-0.5 font-mono text-[10px] font-bold ${
                  signal.tradeStyle === 'SCALP'
                    ? 'border border-yellow-400/40 bg-yellow-400/10 text-yellow-300'
                    : 'border border-sky-400/40 bg-sky-400/10 text-sky-300'
                }`}
              >
                {signal.tradeStyle === 'SCALP'
                  ? '⚡️ SCALP [M5]'
                  : '🎯 INTRADAY [H1]'}
              </span>
            </div>
            <div className="font-mono text-sm text-holo/60">
              ${formatPrice(signal.price)}
            </div>
          </div>

          <div className="flex flex-col items-end gap-1">
            <div
              className={`rounded-lg bg-black/30 px-3 py-1.5 font-mono text-xl font-bold ${winRateColor}`}
            >
              {signal.calibratedWinRate}%
            </div>
            <div className="font-mono text-[10px] uppercase text-holo/40">
              Confidence
            </div>
          </div>
        </div>

        <div className="mb-3 h-px bg-hull-border/50" />

        <div className="mb-3 grid grid-cols-3 gap-2">
          <div>
            <div className="mb-0.5 flex items-center gap-1 font-mono text-[10px] uppercase text-holo/40">
              <Target className="h-3 w-3" />
              {signal.ote?.isActive ? 'OTE зона' : 'Вход'}
            </div>
            <div className="font-mono text-sm font-bold text-holo">
              {signal.ote?.priceInZone
                ? `${formatPrice(signal.ote.zoneBottom)}–${formatPrice(signal.ote.zoneTop)}`
                : formatPrice(signal.entryPrice)}
            </div>
          </div>

          <div>
            <div className="mb-0.5 flex items-center gap-1 font-mono text-[10px] uppercase text-holo/40">
              <Shield className="h-3 w-3" />
              SL
            </div>
            <div className="font-mono text-sm font-bold text-alert">
              {formatPrice(signal.sl!)}
            </div>
            <div className="font-mono text-[9px] text-alert/60">
              {signal.riskPercent.toFixed(2)}%
            </div>
          </div>

          <div>
            <div className="mb-0.5 font-mono text-[10px] uppercase text-holo/40">
              TP1
            </div>
            <div className="font-mono text-sm font-bold text-matrix">
              {formatPrice(signal.tp1!)}
            </div>
            <div className="font-mono text-[9px] text-matrix/60">
              {signal.rewardPercent.toFixed(2)}%
            </div>
          </div>
        </div>

        <div className="mb-3 flex items-center justify-between rounded-lg bg-black/20 px-3 py-2">
          <span className="font-mono text-xs uppercase text-holo/40">
            Риск / Доход
          </span>
          <span className={`font-mono text-lg font-bold ${rrColor}`}>
            1 : {signal.riskReward.toFixed(1)}
          </span>
        </div>

        <div className="space-y-1.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-holo/30">
            Фильтры ({signal.strengthFiltersActive}/3 силы)
          </div>
          {signal.sniperReasons.map((reason, idx) => (
            <div
              key={idx}
              className="flex items-center gap-1.5 font-mono text-xs text-holo/70"
            >
              <span className="text-matrix">✓</span>
              <span>{reason}</span>
            </div>
          ))}
        </div>
      </button>

      <button
        type="button"
        onClick={handleOpenTrade}
        className="mt-3 w-full rounded-lg bg-gradient-to-r from-matrix to-matrix/80 px-4 py-3 font-mono text-sm font-bold uppercase text-black shadow-md transition-all hover:shadow-lg active:scale-95"
      >
        Открыть сделку
      </button>

      <button
        type="button"
        onClick={() => setShowConfidence(!showConfidence)}
        className="mt-2 w-full font-mono text-xs text-holo/40 underline"
      >
        {showConfidence ? 'Скрыть' : 'Показать'} оценку уверенности
      </button>

      {showConfidence && (
        <div className="mt-3">
          <ConfidenceScore result={confidence} />
        </div>
      )}
    </div>
  )
}

export default SniperCard
