/**
 * Structure overlay: price lines for crowd / reclaim.
 * A flight path is drawn only when the trap thesis says the trade is real.
 */

import { useEffect, useRef } from 'react'
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  Time,
  LineData,
} from 'lightweight-charts'
import type { StructureRead } from '../../engine/smc/structureRead'
import type { PathPoint } from '../../engine/prediction/types'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  read: StructureRead | null
  lastCandleTs: number
  showPath: boolean
}

function toLineData(path: PathPoint[], anchor: number): LineData[] {
  return path
    .map((pp) => ({
      time: (anchor + pp.timeOffsetSeconds) as Time,
      value: pp.price,
    }))
    .filter(
      (p, i, arr) => i === 0 || (p.time as number) > (arr[i - 1].time as number)
    )
}

const StructureOverlay = ({
  chart,
  series,
  lastCandleTs,
  read,
  showPath,
}: Props) => {
  const lineRef = useRef<ISeriesApi<'Line'> | null>(null)
  const priceLinesRef = useRef<IPriceLine[]>([])

  useEffect(() => {
    if (!chart) return
    if (lineRef.current) {
      try {
        chart.removeSeries(lineRef.current)
      } catch {
        /* ignore */
      }
      lineRef.current = null
    }
    const ready = read?.trap?.phase === 'TRADE_READY'
    if (!showPath || !ready || !read || read.chartPath.length < 2 || !lastCandleTs) {
      return
    }

    const color =
      read.preferredSide === 'SHORT' ? '#fb7185' : '#34d399'
    const line = chart.addLineSeries({
      color,
      lineWidth: 2,
      lineStyle: 0,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
      title: '',
    })
    line.setData(toLineData(read.chartPath, lastCandleTs))
    lineRef.current = line

    try {
      const ts = chart.timeScale()
      const opts = ts.options()
      const current = opts.rightOffset ?? 8
      const maxOff = Math.max(
        0,
        ...read.chartPath.map((p) => p.timeOffsetSeconds)
      )
      const extra = Math.min(28, Math.ceil(maxOff / 3600) + 8)
      if (extra > current + 2) ts.applyOptions({ rightOffset: extra })
    } catch {
      /* ignore */
    }

    return () => {
      if (lineRef.current) {
        try {
          chart.removeSeries(lineRef.current)
        } catch {
          /* ignore */
        }
        lineRef.current = null
      }
    }
  }, [chart, read, lastCandleTs, showPath])

  useEffect(() => {
    const s = series
    for (const pl of priceLinesRef.current) {
      try {
        s?.removePriceLine(pl)
      } catch {
        /* ignore */
      }
    }
    priceLinesRef.current = []
    if (!s || !read?.trap) return

    const trap = read.trap
    const add = (
      price: number | null | undefined,
      title: string,
      color: string
    ) => {
      if (price == null || !(price > 0)) return
      try {
        priceLinesRef.current.push(
          s.createPriceLine({
            price,
            color,
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title,
          })
        )
      } catch {
        /* ignore */
      }
    }

    add(trap.crowdShorts, 'шорты', '#fb7185')
    add(trap.crowdLongs, 'лонги', '#34d399')
    add(trap.reclaimLevel, 'закреп', '#e2e8f0')
    if (
      trap.weaknessLevel != null &&
      (trap.reclaimLevel == null ||
        Math.abs(trap.weaknessLevel - trap.reclaimLevel) / trap.reclaimLevel > 0.0008)
    ) {
      add(trap.weaknessLevel, 'слабость', '#f59e0b')
    }

    return () => {
      for (const pl of priceLinesRef.current) {
        try {
          s.removePriceLine(pl)
        } catch {
          /* ignore */
        }
      }
      priceLinesRef.current = []
    }
  }, [series, read])

  return null
}

export default StructureOverlay
