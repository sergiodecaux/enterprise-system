/**
 * Scenario paths as native chart series so they stay glued to candles while panning.
 * Catmull-Rom is densified in time/price, then drawn by lightweight-charts.
 */

import { useEffect, useRef } from 'react'
import type {
  IChartApi,
  ISeriesApi,
  LineData,
  SeriesMarker,
  Time,
} from 'lightweight-charts'
import type { PathPoint } from '../../engine/prediction/types'

export interface CurvePath {
  id: string
  points: PathPoint[]
  color: string
  label: string
  emphasis: boolean
}

interface Props {
  chart: IChartApi | null
  lastCandleTs: number
  barSeconds: number
  paths: CurvePath[]
}

function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  )
}

function densify(points: PathPoint[], anchor: number): LineData[] {
  if (points.length < 2) return []
  const raw: { t: number; v: number }[] = []
  const steps = 8
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i - 1] ?? points[i]
    const b = points[i]
    const c = points[i + 1]
    const d = points[i + 2] ?? c
    for (let s = 0; s < steps; s++) {
      const u = s / steps
      raw.push({
        t: cr(a.timeOffsetSeconds, b.timeOffsetSeconds, c.timeOffsetSeconds, d.timeOffsetSeconds, u),
        v: cr(a.price, b.price, c.price, d.price, u),
      })
    }
  }
  const last = points[points.length - 1]
  raw.push({ t: last.timeOffsetSeconds, v: last.price })

  const out: LineData[] = []
  let prev = Number.NEGATIVE_INFINITY
  for (const p of raw) {
    let time = Math.round(anchor + p.t)
    if (time <= prev) time = prev + 1
    prev = time
    if (!(p.v > 0)) continue
    out.push({ time: time as Time, value: p.v })
  }
  return out
}

const CurvePathOverlay = ({
  chart,
  lastCandleTs,
  barSeconds,
  paths,
}: Props) => {
  const seriesRef = useRef<ISeriesApi<'Line'>[]>([])

  useEffect(() => {
    if (!chart) return
    for (const s of seriesRef.current) {
      try {
        chart.removeSeries(s)
      } catch {
        /* ignore */
      }
    }
    seriesRef.current = []
    if (!lastCandleTs || !paths.length) return

    const bar = Math.max(1, barSeconds)
    const maxBars = Math.max(
      0,
      ...paths.flatMap((p) => p.points.map((pt) => pt.timeOffsetSeconds / bar))
    )
    try {
      const ts = chart.timeScale()
      const current = ts.options().rightOffset ?? 8
      const extra = Math.min(40, Math.ceil(maxBars) + 6)
      if (extra > current + 1) ts.applyOptions({ rightOffset: extra })
    } catch {
      /* ignore */
    }

    for (const path of paths) {
      const data = densify(path.points, lastCandleTs)
      if (data.length < 2) continue
      try {
        const line = chart.addLineSeries({
          color: path.color,
          lineWidth: path.emphasis ? 2 : 1,
          lineStyle: path.emphasis ? 0 : 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          title: '',
          autoscaleInfoProvider: () => null,
        })
        line.setData(data)
        const first = data[0].value
        const last = data[data.length - 1]
        const down = last.value < first
        const markers: SeriesMarker<Time>[] = [
          {
            time: last.time,
            position: 'inBar',
            color: path.color,
            shape: down ? 'arrowDown' : 'arrowUp',
            text: path.label,
          },
        ]
        line.setMarkers(markers)
        seriesRef.current.push(line)
      } catch {
        /* disposed chart or duplicate timestamps */
      }
    }

    return () => {
      for (const s of seriesRef.current) {
        try {
          chart.removeSeries(s)
        } catch {
          /* ignore */
        }
      }
      seriesRef.current = []
    }
  }, [chart, lastCandleTs, barSeconds, paths])

  return null
}

export default CurvePathOverlay
