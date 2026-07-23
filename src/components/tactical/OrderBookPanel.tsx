import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertCircle, Brain, Layers3 } from 'lucide-react'
import { fetchDepth, fetchRecentTrades } from '../../api/mexc'
import { updateWhaleWatcher } from '../../engine/orderbook/whaleDetector'
import { useAppStore } from '../../store/useAppStore'
import { computeTapeMomentum } from '../../engine/orderbook/tapeMomentum'
import {
  calculateOrderBookMetrics,
  calculateObDelta,
} from '../../engine/orderbook'
import { createWallTracker, updateWalls } from '../../engine/orderbook/wallTracker'
import {
  createHeatmap,
  updateHeatmap,
  suggestPriceStep,
} from '../../engine/orderbook/heatmap'
import {
  createHeatmap3D,
  addSnapshot3D,
  type Heatmap3DState,
} from '../../engine/orderbook/heatmap3d'
import {
  calculateWeightedObi,
  densityFromWalls,
  detectPriceProdding,
  computeMmIntent,
  spoofEventsFromWallUpdate,
  detectIcebergOrder,
  levelVolumeNear,
  type DensitySnapshot,
  type WeightedObiResult,
  type SpoofAlert,
  type IcebergResult,
} from '../../engine/mm'
import { useOrderBookHistory } from '../../hooks/useOrderBookHistory'
import { useMLPredictor } from '../../hooks/useMLPredictor'
import type {
  OrderBookState,
  WallTrackerState,
  HeatmapState,
  WallEvent,
  OrderBookSnapshot,
} from '../../engine/types'
import OrderBookLevelRow from './OrderBookLevel'
import OrderBookMetricsView from './OrderBookMetrics'
import ImbalanceChart from './ImbalanceChart'
import WallAlert from './WallAlert'
import WhaleAlertBanner from './WhaleAlertBanner'
import DepthSettings from './DepthSettings'
import MLPredictionPanel from './MLPredictionPanel'
import { logger } from '../../utils/logger'

const Heatmap3D = lazy(() => import('./Heatmap3D'))

interface Props {
  symbol: string
}

const UPDATE_INTERVAL = 2000

