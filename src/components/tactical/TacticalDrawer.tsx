import { useEffect, useRef, useMemo } from 'react'
import { Magnet, X } from 'lucide-react'
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
  PO3Analysis,
  SessionDNA,
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

/** Панель Whale Watcher в Drawer */
const WhaleWatcherPanel = ({ state }: { state: WhaleWatcherState }) => {
  const hasWhales =
    state.strongestSupport !== null || state.strongestResistance !== null

  const activeAlerts = state.alerts.filter((a) => a.isActive && !a.isExpired)

  if (!hasWhales && activeAlerts.length === 0) return null

  const formatPrice = (price: number): string => {
    if (price >= 1000)
      return price.toLocaleString('en-US', { maximumFractionDigits: 0 })
    if (price >= 1) return price.toFixed(4)
    return price.toFixed(6)
  }

  return (
    <div className="rounded-xl border border-hull-border bg-hull p-3">
      {/* Заголовок */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-base">🐋</span>
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          Наблюдатель китов
        </span>
        {state.scoreBoost > 0 && (
          <span className="ml-auto rounded bg-cyan-400/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-cyan-400">
            +{state.scoreBoost.toFixed(1)} к оценке
          </span>
        )}
      </div>

      {/* Активные алерты */}
      {activeAlerts.length > 0 && (
        <div className="mb-3 space-y-2">
          {activeAlerts.slice(0, 3).map((alert) => (
            <WhaleAlertBanner key={alert.id} alert={alert} />
          ))}
        </div>
      )}

      {/* Strongest Support / Resistance */}
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

const TacticalDrawer = () => {
  const { t } = useTranslation()
  const { haptic } = useTelegramWebApp()
  const selectedCoin = useAppStore((state) => state.selectedCoin)
  const isDrawerOpen = useAppStore((state) => state.isDrawerOpen)
  const signals = useAppStore((state) => state.signals)
  const setDrawerOpen = useAppStore((state) => state.setDrawerOpen)
  const selectCoin = useAppStore((state) => state.selectCoin)
  const newsSettings = useAppStore((state) => state.newsSettings)
  const newsIntel = useAppStore((state) => state.newsIntel)
  const liquidityMaps = useAppStore((state) => state.liquidityMaps)
  const whaleWatcher = useAppStore((state) => state.whaleWatcher)
  const sessionDNA = useAppStore((state) => state.sessionDNA)
  const po3Store = useAppStore((state) => state.po3Analysis)
  const tapeStore = useAppStore((state) => state.tapeMomentum)
  const aggressionStore = useAppStore((state) => state.buyerAggression)

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
  const hasLTF = !!(
    signal?.mss?.detected ||
    (signal?.raid && signal.raid.type !== 'NONE') ||
    signal?.ote?.isActive
  )

  useBuyerAggression(isDrawerOpen && signal ? signal.internalSymbol : null)

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
        className={`fixed bottom-0 left-0 right-0 w-full max-h-[85vh] bg-space border-t border-hull-border rounded-t-2xl overflow-y-auto z-50 transition-transform duration-400 ease-out ${
          isDrawerOpen
            ? 'translate-y-0 opacity-100'
            : 'translate-y-full opacity-0 pointer-events-none'
        }`}
        style={{
          transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div className="flex justify-center my-3">
          <div className="w-12 h-1 bg-hull-border rounded-full" />
        </div>

        <div className="px-4 pb-4 border-b border-hull-border/50">
          <div className="flex items-start justify-between mb-2">
            <div className="flex-1">
              <h2 className="text-2xl font-mono font-bold text-holo mb-1">
                {signal.displayName}
              </h2>
              <div className="flex items-center gap-3 text-sm font-mono">
                <span className="text-holo/80">${formatPrice(signal.price)}</span>
                <span
                  className={signal.priceChange24h >= 0 ? 'text-matrix' : 'text-alert'}
                >
                  {formatChange(signal.priceChange24h)}
                </span>
                {signal.hasActiveSetup && (
                  <span className="text-matrix text-xs uppercase">{t('signal_setup')}</span>
                )}
              </div>
            </div>
            <button
              onClick={handleClose}
              className="p-2 hover:bg-hull-light rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-holo/60" />
            </button>
          </div>
        </div>

        <div className="space-y-6 px-4 py-6">
          {compositeAnalysis && (
            <CompositeAnalysisPanel analysis={compositeAnalysis} />
          )}

          <div className="flex justify-center">
            <ProbabilityGauge value={probability} direction={direction} />
          </div>

          {signal.memePulse && <MemePulsePanel meme={signal.memePulse} />}

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
          </div>

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
