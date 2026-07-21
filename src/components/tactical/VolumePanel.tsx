import { useEffect, useRef } from 'react'
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type HistogramData,
} from 'lightweight-charts'
import type { VolumePoint } from '../../engine/indicators/types'

interface Props {
  volumeData: VolumePoint[]
  height?: number
}

const VolumePanel = ({ volumeData, height = 60 }: Props) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)

  useEffect(() => {
    if (!containerRef.current || chartRef.current) return

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: 'transparent',
      },
      grid: {
        vertLines: { color: '#1a1a1a' },
        horzLines: { visible: false },
      },
      crosshair: { mode: 0 },
      timeScale: {
        visible: false,
        borderVisible: false,
      },
      rightPriceScale: {
        visible: false,
        borderVisible: false,
      },
      leftPriceScale: { visible: false },
      width: containerRef.current.clientWidth,
      height,
      handleScroll: false,
      handleScale: false,
    })

    const histSeries = chart.addHistogramSeries({
      color: 'rgba(100, 200, 255, 0.4)',
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    })

    chartRef.current = chart
    seriesRef.current = histSeries

    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect
      chart.applyOptions({ width })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [height])

  useEffect(() => {
    if (!seriesRef.current || volumeData.length === 0) return

    const histData: HistogramData[] = volumeData.map((v) => ({
      time: v.time,
      value: v.value,
      color: v.color,
    }))

    seriesRef.current.setData(histData)
    chartRef.current?.timeScale().fitContent()
  }, [volumeData])

  return <div ref={containerRef} style={{ height }} className="w-full bg-transparent" />
}

export default VolumePanel