const OrderBookPanel = ({ symbol }: Props) => {
  const { t } = useTranslation()
  const setWhaleWatcher = useAppStore((s) => s.setWhaleWatcher)
  const setTapeMomentum = useAppStore((s) => s.setTapeMomentum)
  const setOrderBookMetrics = useAppStore((s) => s.setOrderBookMetrics)
  const setMmIntent = useAppStore((s) => s.setMmIntent)
  const setSpoofAlerts = useAppStore((s) => s.setSpoofAlerts)
  const setIcebergAlerts = useAppStore((s) => s.setIcebergAlerts)
  const setObDelta = useAppStore((s) => s.setObDelta)
  const liquidityMap = useAppStore((s) => s.liquidityMaps[symbol] ?? null)
  const whaleWatcherPrev = useAppStore((s) => s.whaleWatcher[symbol] ?? null)
  // ref для предыдущего состояния whale (избегаем stale closure)
  const whaleWatcherRef = useRef(whaleWatcherPrev)
  whaleWatcherRef.current = whaleWatcherPrev

  const [depthLimit, setDepthLimit] = useState(20)
  const [showML, setShowML] = useState(true)
  const [show3D, setShow3D] = useState(false)

  const [state, setState] = useState<OrderBookState>({
    snapshot: null,
    metrics: null,
    isLoading: true,
    error: null,
    lastUpdate: 0,
  })

  const wallTrackerRef = useRef<WallTrackerState>(createWallTracker())
  const heatmapRef = useRef<HeatmapState>(createHeatmap(0.1))
  const heatmapInitedRef = useRef(false)
  const prevSnapshotRef = useRef<OrderBookSnapshot | null>(null)
  const depthTickRef = useRef(0)
  const spoofBufRef = useRef<SpoofAlert[]>([])
  const icebergBufRef = useRef<IcebergResult[]>([])

  const [wallTracker, setWallTracker] = useState<WallTrackerState>(() =>
    createWallTracker()
  )
  const [heatmap3D, setHeatmap3D] = useState<Heatmap3DState>(() => createHeatmap3D(60))
  const [heatmapTick, setHeatmapTick] = useState(0)
  const [activeAlerts, setActiveAlerts] = useState<WallEvent[]>([])
  const [weightedObi, setWeightedObi] = useState<WeightedObiResult | null>(null)
  const [proddingLabel, setProddingLabel] = useState<string | null>(null)
  const [mmLabel, setMmLabel] = useState<string | null>(null)
  const densityHistoryRef = useRef<DensitySnapshot[]>([])

  const { history, stats, resetHistory } = useOrderBookHistory(state.metrics)

  const { prediction, model, isTraining } = useMLPredictor(
    history,
    stats,
    wallTracker,
    null,
    showML
  )

  const loadDepth = useCallback(async () => {
    try {
      const snapshot = await fetchDepth(symbol, depthLimit)
      const metrics = calculateOrderBookMetrics(snapshot)
      const obi = calculateWeightedObi(snapshot.bids, snapshot.asks)
      setWeightedObi(obi)
      setOrderBookMetrics(symbol, metrics)

      const obDelta = calculateObDelta(prevSnapshotRef.current, snapshot, 10)
      setObDelta(symbol, obDelta)
      depthTickRef.current += 1

      // Spoof from wall tracker (after walls update below) — buffer for MM
      let spoofAlerts = spoofBufRef.current
      let icebergAlerts = icebergBufRef.current

      let prodding = null as ReturnType<typeof detectPriceProdding> | null
      if (metrics.midPrice && metrics.walls.length) {
        const snap = densityFromWalls(metrics.midPrice, metrics.walls)
        densityHistoryRef.current = [...densityHistoryRef.current, snap].slice(-12)
        prodding = detectPriceProdding(densityHistoryRef.current)
        setProddingLabel(
          prodding.detected || prodding.exitSignal ? prodding.label : null
        )
      }

      const { tracker, newEvents } = updateWalls(
        wallTrackerRef.current,
        metrics.walls
      )
      wallTrackerRef.current = tracker
      setWallTracker(tracker)

      const freshSpoof = spoofEventsFromWallUpdate(
        newEvents,
        metrics.midPrice
      )
      if (freshSpoof.length) {
        spoofAlerts = [...spoofAlerts, ...freshSpoof].slice(-8)
        spoofBufRef.current = spoofAlerts
        setSpoofAlerts(
          symbol,
          spoofAlerts.map((s) => ({
            detected: s.detected,
            side: s.side,
            price: s.price,
            label: s.label,
            lifetimeMs: s.lifetimeMs,
            updatedAt: Date.now(),
          }))
        )
      }

      // Iceberg every ~3rd tick (~6s) with REST deals
      if (depthTickRef.current % 3 === 0 && metrics.midPrice) {
        try {
          const trades = await fetchRecentTrades(symbol, 80)
          const mid = metrics.midPrice
          const prevBid = levelVolumeNear(
            prevSnapshotRef.current?.bids ?? [],
            mid
          )
          const prevAsk = levelVolumeNear(
            prevSnapshotRef.current?.asks ?? [],
            mid
          )
          const curBid = levelVolumeNear(snapshot.bids, mid)
          const curAsk = levelVolumeNear(snapshot.asks, mid)
          const iceBuy = detectIcebergOrder({
            trades,
            prevLevelVolume: prevAsk,
            currentLevelVolume: curAsk,
            side: 'BUY',
          })
          const iceSell = detectIcebergOrder({
            trades,
            prevLevelVolume: prevBid,
            currentLevelVolume: curBid,
            side: 'SELL',
          })
          const ices = [iceBuy, iceSell].filter((i) => i.detected)
          if (ices.length) {
            icebergAlerts = ices
            icebergBufRef.current = ices
            setIcebergAlerts(
              symbol,
              ices.map((i) => ({
                detected: i.detected,
                side: i.side,
                price: i.price,
                label: i.label,
                bounceProbPct: i.bounceProbPct,
                updatedAt: Date.now(),
              }))
            )
          }
        } catch {
          /* deals optional */
        }
      }

      prevSnapshotRef.current = snapshot

      const intent = computeMmIntent({
        price: metrics.midPrice ?? snapshot.bids[0]?.price ?? 0,
        book: metrics,
        weightedObi: obi,
        prodding,
        spoofAlerts,
        icebergAlerts,
        liquidityMap,
      })
      setMmIntent(symbol, intent)
      setMmLabel(`${intent.emoji} ${intent.label}`)

      setState({
        snapshot,
        metrics,
        isLoading: false,
        error: null,
        lastUpdate: Date.now(),
      })

      const step = suggestPriceStep(metrics.midPrice)
      if (!heatmapInitedRef.current || heatmapRef.current.priceStep !== step) {
        heatmapRef.current = createHeatmap(step)
        heatmapInitedRef.current = true
      }
      heatmapRef.current = updateHeatmap(heatmapRef.current, snapshot)
      setHeatmapTick((n) => n + 1)

      setHeatmap3D((prev) => addSnapshot3D(prev, snapshot))

      // ── Whale Watcher ────────────────────────────────────────────────────
      if (metrics.midPrice && metrics.midPrice > 0) {
        const whaleState = updateWhaleWatcher(
          whaleWatcherRef.current,
          snapshot,
          symbol,
          metrics.midPrice
        )
        setWhaleWatcher(symbol, whaleState)
        whaleWatcherRef.current = whaleState
      }

      const alertEvents = newEvents.filter(
        (e) => e.type === 'EATEN' || e.type === 'SPOOFED'
      )
      if (alertEvents.length > 0) {
        setActiveAlerts((current) => [...current, ...alertEvents].slice(-5))
      }
    } catch (err) {
      logger.warn('[OrderBook] Load error:', err)
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      }))
    }
  }, [
    symbol,
    depthLimit,
    setWhaleWatcher,
    setOrderBookMetrics,
    setMmIntent,
    setSpoofAlerts,
    setIcebergAlerts,
    setObDelta,
    liquidityMap,
  ])

  useEffect(() => {
    setState({
      snapshot: null,
      metrics: null,
      isLoading: true,
      error: null,
      lastUpdate: 0,
    })
    const freshTracker = createWallTracker()
    wallTrackerRef.current = freshTracker
    setWallTracker(freshTracker)
    heatmapRef.current = createHeatmap(0.1)
    heatmapInitedRef.current = false
    setHeatmap3D(createHeatmap3D(60))
    setActiveAlerts([])
    setWeightedObi(null)
    setProddingLabel(null)
    densityHistoryRef.current = []
    prevSnapshotRef.current = null
    depthTickRef.current = 0
    spoofBufRef.current = []
    icebergBufRef.current = []
    resetHistory()
  }, [symbol, resetHistory])

  useEffect(() => {
    loadDepth()
    const interval = setInterval(loadDepth, UPDATE_INTERVAL)
    return () => clearInterval(interval)
  }, [loadDepth])

  // Вычисляем Tape Momentum при каждом обновлении stats
  useEffect(() => {
    if (!stats) return
    const momentum = computeTapeMomentum(history, stats)
    setTapeMomentum(symbol, momentum)
  }, [stats, history, symbol, setTapeMomentum])

  const handleDismissAlert = (index: number) => {
    setActiveAlerts((current) => current.filter((_, i) => i !== index))
  }

  const { snapshot, metrics, isLoading, error } = state
  const whaleState = useAppStore((s) => s.whaleWatcher[symbol] ?? null)
  const activeWhaleAlerts =
    whaleState?.alerts.filter((a) => a.isActive && !a.isExpired) ?? []
  const heatmap = heatmapRef.current
  void heatmapTick

  if (isLoading && !snapshot) {
    return (
      <div className="flex items-center justify-center rounded-lg bg-hull-light/20 p-6">
        <Loader2 className="mr-2 h-5 w-5 animate-spin text-holo/60" />
        <span className="text-sm text-holo/60">{t('orderbook_loading')}</span>
      </div>
    )
  }

  if (error && !snapshot) {
    return (
      <div className="flex items-center justify-center rounded-lg bg-hull-light/20 p-6">
        <AlertCircle className="mr-2 h-5 w-5 text-alert" />
        <span className="text-sm text-alert">
          {t('orderbook_error')}: {error}
        </span>
      </div>
    )
  }

  if (!snapshot || !metrics) return null

  const { bids, asks } = snapshot
  const maxVolume = Math.max(
    1,
    ...bids.map((l) => l.volume),
    ...asks.map((l) => l.volume)
  )
  const wallPrices = new Set(metrics.walls.map((w) => w.price))

  const formatMid = (price: number): string => {
    if (price >= 1000) {
      return price.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
    }
    if (price >= 1) {
      return price.toLocaleString('ru-RU', { maximumFractionDigits: 4 })
    }
    return price.toLocaleString('ru-RU', { maximumFractionDigits: 6 })
  }

  return (
    <div className="space-y-3">
      {activeWhaleAlerts.length > 0 && (
        <div className="space-y-2">
          {activeWhaleAlerts.map((alert) => (
            <WhaleAlertBanner key={alert.id} alert={alert} />
          ))}
        </div>
      )}

      {activeAlerts.length > 0 && (
        <div className="space-y-2">
          {activeAlerts.map((event, i) => (
            <WallAlert
              key={`${event.timestamp}-${event.wall.id}-${i}`}
              event={event}
              onDismiss={() => handleDismissAlert(i)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <h3 className="font-mono text-sm font-bold uppercase text-holo">
          {t('orderbook_title')}
        </h3>
        <div className="flex items-center gap-2">
          <DepthSettings currentDepth={depthLimit} onDepthChange={setDepthLimit} />
          <button
            type="button"
            onClick={() => setShowML((v) => !v)}
            className={`rounded p-1.5 transition-colors ${
              showML ? 'bg-holo/20 text-holo' : 'bg-hull-light/50 text-holo/50'
            }`}
            title={t('ml_prediction')}
          >
            <Brain className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setShow3D((v) => !v)}
            className={`rounded p-1.5 transition-colors ${
              show3D ? 'bg-holo/20 text-holo' : 'bg-hull-light/50 text-holo/50'
            }`}
            title={t('heatmap_3d')}
          >
            <Layers3 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {showML && (
        <MLPredictionPanel
          prediction={prediction}
          model={model}
          isTraining={isTraining}
        />
      )}

      {show3D && (
        <Suspense
          fallback={
            <div className="rounded-lg bg-hull-light/20 p-6 text-center">
              <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin text-holo/50" />
              <span className="text-xs text-holo/50">{t('heatmap_3d')}…</span>
            </div>
          }
        >
          <Heatmap3D heatmap3D={heatmap3D} />
        </Suspense>
      )}

      <ImbalanceChart history={history} stats={stats} />

      <OrderBookMetricsView metrics={metrics} />

      {(weightedObi || proddingLabel || mmLabel) && (
        <div className="space-y-1.5 rounded-lg bg-hull-light/30 p-3 font-mono text-[11px]">
          {mmLabel && (
            <div className="font-bold text-holo">{mmLabel}</div>
          )}
          {weightedObi && (
            <div
              className={
                weightedObi.nearTouchPressure === 'BUY'
                  ? 'text-matrix'
                  : weightedObi.nearTouchPressure === 'SELL'
                    ? 'text-alert'
                    : 'text-holo/60'
              }
            >
              OBI 0.1%/0.5%/1%: {weightedObi.label}
              {weightedObi.levels.map((l) => (
                <span key={l.bandPct} className="ml-2 text-holo/40">
                  {l.bandPct}%×{l.bidAskRatio.toFixed(1)}
                </span>
              ))}
            </div>
          )}
          {proddingLabel && (
            <div className="text-yellow-400">{proddingLabel}</div>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-lg bg-hull-light/20">
        <div className="space-y-px">
          {asks
            .slice()
            .reverse()
            .map((level, i) => (
              <OrderBookLevelRow
                key={`ask-${level.price}-${i}`}
                level={level}
                side="ASK"
                maxVolume={maxVolume}
                isWall={wallPrices.has(level.price)}
                heatmap={heatmap}
              />
            ))}
        </div>

        {metrics.midPrice != null && metrics.spread != null && (
          <div className="flex h-8 items-center justify-center border-y border-hull-border/50 bg-hull">
            <span className="font-mono text-xs text-holo/60">
              ${formatMid(metrics.midPrice)} · Δ{formatMid(metrics.spread)}
            </span>
          </div>
        )}

        <div className="space-y-px">
          {bids.map((level, i) => (
            <OrderBookLevelRow
              key={`bid-${level.price}-${i}`}
              level={level}
              side="BID"
              maxVolume={maxVolume}
              isWall={wallPrices.has(level.price)}
              heatmap={heatmap}
            />
          ))}
        </div>
      </div>

      <div className="text-center text-[10px] text-holo/40">
        {t('orderbook_update_hint_heatmap', { seconds: UPDATE_INTERVAL / 1000 })}
      </div>
    </div>
  )
}

export default OrderBookPanel
