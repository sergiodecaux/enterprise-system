import { useEffect, useRef, useMemo } from 'react'
import { Magnet, X, Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import ProbabilityGauge from './ProbabilityGauge'
import LiveChart from './LiveChart'
import OrderBookPanel from './OrderBookPanel'
import DataLog from './DataLog'
import NewsPanel from '../news/NewsPanel'
import FearGreedGauge from '../news/FearGreedGauge'
import type {
  BtcDivergenceResult,
  CoinSignal,
  EqualLevel,
  LiquidityMap,
  MmIntentSnapshot,
  PO3Analysis,
  SessionDNA,
  SurgicalEntrySnapshot,
  TapeMomentumState,
  BuyerAggressionResult,
  WhaleWatcherState,
} from '../../engine/types'
import { formatWhaleVolume } from '../../engine/orderbook/whaleDetector'
import WhaleAlertBanner from './WhaleAlertBanner'
import SessionDNAPanel from './SessionDNAPanel'
import LTFAlignmentPanel from './LTFAlignmentPanel'
import PO3Panel from './PO3Panel'
import TapeMomentumIndicator from './TapeMomentumIndicator'
import BuyerAggressionIndicator from './BuyerAggressionIndicator'
import AbsorptionPanel from './AbsorptionPanel'
import MemePulsePanel from '../meme/MemePulsePanel'
import CompositeAnalysisPanel from '../composite/CompositeAnalysisPanel'
import { buildCompositeAnalysis } from '../../engine/composite'
import { useBuyerAggression } from '../../hooks/useBuyerAggression'
import { useMultiTFAnalysis } from '../../hooks/useMultiTFAnalysis'
import { buildMarketBrief } from '../../engine/brief'
import MarketBriefPanel from './MarketBriefPanel'

/** Панель дивергенции силы альта vs BTC */
const BtcDivergencePanel = ({
  divergence,
}: {
  divergence: BtcDivergenceResult
}) => {
  if (divergence.type === 'NONE' || !divergence.label) return null

  const isBull = divergence.type === 'BULL_DIV'
  const isBear = divergence.type === 'BEAR_DIV'
  const isCorr = divergence.type === 'CORRELATED'

  const borderColor = isBull
    ? 'border-matrix/30'
    : isBear
      ? 'border-alert/30'
      : 'border-hull-border'

  const bgColor = isBull ? 'bg-matrix/5' : isBear ? 'bg-alert/5' : 'bg-hull'

  const textColor = isBull
    ? 'text-matrix'
    : isBear
      ? 'text-alert'
      : 'text-holo/40'

  const icon = isBull ? '⚡' : isBear ? '🔻' : '≈'

  return (
    <div className={`rounded-xl border ${borderColor} ${bgColor} p-3`}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm">{icon}</span>
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          Корреляция с BTC
        </span>
        {divergence.scoreBoost > 0 && !isCorr && (
          <span
            className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
              isBull ? 'bg-matrix/20 text-matrix' : 'bg-alert/20 text-alert'
            }`}
          >
            +{divergence.scoreBoost.toFixed(1)} к оценке
          </span>
        )}
      </div>

      <p
        className={`mb-2 font-mono text-xs font-medium leading-relaxed ${textColor}`}
      >
        {divergence.label}
      </p>

      <div className="grid grid-cols-3 gap-2 rounded-lg bg-black/20 p-2">
        <div className="text-center">
          <div className="mb-0.5 font-mono text-[10px] uppercase text-holo/30">
            BTC {divergence.lookbackCandles}H
          </div>
          <div
            className={`font-mono text-sm font-bold ${
              divergence.btcChangePct >= 0 ? 'text-matrix' : 'text-alert'
            }`}
          >
            {divergence.btcChangePct >= 0 ? '+' : ''}
            {divergence.btcChangePct.toFixed(2)}%
          </div>
        </div>

        <div className="flex items-center justify-center">
          <span className="font-mono text-xs text-holo/20">vs</span>
        </div>

        <div className="text-center">
          <div className="mb-0.5 font-mono text-[10px] uppercase text-holo/30">
            Альт {divergence.lookbackCandles}H
          </div>
          <div
            className={`font-mono text-sm font-bold ${
              divergence.altChangePct >= 0 ? 'text-matrix' : 'text-alert'
            }`}
          >
            {divergence.altChangePct >= 0 ? '+' : ''}
            {divergence.altChangePct.toFixed(2)}%
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="font-mono text-[10px] text-holo/30">Сила альта:</span>
        <span
          className={`font-mono text-xs font-bold ${
            divergence.relativeStrength > 0 ? 'text-matrix' : 'text-alert'
          }`}
        >
          {divergence.relativeStrength > 0 ? '+' : ''}
          {divergence.relativeStrength.toFixed(2)}%
        </span>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-hull-border">
          <div
            className={`h-full rounded-full transition-all ${
              divergence.relativeStrength > 0 ? 'bg-matrix' : 'bg-alert'
            }`}
            style={{
              width: `${Math.min(
                (Math.abs(divergence.relativeStrength) / 10) * 100,
                100
              )}%`,
              marginLeft: divergence.relativeStrength < 0 ? 'auto' : '0',
            }}
          />
        </div>
      </div>
    </div>
  )
}

/** Панель "Магниты ликвидности" в Drawer */
const LiquidityMagnetPanel = ({ map }: { map: LiquidityMap }) => {
  const hasLevels = map.equalHighs.length > 0 || map.equalLows.length > 0

  if (!hasLevels) return null

  const strengthIcon = (s: string) =>
    s === 'STRONG' ? '🔴' : s === 'MEDIUM' ? '🟡' : '⚪'

  const renderLevel = (level: EqualLevel, color: string) => (
    <div
      key={`${level.type}-${level.price}`}
      className="flex items-center justify-between rounded-md border px-2 py-1.5"
      style={{ borderColor: color + '40', backgroundColor: color + '10' }}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs">{strengthIcon(level.strength)}</span>
        <span className="font-mono text-xs font-bold" style={{ color }}>
          {level.type === 'HIGH' ? 'BSL' : 'SSL'}
        </span>
        <span className="font-mono text-xs text-holo/60">
          ×{level.touches} касаний
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-holo/80">
          {level.price.toLocaleString('ru-RU', { maximumFractionDigits: 4 })}
        </span>
        <span
          className="font-mono text-[10px]"
          style={{
            color: level.isActive ? color : 'rgba(100,100,100,0.6)',
          }}
        >
          {level.distancePct.toFixed(1)}%
          {level.isActive ? ' 🧲' : ' ✓'}
        </span>
      </div>
    </div>
  )

  return (
    <div className="rounded-xl border border-hull-border bg-hull p-3">
      <div className="mb-2 flex items-center gap-2">
        <Magnet className="h-4 w-4 text-yellow-400" />
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          Магниты ликвидности
        </span>
        {map.liquidityBoost > 0 && (
          <span className="ml-auto rounded bg-yellow-400/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-yellow-400">
            +{map.liquidityBoost.toFixed(1)} к оценке
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        {map.equalHighs
          .slice(0, 3)
          .map((l) => renderLevel(l, 'rgb(251, 191, 36)'))}
        {map.equalLows
          .slice(0, 3)
          .map((l) => renderLevel(l, 'rgb(168, 85, 247)'))}
      </div>

      {map.nearestBSL && (
        <p className="mt-2 font-mono text-[10px] text-holo/30">
          Ближайший BSL: {map.nearestBSL.distancePct.toFixed(2)}% выше
          {map.nearestSSL
            ? ` · SSL: ${map.nearestSSL.distancePct.toFixed(2)}% ниже`
            : ''}
        </p>
      )}
    </div>
  )
}

/** Панель Whale Watcher в Drawer — без баннеров в потоке (они в оверлее drawer) */
const WhaleWatcherPanel = ({ state }: { state: WhaleWatcherState }) => {
  const hasWhales =
    state.strongestSupport !== null || state.strongestResistance !== null

  const activeCount = state.alerts.filter((a) => a.isActive && !a.isExpired).length

  if (!hasWhales && activeCount === 0) return null

  const formatPrice = (price: number): string => {
    if (price >= 1000)
      return price.toLocaleString('en-US', { maximumFractionDigits: 0 })
    if (price >= 1) return price.toFixed(4)
    return price.toFixed(6)
  }

  return (
    <div className="rounded-xl border border-hull-border bg-hull p-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-base">🐋</span>
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          Наблюдатель китов
        </span>
        {activeCount > 0 && (
          <span className="rounded bg-cyan-400/15 px-1.5 py-0.5 font-mono text-[9px] text-cyan-300">
            {activeCount} алерт{activeCount > 1 ? 'а' : ''} ↑
          </span>
        )}
        {state.scoreBoost > 0 && (
          <span className="ml-auto rounded bg-cyan-400/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-cyan-400">
            +{state.scoreBoost.toFixed(1)} к оценке
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {state.strongestSupport && (
          <div className="rounded-lg border border-matrix/20 bg-matrix/5 p-2">
            <div className="mb-1 font-mono text-[10px] uppercase text-holo/40">
              Поддержка китов
            </div>
            <div className="font-mono text-sm font-bold text-matrix">
              {formatPrice(state.strongestSupport.price)}
            </div>
            <div className="font-mono text-[10px] text-matrix/70">
              {formatWhaleVolume(state.strongestSupport.volumeUsd)}
            </div>
            <div className="mt-1 font-mono text-[9px] text-holo/30">
              {state.strongestSupport.distancePct.toFixed(2)}% ниже
            </div>
          </div>
        )}

        {state.strongestResistance && (
          <div className="rounded-lg border border-alert/20 bg-alert/5 p-2">
            <div className="mb-1 font-mono text-[10px] uppercase text-holo/40">
              Сопротивление китов
            </div>
            <div className="font-mono text-sm font-bold text-alert">
              {formatPrice(state.strongestResistance.price)}
            </div>
            <div className="font-mono text-[10px] text-alert/70">
              {formatWhaleVolume(state.strongestResistance.volumeUsd)}
            </div>
            <div className="mt-1 font-mono text-[9px] text-holo/30">
              {state.strongestResistance.distancePct.toFixed(2)}% выше
            </div>
          </div>
        )}
      </div>

      <p className="mt-2 font-mono text-[9px] text-holo/20">
        Обновляется каждые 2 сек · Порог: $1M+
      </p>
    </div>
  )
}

/** Ювелирный вход: статус sweep → confirm → limit */
const SurgicalEntryPanel = ({ plan }: { plan: SurgicalEntrySnapshot }) => {
  if (plan.status === 'IDLE') return null

  const statusColor =
    plan.status === 'READY'
      ? 'text-matrix border-matrix/30 bg-matrix/5'
      : plan.status === 'WAITING_SWEEP' || plan.status === 'WAITING_CONFIRM'
        ? 'text-yellow-300 border-yellow-400/25 bg-yellow-400/5'
        : 'text-alert border-alert/25 bg-alert/5'

  const statusLabel: Record<string, string> = {
    WAITING_SWEEP: 'Ждём sweep',
    WAITING_CONFIRM: 'Ждём confirm',
    READY: 'ГОТОВ · лимитка',
    INVALIDATED: 'Сломан',
    MISSED: 'Пропущен',
  }

  return (
    <div className={`rounded-xl border p-3 ${statusColor}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm">🎯</span>
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          Surgical Entry
        </span>
        <span className="ml-auto font-mono text-[10px] font-bold">
          {statusLabel[plan.status] ?? plan.status}
        </span>
      </div>
      <p className="mb-2 font-mono text-xs leading-relaxed opacity-90">
        {plan.reason}
      </p>
      {plan.limitEntry != null && (
        <div className="mb-2 grid grid-cols-3 gap-2 rounded-lg bg-black/20 p-2">
          <div className="text-center">
            <div className="font-mono text-[9px] uppercase text-holo/30">
              Limit
            </div>
            <div className="font-mono text-sm font-bold text-holo">
              {plan.limitEntry.toPrecision(6)}
            </div>
          </div>
          <div className="text-center">
            <div className="font-mono text-[9px] uppercase text-holo/30">
              Zone
            </div>
            <div className="font-mono text-[10px] text-holo/70">
              {plan.zoneBottom != null && plan.zoneTop != null
                ? `${plan.zoneBottom.toPrecision(5)}–${plan.zoneTop.toPrecision(5)}`
                : '—'}
            </div>
          </div>
          <div className="text-center">
            <div className="font-mono text-[9px] uppercase text-holo/30">
              Invalid
            </div>
            <div className="font-mono text-[10px] text-alert/80">
              {plan.invalidation != null
                ? plan.invalidation.toPrecision(6)
                : '—'}
            </div>
          </div>
        </div>
      )}
      {plan.confirmations.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {plan.confirmations.map((c) => (
            <span
              key={c}
              className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[9px] text-holo/60"
            >
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Намерение ММ: куда гонит цену и маршрут микро → макро ликвидность */
const MmIntentPanel = ({ intent }: { intent: MmIntentSnapshot }) => {
  const driveColor =
    intent.drive === 'UP'
      ? 'text-matrix'
      : intent.drive === 'DOWN'
        ? 'text-alert'
        : 'text-holo/50'
  const sideColor =
    intent.preferredSide === 'LONG'
      ? 'text-matrix'
      : intent.preferredSide === 'SHORT'
        ? 'text-alert'
        : 'text-holo/40'

  return (
    <div className="rounded-xl border border-hull-border bg-hull p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm">{intent.emoji}</span>
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          MM Intent
        </span>
        <span className={`ml-auto font-mono text-[10px] font-bold ${driveColor}`}>
          Drive {intent.drive} · {intent.confidence}%
        </span>
      </div>
      <p className={`mb-2 font-mono text-xs font-medium ${driveColor}`}>
        {intent.label}
      </p>
      {intent.preferredSide && (
        <div className={`mb-2 font-mono text-xs font-bold ${sideColor}`}>
          Лучший сетап сейчас: {intent.preferredSide}
          {intent.hunt.microIsStopHunt ? ' (после sweep стопов)' : ''}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 rounded-lg bg-black/20 p-2">
        <div>
          <div className="mb-0.5 font-mono text-[10px] uppercase text-holo/30">
            Микро
          </div>
          <div className="font-mono text-[11px] text-holo/80">
            {intent.hunt.microLabel || '—'}
            {intent.hunt.microTarget != null && (
              <span className="ml-1 text-holo/40">
                @ {intent.hunt.microTarget.toPrecision(6)}
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="mb-0.5 font-mono text-[10px] uppercase text-holo/30">
            Макро (магнит)
          </div>
          <div className="font-mono text-[11px] text-holo/80">
            {intent.hunt.macroLabel || '—'}
            {intent.hunt.macroTarget != null && (
              <span className="ml-1 text-holo/40">
                @ {intent.hunt.macroTarget.toPrecision(6)}
              </span>
            )}
          </div>
        </div>
      </div>
      {intent.reasons.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {intent.reasons.slice(0, 4).map((r) => (
            <li key={r} className="font-mono text-[10px] text-holo/35">
              · {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const TacticalDrawer = () => {
  const { t } = useTranslation()
  const { haptic, showAlert } = useTelegramWebApp()
  const selectedCoin = useAppStore((state) => state.selectedCoin)
  const isDrawerOpen = useAppStore((state) => state.isDrawerOpen)
  const signals = useAppStore((state) => state.signals)
  const setDrawerOpen = useAppStore((state) => state.setDrawerOpen)
  const selectCoin = useAppStore((state) => state.selectCoin)
  const addTrade = useAppStore((state) => state.addTrade)
  const newsSettings = useAppStore((state) => state.newsSettings)
  const newsIntel = useAppStore((state) => state.newsIntel)
  const liquidityMaps = useAppStore((state) => state.liquidityMaps)
  const whaleWatcher = useAppStore((state) => state.whaleWatcher)
  const sessionDNA = useAppStore((state) => state.sessionDNA)
  const po3Store = useAppStore((state) => state.po3Analysis)
  const tapeStore = useAppStore((state) => state.tapeMomentum)
  const aggressionStore = useAppStore((state) => state.buyerAggression)
  const mmIntentStore = useAppStore((state) => state.mmIntent)
  const watchedSetups = useAppStore((state) => state.watchedSetups)

  const drawerRef = useRef<HTMLDivElement>(null)

  const signal: CoinSignal | null = selectedCoin
    ? signals.find((s) => s.symbol === selectedCoin) ?? null
    : null

  const liquidityMap = signal
    ? liquidityMaps[signal.internalSymbol] ?? null
    : null
  const btcDivergence = signal?.btcDivergence ?? null
  const whaleState = signal
    ? whaleWatcher[signal.internalSymbol] ?? null
    : null
  const dna: SessionDNA | null = signal
    ? sessionDNA[signal.internalSymbol] ?? null
    : null
  const po3: PO3Analysis | null = signal
    ? po3Store[signal.internalSymbol] ?? null
    : null
  const tape: TapeMomentumState | null = signal
    ? tapeStore[signal.internalSymbol] ?? null
    : null
  const aggressionState: BuyerAggressionResult | null = signal
    ? aggressionStore[signal.internalSymbol] ?? null
    : null
  const mmIntent: MmIntentSnapshot | null = signal
    ? signal.mmIntent ?? mmIntentStore[signal.internalSymbol] ?? null
    : null
  const surgicalPlan: SurgicalEntrySnapshot | null =
    signal?.surgicalEntry ?? null
  const watchedForCoin = signal
    ? watchedSetups.filter(
        (w) =>
          w.internalSymbol === signal.internalSymbol ||
          w.symbol === signal.symbol
      ).length
    : 0
  const hasLTF = !!(
    signal?.mss?.detected ||
    (signal?.raid && signal.raid.type !== 'NONE') ||
    signal?.ote?.isActive
  )

  useBuyerAggression(isDrawerOpen && signal ? signal.internalSymbol : null)

  const {
    alignment: mtfAlignment,
    liquidityMap: mtfLiq,
    candles1d: brief1d,
    candles4h: brief4h,
    candles1h: brief1h,
    isLoading: briefLoading,
  } = useMultiTFAnalysis(
    signal?.internalSymbol ?? '',
    signal?.price ?? 0,
    isDrawerOpen && !!signal
  )

  const marketBrief = useMemo(() => {
    if (!signal) return null
    return buildMarketBrief({
      signal,
      alignment: mtfAlignment,
      liquidityMap: mtfLiq,
      candles1d: brief1d,
      candles4h: brief4h,
      candles1h: brief1h,
    })
  }, [signal, mtfAlignment, mtfLiq, brief1d, brief4h, brief1h])

  useEffect(() => {
    if (isDrawerOpen && signal) {
      haptic.impact()
    }
  }, [isDrawerOpen, signal, haptic])

  const compositeAnalysis = useMemo(() => {
    if (!signal) return null
    return buildCompositeAnalysis(
      signal,
      signal.memePulse ?? undefined,
      null,
      aggressionState,
      whaleState,
      dna,
      po3
    )
  }, [signal, aggressionState, whaleState, dna, po3])

  const handleClose = () => {
    setDrawerOpen(false)
    selectCoin(null)
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose()
    }
  }

  if (!signal) return null

  const probability = signal.probabilityPct
  const direction = signal.direction
  const currentRSI = signal.currentRSI ?? 0

  const formatPrice = (price: number): string => {
    if (price >= 1000) {
      return price.toLocaleString('ru-RU', {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      })
    }
    if (price >= 1) {
      return price.toLocaleString('ru-RU', {
        maximumFractionDigits: 4,
        minimumFractionDigits: 2,
      })
    }
    return price.toLocaleString('ru-RU', {
      maximumFractionDigits: 6,
      minimumFractionDigits: 2,
    })
  }

  const formatChange = (change: number): string => {
    const sign = change >= 0 ? '+' : ''
    return `${sign}${change.toFixed(2)}%`
  }

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/60 backdrop-blur-sm z-40 transition-opacity duration-300 ${
          isDrawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={handleBackdropClick}
      />

      <div
        ref={drawerRef}
        className={`fixed bottom-0 left-0 right-0 z-50 flex w-full max-h-[85vh] flex-col overflow-hidden rounded-t-2xl border-t border-hull-border bg-space transition-transform duration-400 ease-out ${
          isDrawerOpen
            ? 'translate-y-0 opacity-100'
            : 'translate-y-full opacity-0 pointer-events-none'
        }`}
        style={{
          transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Киты: плавающий оверлей — НЕ двигает скролл меню монеты */}
        {whaleState &&
          whaleState.alerts.filter((a) => a.isActive && !a.isExpired).length >
            0 && (
            <div className="pointer-events-none absolute inset-x-3 top-11 z-[60]">
              <div className="pointer-events-auto max-h-32 space-y-1.5 overflow-y-auto overscroll-contain rounded-xl bg-space/95 p-1.5 shadow-lg shadow-black/40 backdrop-blur-md">
                {whaleState.alerts
                  .filter((a) => a.isActive && !a.isExpired)
                  .slice(0, 2)
                  .map((alert) => (
                    <WhaleAlertBanner key={alert.id} alert={alert} />
                  ))}
              </div>
            </div>
          )}

        <div className="flex-shrink-0">
          <div className="my-3 flex justify-center">
            <div className="h-1 w-12 rounded-full bg-hull-border" />
          </div>

          <div className="border-b border-hull-border/50 px-4 pb-4">
            <div className="mb-2 flex items-start justify-between">
              <div className="flex-1">
                <h2 className="mb-1 font-mono text-2xl font-bold text-holo">
                  {signal.displayName}
                </h2>
                <div className="flex items-center gap-3 font-mono text-sm">
                  <span className="text-holo/80">${formatPrice(signal.price)}</span>
                  <span
                    className={signal.priceChange24h >= 0 ? 'text-matrix' : 'text-alert'}
                  >
                    {formatChange(signal.priceChange24h)}
                  </span>
                  {signal.hasActiveSetup && (
                    <span className="text-xs uppercase text-matrix">{t('signal_setup')}</span>
                  )}
                  {signal.scoreCard && (
                    <span
                      className={`text-xs font-bold ${
                        signal.scoreCard.ready ? 'text-matrix' : 'text-holo/50'
                      }`}
                      title={signal.scoreCard.missingFactors.slice(0, 2).join(' · ')}
                    >
                      {signal.scoreCard.grade} {signal.scoreCard.totalScore}/
                      {signal.scoreCard.maxScore}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={handleClose}
                className="rounded-lg p-2 transition-colors hover:bg-hull-light"
              >
                <X className="h-5 w-5 text-holo/60" />
              </button>
            </div>
          </div>
        </div>

        <div
          className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-4 py-6"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          {marketBrief && (
            <MarketBriefPanel brief={marketBrief} loading={briefLoading} />
          )}

          {compositeAnalysis && (
            <CompositeAnalysisPanel analysis={compositeAnalysis} />
          )}

          <div className="flex justify-center">
            <ProbabilityGauge value={probability} direction={direction} />
          </div>

          {signal.memePulse && <MemePulsePanel meme={signal.memePulse} />}

          {signal.memePulse && (
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={!!signal.memePulse.longBlocked || !signal.sl || !signal.tp1}
                onClick={() => {
                  if (signal.memePulse?.longBlocked) {
                    showAlert(
                      '⚠️ LONG ЗАБЛОКИРОВАН: Bid Void / Distribution / Toxic. Не лови ножи и не становись exit liquidity.'
                    )
                    return
                  }
                  if (!signal.sl || !signal.tp1) return
                  haptic.impact()
                  addTrade({
                    symbol: signal.symbol,
                    internalSymbol: signal.internalSymbol,
                    direction: 'LONG',
                    entryPrice: signal.price,
                    entryTime: Date.now(),
                    sl: signal.sl,
                    tp1: signal.tp1,
                    tp2: signal.tp2,
                    status: 'ACTIVE',
                    currentPrice: signal.price,
                    pnlPercent: 0,
                    pnlUsd: null,
                    confidenceScore: signal.probabilityPct,
                    confidenceFactors: signal.zones.slice(0, 4),
                    positionSizeUsd: null,
                    breakevenAlertShown: false,
                    invalidationAlertShown: false,
                    wallAlertShown: false,
                    tradeStyle: 'SCALP',
                    isMemeTrade: true,
                    trailingStop: null,
                    peakPrice: signal.price,
                    trailingAlertShown: false,
                  })
                  showAlert(
                    `🚀 MEME LONG открыт (shadow trailing).\n${signal.memePulse?.setupTag ?? ''}`
                  )
                }}
                className={`rounded-xl px-3 py-3 font-mono text-xs font-black uppercase tracking-wide transition-all active:scale-95 ${
                  signal.memePulse.longBlocked
                    ? 'cursor-not-allowed border border-hull-border bg-hull/50 text-holo/30'
                    : 'border border-matrix/50 bg-matrix/20 text-matrix shadow-[0_0_12px_rgba(0,255,65,0.2)]'
                }`}
              >
                {signal.memePulse.longBlocked ? (
                  <span className="inline-flex items-center gap-1">
                    <Lock className="h-3 w-3" /> LONG
                  </span>
                ) : (
                  '🚀 LONG'
                )}
              </button>

              <button
                type="button"
                disabled={
                  !!signal.memePulse.shortBlocked || !signal.sl || !signal.tp1
                }
                onClick={() => {
                  if (signal.memePulse?.shortBlocked) {
                    showAlert(
                      '⚠️ ЗАПРЕЩЕНО: Высокий риск шорт-сквиза. Толпа шортит, маркетмейкер готовит ликвидации вверх. Дождись слома структуры.'
                    )
                    return
                  }
                  if (!signal.sl || !signal.tp1) return
                  haptic.impact()
                  addTrade({
                    symbol: signal.symbol,
                    internalSymbol: signal.internalSymbol,
                    direction: 'SHORT',
                    entryPrice: signal.price,
                    entryTime: Date.now(),
                    sl: signal.sl,
                    tp1: signal.tp1,
                    tp2: signal.tp2,
                    status: 'ACTIVE',
                    currentPrice: signal.price,
                    pnlPercent: 0,
                    pnlUsd: null,
                    confidenceScore: signal.probabilityPct,
                    confidenceFactors: signal.zones.slice(0, 4),
                    positionSizeUsd: null,
                    breakevenAlertShown: false,
                    invalidationAlertShown: false,
                    wallAlertShown: false,
                    tradeStyle: 'SCALP',
                    isMemeTrade: true,
                    trailingStop: null,
                    peakPrice: signal.price,
                    trailingAlertShown: false,
                  })
                  showAlert(
                    `🎯 MEME SHORT открыт (shadow trailing).\n${signal.memePulse?.setupTag ?? ''}`
                  )
                }}
                className={`rounded-xl px-3 py-3 font-mono text-xs font-black uppercase tracking-wide transition-all active:scale-95 ${
                  signal.memePulse.shortBlocked
                    ? 'cursor-not-allowed border border-hull-border bg-hull/50 text-holo/30'
                    : 'border border-alert/50 bg-alert/20 text-alert shadow-[0_0_12px_rgba(255,0,60,0.25)]'
                }`}
              >
                {signal.memePulse.shortBlocked ? (
                  <span className="inline-flex items-center gap-1">
                    <Lock className="h-3 w-3" /> SHORT
                  </span>
                ) : (
                  '🎯 SHORT'
                )}
              </button>
            </div>
          )}

          {newsSettings.enabled && newsSettings.showInDrawer && (
            <div className="space-y-3">
              {newsSettings.showFearGreed && newsIntel.fearGreed && (
                <FearGreedGauge data={newsIntel.fearGreed} />
              )}
              <NewsPanel
                coinSentiment={
                  newsIntel.coinSentiments[signal.displayName.split('/')[0]] ??
                  null
                }
                symbol={signal.displayName.split('/')[0]}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-hull border border-hull-border rounded-lg p-3">
              <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                {t('tactical_rsi')}
              </div>
              <div className="text-lg font-mono font-bold text-holo">
                {signal.currentRSI !== null ? currentRSI.toFixed(1) : '--'}
              </div>
            </div>

            <div className="bg-hull border border-hull-border rounded-lg p-3">
              <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                {t('tactical_direction')}
              </div>
              <div className="text-lg font-mono font-bold text-holo">
                {direction || '--'}
              </div>
            </div>

            <div className="bg-hull border border-hull-border rounded-lg p-3">
              <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                {t('tactical_score')}
              </div>
              <div className="text-lg font-mono font-bold text-holo">
                {signal.score}/10
              </div>
            </div>

            <div className="bg-hull border border-hull-border rounded-lg p-3">
              <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                {t('tactical_trend')}
              </div>
              <div className="text-lg font-mono font-bold text-holo">
                {signal.coinTrend === 'BULLISH'
                  ? t('trend_bullish')
                  : signal.coinTrend === 'BEARISH'
                    ? t('trend_bearish')
                    : signal.coinTrend === 'RANGING'
                      ? t('trend_ranging')
                      : '--'}
              </div>
            </div>

            {signal.sl != null && (
              <div className="bg-hull border border-hull-border rounded-lg p-3">
                <div className="text-xs text-holo/40 font-mono uppercase mb-1">SL</div>
                <div className="text-lg font-mono font-bold text-alert">
                  {formatPrice(signal.sl)}
                </div>
              </div>
            )}

            {signal.tp1 != null && (
              <div className="bg-hull border border-hull-border rounded-lg p-3">
                <div className="text-xs text-holo/40 font-mono uppercase mb-1">TP1</div>
                <div className="text-lg font-mono font-bold text-matrix">
                  {formatPrice(signal.tp1)}
                </div>
              </div>
            )}

            {signal.tp2 != null && (
              <div className="bg-hull border border-hull-border rounded-lg p-3">
                <div className="text-xs text-holo/40 font-mono uppercase mb-1">TP2</div>
                <div className="text-lg font-mono font-bold text-matrix">
                  {formatPrice(signal.tp2)}
                </div>
              </div>
            )}

            {signal.dailyBias && (
              <div className="bg-hull border border-hull-border rounded-lg p-3">
                <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                  {t('tactical_daily_bias')}
                </div>
                <div className="text-sm font-mono font-bold text-holo">
                  {signal.dailyBias === 'BULLISH'
                    ? t('bias_bullish')
                    : signal.dailyBias === 'BEARISH'
                      ? t('bias_bearish')
                      : t('bias_neutral')}{' '}
                  {signal.dailyConfidence ?? ''}%
                </div>
              </div>
            )}

            {signal.htfTrend && (
              <div className="bg-hull border border-hull-border rounded-lg p-3">
                <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                  HTF Trend {signal.htfTrend.primaryTf.toUpperCase()}
                </div>
                <div
                  className={`text-sm font-mono font-bold ${
                    signal.htfTrend.bias === 'BULLISH'
                      ? 'text-matrix'
                      : signal.htfTrend.bias === 'BEARISH'
                        ? 'text-alert'
                        : 'text-holo/60'
                  }`}
                >
                  {signal.htfTrend.bias} · {signal.htfTrend.label}{' '}
                  {signal.htfTrend.strength}
                </div>
                <div className="mt-1 font-mono text-[10px] text-holo/35">
                  1H {signal.htfTrend.strength1h} · 4H{' '}
                  {signal.htfTrend.strength4h}
                </div>
              </div>
            )}
          </div>

          {mmIntent && <MmIntentPanel intent={mmIntent} />}
          {surgicalPlan && <SurgicalEntryPanel plan={surgicalPlan} />}
          {watchedForCoin > 0 && (
            <div className="rounded-xl border border-yellow-400/25 bg-yellow-400/5 px-3 py-2">
              <div className="font-mono text-[10px] font-bold uppercase text-yellow-300/80">
                Слежение
              </div>
              <p className="font-mono text-xs text-yellow-200/90">
                Активных watch по монете: {watchedForCoin}
              </p>
            </div>
          )}
          {signal.sessionFlipReason && (
            <div className="rounded-xl border border-yellow-400/25 bg-yellow-400/5 px-3 py-2">
              <div className="mb-1 font-mono text-[10px] font-bold uppercase tracking-wider text-yellow-300/80">
                Session Flip
              </div>
              <p className="font-mono text-xs text-yellow-200/90">
                {signal.sessionFlipReason}
              </p>
            </div>
          )}
          {liquidityMap && <LiquidityMagnetPanel map={liquidityMap} />}
          {btcDivergence && (
            <BtcDivergencePanel divergence={btcDivergence} />
          )}
          {whaleState && <WhaleWatcherPanel state={whaleState} />}
          {dna && <SessionDNAPanel dna={dna} />}
          {po3 && <PO3Panel analysis={po3} />}
          {tape && tape.signal !== 'NEUTRAL' && (
            <TapeMomentumIndicator momentum={tape} />
          )}
          {hasLTF && (
            <LTFAlignmentPanel
              mss={signal.mss ?? null}
              raid={signal.raid ?? null}
              ote={signal.ote ?? null}
            />
          )}
          {(signal?.absorption?.detected || signal?.ltfChoCH?.detected) && (
            <AbsorptionPanel
              absorption={signal.absorption}
              ltfChoCH={signal.ltfChoCH}
            />
          )}
          {aggressionState && (
            <BuyerAggressionIndicator aggression={aggressionState} />
          )}

          <LiveChart
            symbol={signal.internalSymbol}
            flatSymbol={signal.symbol}
            signal={signal}
          />

          <OrderBookPanel symbol={signal.internalSymbol} />

          <DataLog signal={signal} />
        </div>
      </div>
    </>
  )
}

export default TacticalDrawer
