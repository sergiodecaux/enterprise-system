/**
 * Draw bounce/break paths for zone trade variants on the chart.
 */

import { useEffect, useRef } from 'react'
import type {
  IChartApi,
  ISeriesApi,
  Time,
  LineData,
} from 'lightweight-charts'
import type { ConditionalSetup } from '../../engine/setups'
import type { PathPoint } from '../../engine/prediction/types'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  setups: ConditionalSetup[]
  selectedId: string | null
  lastCandleTs: number
  containerRef: React.RefObject<HTMLDivElement>
}

function toLineData(path: PathPoint[], anchor: number): LineData[] {
  return path
    .map((pp) => ({
      time: (anchor + pp.timeOffsetSeconds) as Time,
      value: pp.price,
    }))
    .filter(
      (p, i, arr) =>
        i === 0 || (p.time as number) > (arr[i - 1].time as number)
    )
}

const ZonePathOverlay = ({
  chart,
  series,
  setups,
  selectedId,
  lastCandleTs,
  containerRef,
}: Props) => {
  const refs = useRef<Record<string, ISeriesApi<'Line'>>>({})

  useEffect(() => {
    if (!chart) return

    for (const id of Object.keys(refs.current)) {
      try {
        chart.removeSeries(refs.current[id])
      } catch {
        /* ignore */
      }
      delete refs.current[id]
    }

    const withPath = setups.filter((s) => s.chartPath && s.chartPath.length >= 2)
    if (!withPath.length || !lastCandleTs) return

    // Prefer selected; else show up to 4 paths
    const ordered = selectedId
      ? [
          ...withPath.filter((s) => s.id === selectedId),
          ...withPath.filter((s) => s.id !== selectedId),
        ]
      : withPath
    const visible = ordered.slice(0, 4)

    for (const s of visible) {
      const isSel = s.id === selectedId
      const color =
        s.kind === 'STOP_THEN_REVERSE'
          ? isSel
            ? '#f97316'
            : '#f9731688'
          : s.side === 'LONG'
            ? isSel
              ? '#22c55e'
              : '#22c55e99'
            : isSel
              ? '#ef4444'
              : '#ef444499'

      const line = chart.addLineSeries({
        color,
        lineWidth: isSel ? 2 : 1,
        lineStyle: s.kind === 'STOP_THEN_REVERSE' ? 2 : 0,
        priceLineVisible: false,
        lastValueVisible: isSel,
        crosshairMarkerVisible: isSel,
        title: isSel ? s.title.slice(0, 18) : '',
      })
      line.setData(toLineData(s.chartPath!, lastCandleTs))
      refs.current[s.id] = line
    }

    return () => {
      for (const id of Object.keys(refs.current)) {
        try {
          chart.removeSeries(refs.current[id])
        } catch {
          /* ignore */
        }
        delete refs.current[id]
      }
    }
  }, [chart, series, setups, selectedId, lastCandleTs, containerRef])

  return null
}

export default ZonePathOverlay
