/**
 * Structure flight path + compact SMC HUD on the live chart.
 */

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi, Time, LineData } from 'lightweight-charts'
import type { StructureRead } from '../../engine/smc/structureRead'
import type { PathPoint } from '../../engine/prediction/types'

interface Props {
  chart: IChartApi | null
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
  lastCandleTs,
  read,
  showPath,
}: Props) => {
  const lineRef = useRef<ISeriesApi<'Line'> | null>(null)

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
    if (!showPath || !read || read.chartPath.length < 2 || !lastCandleTs) return

    const color =
      read.bias === 'BULLISH'
        ? '#34d399'
        : read.bias === 'BEARISH'
          ? '#fb7185'
          : '#94a3b8'

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

  return null
}

export default StructureOverlay
