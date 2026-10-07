/**
 * One layout pass for chart text. Overlays submit a label per frame;
 * resolveCollisions() keeps higher-priority rows and shifts or hides the rest.
 * Geometry (lines, bands, boxes) stays in the overlays — only text Y is coordinated.
 */

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'

export const LABEL_MIN_GAP = 16
export const LABEL_SHIFT_STEP = 16
export const LABEL_SHIFT_TRIES = 6
export const LABEL_CROWD_PX = 100
export const LABEL_CROWD_MAX = 5

/** Higher number keeps the row. 100 is never hidden. */
export const LABEL_PRIORITY = {
  now: 100,
  structure: 90,
  fib: 85,
  /** Active engine forecast: «цель», «топливо». */
  story: 80,
  daily: 70,
  /** Scenario path captions on StructureOverlay. */
  swing: 65,
  zone: 60,
  whale: 50,
  /** Liquidation pills on the candle plot. */
  liq: 50,
  secondary: 30,
} as const

export interface LabelRequest {
  id: string
  /** Pixel Y of the price row this text belongs to. */
  priceY: number
  text: string
  priority: number
  sourceLayer: string
  height: number
  /**
   * Secondary text drawn inside another label (volume inside a whale badge).
   * It follows that row instead of taking its own slot, and hides when the
   * row still collides with something more important.
   */
  attachTo?: string
}

export interface PlacedLabel extends LabelRequest {
  y: number
  hidden: boolean
}

export interface LabelBounds {
  minY: number
  maxY: number
}

const DEFAULT_BOUNDS: LabelBounds = { minY: 16, maxY: 10_000 }

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function separation(a: Pick<LabelRequest, 'height'>, b: Pick<LabelRequest, 'height'>): number {
  return Math.max(LABEL_MIN_GAP, (a.height + b.height) / 2)
}

function crowds(placed: PlacedLabel[], y: number): boolean {
  const visible = placed.filter((p) => !p.hidden && !p.attachTo)
  const neighbors = visible.filter((p) => Math.abs(p.y - y) <= LABEL_CROWD_PX)
  if (neighbors.length >= LABEL_CROWD_MAX) return true
  // Adding y must not push an existing 100px band over the cap.
  for (const neighbor of neighbors) {
    let around = 0
    for (const other of visible) {
      if (Math.abs(other.y - neighbor.y) <= LABEL_CROWD_PX) around += 1
    }
    if (around >= LABEL_CROWD_MAX) return true
  }
  return false
}

/**
 * Sort by priority (desc), then priceY. Each label yields to an already
 * placed row within minGap: shift down (then up) like IctMarksOverlay, or
 * hide when the band is full or there is nowhere to move.
 */
export function resolveCollisions(
  requests: LabelRequest[],
  bounds: LabelBounds = DEFAULT_BOUNDS,
): PlacedLabel[] {
  const minY = bounds.minY
  const maxY = Math.max(minY, bounds.maxY)
  const toY = (y: number) => clamp(Math.round(y), minY, maxY)

  const unique = new Map<string, LabelRequest>()
  for (const raw of requests) {
    if (!Number.isFinite(raw.priceY)) continue
    const req: LabelRequest = {
      ...raw,
      priceY: raw.priceY,
      height: raw.height > 0 ? raw.height : LABEL_MIN_GAP,
    }
    const prev = unique.get(req.id)
    if (!prev || req.priority >= prev.priority) unique.set(req.id, req)
  }

  const roots: LabelRequest[] = []
  const attached: LabelRequest[] = []
  for (const req of unique.values()) {
    if (req.attachTo) attached.push(req)
    else roots.push(req)
  }
  roots.sort((a, b) => b.priority - a.priority || a.priceY - b.priceY)

  const placed: PlacedLabel[] = []

  const blocked = (y: number, req: LabelRequest): boolean =>
    placed.some(
      (p) => !p.hidden && !p.attachTo && Math.abs(p.y - y) < separation(req, p),
    )

  for (const req of roots) {
    const neverHide = req.priority >= LABEL_PRIORITY.now
    const own = toY(req.priceY)
    let y: number | null = null
    const candidates = [own]
    for (let i = 1; i <= LABEL_SHIFT_TRIES; i++) {
      candidates.push(toY(req.priceY + i * LABEL_SHIFT_STEP))
      candidates.push(toY(req.priceY - i * LABEL_SHIFT_STEP))
    }
    const seen = new Set<number>()
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue
      seen.add(candidate)
      if (blocked(candidate, req)) continue
      if (!neverHide && crowds(placed, candidate)) continue
      y = candidate
      break
    }
    if (y == null) {
      placed.push({ ...req, y: own, hidden: !neverHide })
      continue
    }
    placed.push({ ...req, y, hidden: false })
  }

  for (const req of attached) {
    const host = placed.find((p) => p.id === req.attachTo)
    if (!host || host.hidden) {
      placed.push({ ...req, y: toY(req.priceY), hidden: true })
      continue
    }
    const contested = placed.some(
      (p) =>
        !p.hidden &&
        !p.attachTo &&
        p.id !== host.id &&
        p.priority > req.priority &&
        Math.abs(p.y - host.y) < separation(req, p),
    )
    const packed = !contested && crowds(placed, host.y)
    placed.push({
      ...req,
      y: host.y,
      hidden: contested || packed,
    })
  }

  return placed
}

