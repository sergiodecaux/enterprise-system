import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertCircle, Brain, Layers3 } from 'lucide-react'
import { fetchDepth, fetchRecentTrades, fetchTicker, fetchSpotRecentTrades } from '../../api/mexc'
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
import { useMexcDepthStream } from '../../hooks/useMexcDepthStream'
import { useBinanceLeadStream } from '../../hooks/useBinanceLeadStream'
import { buildEnhancedCvd } from '../../engine/orderflow/enhancedCvd'
import { ingestAndDetectSequence, setSpotDeltaCache, deltaFromTrades } from '../../engine/sequence'
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
import DepthSettings from './DepthSettings'
import MLPredictionPanel from './MLPredictionPanel'
import { logger } from '../../utils/logger'

const Heatmap3D = lazy(() => import('./Heatmap3D'))

interface Props {
  symbol: string
}

/** REST fallback when WS is stale / down */
const REST_FALLBACK_MS = 5000

const OrderBookPanel = ({ symbol }: Props) => {
  const { t } = useTranslation()
  const setWhaleWatcher = useAppStore((s) => s.setWhaleWatcher)
  const setSequenceHit = useAppStore((s) => s.setSequenceHit)
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
  const oiRef = useRef<number | null>(null)
  const oiFetchedAtRef = useRef(0)
  const spotFetchedAtRef = useRef(0)

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

  const {
    snapshot: wsSnapshot,
    trades: wsTrades,
    isWsFresh,
    source: streamSource,
    ingestRestSnapshot,
    ingestRestTrades,
    error: wsError,
  } = useMexcDepthStream(symbol, depthLimit, true)

  // Binance USDT-M lead → venueLead cache → ingestAndDetect (arb wall risk)
  useBinanceLeadStream(symbol)

  const { history, stats, resetHistory } = useOrderBookHistory(state.metrics)

  const { prediction, model, isTraining } = useMLPredictor(
    history,
    stats,
    wallTracker,
    null,
    showML
  )

  const processSnapshot = useCallback(
    (snapshot: OrderBookSnapshot, tradesForIceberg: typeof wsTrades) => {
      const metrics = calculateOrderBookMetrics(snapshot)
      const obi = calculateWeightedObi(snapshot.bids, snapshot.asks)
      setWeightedObi(obi)
      setOrderBookMetrics(symbol, metrics)

      const obDelta = calculateObDelta(prevSnapshotRef.current, snapshot, 10)
      setObDelta(symbol, obDelta)
      depthTickRef.current += 1

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

      // Iceberg from live tape (WS) or REST batch
      if (
        metrics.midPrice &&
        tradesForIceberg.length >= 8 &&
        (isWsFresh || depthTickRef.current % 2 === 0)
      ) {
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
          trades: tradesForIceberg.slice(0, 80),
          prevLevelVolume: prevAsk,
          currentLevelVolume: curAsk,
          side: 'BUY',
        })
        const iceSell = detectIcebergOrder({
          trades: tradesForIceberg.slice(0, 80),
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
              status: i.status,
              confidencePct: i.confidencePct,
              updatedAt: Date.now(),
            }))
          )
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
      setMmLabel(intent.label)

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

      if (metrics.midPrice && metrics.midPrice > 0) {
        const whaleState = updateWhaleWatcher(
          whaleWatcherRef.current,
          snapshot,
          symbol,
          metrics.midPrice
        )
        setWhaleWatcher(symbol, whaleState)
        whaleWatcherRef.current = whaleState

        // Remizov sequence layer (client tactical — not meme bot)
        try {
          const cvd = buildEnhancedCvd({
            trades: tradesForIceberg.length ? tradesForIceberg : null,
          })
          // Feed PE/scanner the same tape CVD Remizov uses (not OHLCV proxy)
          if (cvd.source === 'TRADES' && cvd.tradeCount >= 8) {
            useAppStore.getState().setLiveTapeCvd(symbol, cvd)
          }
          const sig = useAppStore
            .getState()
            .signals.find((s) => s.internalSymbol === symbol)
          const regime = sig?.marketRegime ?? 'RANGING'

          // Refresh OI from ticker ~every 20s
          const nowTs = Date.now()
          if (nowTs - oiFetchedAtRef.current > 20_000) {
            oiFetchedAtRef.current = nowTs
            void fetchTicker(symbol)
              .then((t) => {
                if (t?.openInterest != null && t.openInterest > 0) {
                  oiRef.current = t.openInterest
                }
              })
              .catch(() => {
                /* optional */
              })
          }

          // Spot tape for Spot/Perp health ~every 15s
          if (nowTs - spotFetchedAtRef.current > 15_000) {
            spotFetchedAtRef.current = nowTs
            void fetchSpotRecentTrades(symbol, 80)
              .then((spotTrades) => {
                setSpotDeltaCache(
                  symbol,
                  deltaFromTrades(spotTrades, 5 * 60_000)
                )
              })
              .catch(() => {
                /* optional — CORS / proxy */
              })
          }

          const hit = ingestAndDetectSequence({
            symbol,
            price: metrics.midPrice,
            regime,
            whale: whaleState,
            walls: metrics.walls,
            wallEvents: newEvents,
            trades: tradesForIceberg.length ? tradesForIceberg : null,
            cvd,
            bookImbalance: metrics.imbalance,
            openInterest: oiRef.current,
            atrPct: sig?.atrPct ?? null,
            spreadBps:
              metrics.spreadPercent != null
                ? metrics.spreadPercent * 100
                : null,
          })
          setSequenceHit(symbol, hit)
        } catch {
          /* sequence optional */
        }
      }

      const alertEvents = newEvents.filter(
        (e) => e.type === 'EATEN' || e.type === 'SPOOFED'
      )
      if (alertEvents.length > 0) {
        setActiveAlerts((current) => [...current, ...alertEvents].slice(-5))
      }
    },
    [
      symbol,
      setWhaleWatcher,
      setSequenceHit,
      setOrderBookMetrics,
      setMmIntent,
      setSpoofAlerts,
      setIcebergAlerts,
      setObDelta,
      liquidityMap,
      isWsFresh,
    ]
  )

  const lastProcessRef = useRef(0)

  // Primary: WebSocket snapshots (throttle ~250ms to avoid React thrash)
  useEffect(() => {
    if (!wsSnapshot || !isWsFresh) return
    const now = Date.now()
    if (now - lastProcessRef.current < 250) return
    lastProcessRef.current = now
    processSnapshot(wsSnapshot, wsTrades)
  }, [wsSnapshot, wsTrades, isWsFresh, processSnapshot])

  // Fallback REST when WS stale/down
  useEffect(() => {
    let cancelled = false
    const loadRest = async () => {
      if (isWsFresh) return
      try {
        const snapshot = await fetchDepth(symbol, depthLimit)
        if (cancelled) return
        ingestRestSnapshot(snapshot)
        processSnapshot(snapshot, wsTrades)
        try {
          const trades = await fetchRecentTrades(symbol, 80)
          if (!cancelled) ingestRestTrades(trades)
        } catch {
          /* optional */
        }
      } catch (err) {
        logger.warn('[OrderBook] REST fallback error:', err)
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            isLoading: false,
            error:
              prev.snapshot || wsError
                ? prev.error
                : err instanceof Error
                  ? err.message
                  : 'Unknown error',
          }))
        }
      }
    }

    void loadRest()
    const interval = window.setInterval(() => void loadRest(), REST_FALLBACK_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [
    symbol,
    depthLimit,
    isWsFresh,
    processSnapshot,
    ingestRestSnapshot,
    ingestRestTrades,
    wsTrades,
    wsError,
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
  const heatmap = heatmapRef.current
  void heatmapTick

  if (isLoading && !snapshot) {
    return (
      <div className="flex items-center justify-center rounded-md border border-border bg-bg-panel/40 p-6">
        <Loader2 className="mr-2 h-4 w-4 animate-spin text-text-muted" />
        <span className="font-sans text-[12px] text-text-secondary">
          {t('orderbook_loading')}
        </span>
      </div>
    )
  }

  if (error && !snapshot) {
    return (
      <div className="flex items-center justify-center rounded-md border border-market-short/20 bg-market-short/[0.06] p-6">
        <AlertCircle className="mr-2 h-4 w-4 text-market-short" />
        <span className="font-sans text-[12px] text-market-short">
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

  const obiBand =
    weightedObi?.levels.find((l) => l.bandPct === 0.5) ??
    weightedObi?.levels[0] ??
    null
  const obiBidShare = obiBand
    ? (obiBand.bidVolume /
        Math.max(1e-9, obiBand.bidVolume + obiBand.askVolume)) *
      100
    : 50

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
      {/* Wall alerts only — whale toasts live in drawer overlay (no layout jump) */}
      {activeAlerts.length > 0 && (
        <div className="max-h-24 space-y-1.5 overflow-y-auto overscroll-contain">
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
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="truncate font-sans text-[13px] font-medium leading-5 text-text-primary">
            {t('orderbook_title')}
          </h3>
          <span
            className={`font-mono text-[11px] leading-4 ${
              streamSource === 'ws' ? 'text-brand' : 'text-text-muted'
            }`}
          >
            {streamSource === 'ws' ? 'LIVE' : 'REST'}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <DepthSettings currentDepth={depthLimit} onDepthChange={setDepthLimit} />
          <button
            type="button"
            onClick={() => setShowML((v) => !v)}
            className={`inline-flex h-10 w-10 items-center justify-center rounded-md border transition-colors desk:h-8 desk:w-8 ${
              showML
                ? 'border-brand/25 bg-brand/10 text-brand'
                : 'border-border bg-bg-panel text-text-muted hover:text-text-primary'
            }`}
            title={t('ml_prediction')}
          >
            <Brain className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setShow3D((v) => !v)}
            className={`inline-flex h-10 w-10 items-center justify-center rounded-md border transition-colors desk:h-8 desk:w-8 ${
              show3D
                ? 'border-brand/25 bg-brand/10 text-brand'
                : 'border-border bg-bg-panel text-text-muted hover:text-text-primary'
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
            <div className="rounded-md border border-border bg-bg-panel/40 p-6 text-center">
              <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin text-text-muted" />
              <span className="font-sans text-[12px] text-text-secondary">
                {t('heatmap_3d')}…
              </span>
            </div>
          }
        >
          <Heatmap3D heatmap3D={heatmap3D} />
        </Suspense>
      )}

      <ImbalanceChart history={history} stats={stats} />

      <OrderBookMetricsView metrics={metrics} />

      {(weightedObi || proddingLabel || mmLabel) && (
        <div className="space-y-1.5 rounded-md border border-border bg-bg-panel/40 px-2.5 py-2 font-mono text-[11px] leading-4">
          {mmLabel && (
            <div className="font-sans text-[12px] font-medium text-text-primary">
              {mmLabel}
            </div>
          )}
          {weightedObi && (
            <div
              className={
                weightedObi.nearTouchPressure === 'BUY'
                  ? 'text-market-long'
                  : weightedObi.nearTouchPressure === 'SELL'
                    ? 'text-market-short'
                    : 'text-text-secondary'
              }
            >
              OBI 0.1% / 0.5% / 1%: {weightedObi.label}
              {weightedObi.levels.map((l) => (
                <span key={l.bandPct} className="ml-2 text-text-muted">
                  {l.bandPct}%×{l.bidAskRatio.toFixed(1)}
                </span>
              ))}
            </div>
          )}
          {proddingLabel && (
            <div className="text-market-warning">{proddingLabel}</div>
          )}
        </div>
      )}

      {weightedObi && (
        <div className="rounded-md border border-border bg-bg-panel/60 px-2 py-1.5">
          <div className="flex items-center justify-between gap-2 font-sans text-[11px] leading-4">
            <span className="text-text-muted">Дисбаланс ±0.5%</span>
            <span className="tnum font-mono text-text-secondary">
              <span className="text-market-long">
                {obiBidShare.toFixed(0)}% bids
              </span>
              <span className="mx-1 text-text-muted">/</span>
              <span className="text-market-short">
                {(100 - obiBidShare).toFixed(0)}% asks
              </span>
            </span>
          </div>
          <div className="mt-1 flex h-[3px] overflow-hidden rounded-full bg-bg-surface">
            <div
              className="bg-market-long transition-[width] duration-300"
              style={{ width: `${obiBidShare}%` }}
            />
            <div className="flex-1 bg-market-short" />
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-border bg-bg-panel/30">
        <div className="flex items-center justify-between border-b border-border px-2 py-1 font-sans text-[11px] leading-4 text-text-muted">
          <span>Цена</span>
          <span>Объём</span>
        </div>

        <div>
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
          <div className="flex h-8 items-center justify-between border-y border-border bg-bg-elevated px-2">
            <span className="tnum font-mono text-[13px] font-medium text-text-primary">
              ${formatMid(metrics.midPrice)}
            </span>
            <span className="tnum font-mono text-[11px] text-text-muted">
              Δ {formatMid(metrics.spread)}
            </span>
          </div>
        )}

        <div>
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

      <div className="text-center font-sans text-[11px] leading-4 text-text-muted">
        {streamSource === 'ws'
          ? 'Стакан: WebSocket live · лента сделок online'
          : `Стакан: REST fallback ~${REST_FALLBACK_MS / 1000}с`}
      </div>
    </div>
  )
}

export default OrderBookPanel
