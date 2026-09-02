/**
 * Structure overlay: a flight path only when the trade is real.
 * Crowd/reclaim levels stay on the HUD — price lines here stretch the scale
 * and make candles look like they failed to load.
 */

import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi, Time, LineData } from 'lightweight-charts'
import type { StructureRead } from '../../engine/smc/structureRead'
import type { PathPoint } from '../../engine/prediction/types'

interface Props {
  chart: IChartApi | null
  series?: ISeriesApi<'Candlestick'> | null
  read: StructureRead | null
  lastCandleTs: number
  showPath: boolean
}

function toLineData(path: PathPoint[], anchor: number): LineData[] {
  if (!(anchor > 0)) return []
  return path
    .filter((pp) => Number.isFinite(pp.price) && pp.price > 0)
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
    const ready = read?.trap?.phase === 'TRADE_READY'
    const data =
      showPath && ready && read && lastCandleTs > 0
        ? toLineData(read.chartPath, lastCandleTs)
        : []
    if (data.length < 2 || !read) return

    try {
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
        // Path must not pull autoscale — far magnets flatten candles.
        autoscaleInfoProvider: () => null,
      })
      line.setData(data)
      lineRef.current = line
    } catch {
      return
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