export interface ChartLabelsApi {
  submit(requests: LabelRequest[]): void
  clear(sourceLayer: string): void
  setBounds(bounds: LabelBounds): void
  placedFor(sourceLayer: string): PlacedLabel[]
  subscribe(listener: () => void): () => void
}

function sameRequests(a: LabelRequest[] | undefined, b: LabelRequest[]): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.priceY !== y.priceY ||
      x.text !== y.text ||
      x.priority !== y.priority ||
      x.height !== y.height ||
      x.sourceLayer !== y.sourceLayer ||
      x.attachTo !== y.attachTo
    ) {
      return false
    }
  }
  return true
}

export function createChartLabelsApi(): ChartLabelsApi {
  const layers = new Map<string, LabelRequest[]>()
  let placed: PlacedLabel[] = []
  let bounds: LabelBounds = { ...DEFAULT_BOUNDS }
  const listeners = new Set<() => void>()
  let scheduled = false
  let flushing = false
  let dirty = false

  const flush = () => {
    scheduled = false
    flushing = true
    const all: LabelRequest[] = []
    for (const list of layers.values()) all.push(...list)
    placed = resolveCollisions(all, bounds)
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        /* one overlay must not cancel the frame */
      }
    }
    flushing = false
    if (dirty) {
      dirty = false
      schedule()
    }
  }

  const schedule = () => {
    if (flushing) {
      dirty = true
      return
    }
    if (scheduled) return
    scheduled = true
    queueMicrotask(flush)
  }

  return {
    submit(requests) {
      if (!requests.length) return
      const grouped = new Map<string, LabelRequest[]>()
      for (const raw of requests) {
        const req: LabelRequest = {
          ...raw,
          priceY: Number.isFinite(raw.priceY) ? Math.round(raw.priceY) : bounds.minY,
          height: raw.height > 0 ? raw.height : LABEL_MIN_GAP,
        }
        const list = grouped.get(req.sourceLayer)
        if (list) list.push(req)
        else grouped.set(req.sourceLayer, [req])
      }
      let changed = false
      for (const [layer, list] of grouped) {
        if (sameRequests(layers.get(layer), list)) continue
        layers.set(layer, list)
        changed = true
      }
      if (changed) schedule()
    },
    clear(sourceLayer) {
      if (!layers.has(sourceLayer)) return
      layers.delete(sourceLayer)
      schedule()
    },
    setBounds(next) {
      const minY = Math.round(next.minY)
      const maxY = Math.round(Math.max(minY, next.maxY))
      if (bounds.minY === minY && bounds.maxY === maxY) return
      bounds = { minY, maxY }
      if (layers.size) schedule()
    },
    placedFor(sourceLayer) {
      return placed.filter((p) => p.sourceLayer === sourceLayer)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const ChartLabelsContext = createContext<ChartLabelsApi | null>(null)

export function useChartLabels(): ChartLabelsApi {
  const ctx = useContext(ChartLabelsContext)
  const fallback = useRef<ChartLabelsApi | null>(null)
  if (ctx) return ctx
  if (!fallback.current) fallback.current = createChartLabelsApi()
  return fallback.current
}

export function ChartLabelsProvider({
  children,
  containerRef,
}: {
  children: ReactNode
  containerRef: RefObject<HTMLDivElement | null>
}) {
  const apiRef = useRef<ChartLabelsApi | null>(null)
  if (!apiRef.current) apiRef.current = createChartLabelsApi()
  const api = apiRef.current

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const apply = () => {
      const h = el.clientHeight
      if (h < 40) return
      api.setBounds({ minY: 16, maxY: h - 14 })
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [api, containerRef])

  return <ChartLabelsContext.Provider value={api}>{children}</ChartLabelsContext.Provider>
}

/**
 * Publish this overlay's labels unless the call is the manager's own repaint.
 * Returns the latest placement (possibly from the previous frame until the
 * microtask resolve lands).
 */
export function publishLabels(
  api: ChartLabelsApi,
  sourceLayer: string,
  fromListener: boolean,
  requests: LabelRequest[],
  bounds?: LabelBounds,
): Map<string, PlacedLabel> {
  if (!fromListener) {
    if (bounds) api.setBounds(bounds)
    if (requests.length === 0) api.clear(sourceLayer)
    else api.submit(requests.map((r) => ({ ...r, sourceLayer })))
  }
  const map = new Map<string, PlacedLabel>()
  for (const label of api.placedFor(sourceLayer)) map.set(label.id, label)
  return map
}

/** Null means the manager hid this label — do not draw it. */
export function labelAnchor(
  placed: Map<string, PlacedLabel>,
  id: string,
  fallbackY: number,
): number | null {
  const label = placed.get(id)
  if (!label) return fallbackY
  if (label.hidden) return null
  return label.y
}

export function labelShown(placed: Map<string, PlacedLabel>, id: string): boolean {
  const label = placed.get(id)
  if (!label) return true
  return !label.hidden
}

/** Repaint only when this layer's Y or visibility actually changed. */
export function watchLayer(
  api: ChartLabelsApi,
  sourceLayer: string,
  onChange: () => void,
): () => void {
  let key = ''
  return api.subscribe(() => {
    const next = api
      .placedFor(sourceLayer)
      .map((p) => `${p.id}:${p.y}:${p.hidden ? 1 : 0}`)
      .join('|')
    if (next === key) return
    key = next
    onChange()
  })
}

/**
 * Reserves the live price row at priority 100 so other captions move off
 * the current-price line. The axis already draws that price; this slot is not painted.
 */
export function ReserveNowPrice({
  chart,
  series,
  price,
}: {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  price: number
}) {
  const layout = useChartLabels()
  const priceRef = useRef(price)
  priceRef.current = price

  useLayoutEffect(() => {
    if (!chart || !series) {
      layout.clear('now')
      return
    }
    const submit = () => {
      const px = priceRef.current
      if (!(px > 0)) {
        layout.clear('now')
        return
      }
      let y = 16
      try {
        const coord = series.priceToCoordinate(px)
        if (coord != null && Number.isFinite(Number(coord))) y = Number(coord)
      } catch {
        /* keep the edge slot */
      }
      layout.submit([
        {
          id: 'now-price',
          priceY: y,
          text: 'Сейчас',
          priority: LABEL_PRIORITY.now,
          sourceLayer: 'now',
          height: 18,
        },
      ])
    }
    submit()
    chart.timeScale().subscribeVisibleLogicalRangeChange(submit)
    chart.subscribeCrosshairMove(submit)
    return () => {
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(submit)
        chart.unsubscribeCrosshairMove(submit)
      } catch {
        /* chart may already be gone */
      }
      layout.clear('now')
    }
  }, [chart, series, layout])

  useLayoutEffect(() => {
    if (!chart || !series || !(price > 0)) return
    let y = 16
    try {
      const coord = series.priceToCoordinate(price)
      if (coord != null && Number.isFinite(Number(coord))) y = Number(coord)
    } catch {
      return
    }
    layout.submit([
      {
        id: 'now-price',
        priceY: y,
        text: 'Сейчас',
        priority: LABEL_PRIORITY.now,
        sourceLayer: 'now',
        height: 18,
      },
    ])
  }, [chart, series, layout, price])

  return null
}
