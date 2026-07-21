import { useEffect, useRef } from 'react'
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type HistogramData,
} from 'lightweight-charts'
import type { IndicatorPoint, MACDPoint } from '../../engine/indicators/types'

type OscillatorMode = 'rsi' | 'macd' | 'stochastic' | 'atr'

interface Props {
  mode: OscillatorMode
  rsiData?: IndicatorPoint[]
  macdData?: MACDPoint[]
  stochasticData?: IndicatorPoint[]
  atrData?: IndicatorPoint[]
  height?: number
}

const MODE_LABELS: Record<OscillatorMode, string> = {
  rsi: 'RSI (14)',
  macd: 'MACD (12,26,9)',
  stochastic: 'Stoch RSI',
  atr: 'ATR (14)',
}

const LEVEL_CONFIG: Record<OscillatorMode, { ob: number; os: number } | null> = {
  rsi: { ob: 70, os: 30 },
  stochastic: { ob: 80, os: 20 },
  macd: null,
  atr: null,
}

const OscillatorPanel = ({
  mode,
  rsiData = [],
  macdData = [],
  stochasticData = [],
  atrData = [],
  height = 80,
}: Props) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const lineSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const histSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const sigSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)

  useEffect(() => {
    if (!containerRef.current || chartRef.current) return

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#e0e0e050',
        fontSize: 9,
      },
      grid: {
        vertLines: { color: '#1a1a1a' },
        horzLines: { color: '#1a1a1a50' },
      },
      crosshair: { mode: 0 },
      timeScale: {
        visible: false,
        borderVisible: false,
      },
      rightPriceScale: {
        borderColor: '#2a2a2a',
        scaleMargins: { top: 0.1, bottom: 0.1 },
        minimumWidth: 36,
      },
      width: containerRef.current.clientWidth,
      height,
      handleScroll: false,
      handleScale: false,
    })

    if (mode === 'macd') {
      histSeriesRef.current = chart.addHistogramSeries({
        color: 'rgba(100, 200, 255, 0.4)',
        priceScaleId: 'right',
      })
      lineSeriesRef.current = chart.addLineSeries({
        color: '#22d3ee',
        lineWidth: 1,
        priceScaleId: 'right',
      })
      sigSeriesRef.current = chart.addLineSeries({
        color: '#f97316',
        lineWidth: 1,
        priceScaleId: 'right',
      })
    } else {
      const color =
        mode === 'rsi' ? '#a855f7' : mode === 'stochastic' ? '#84cc16' : '#94a3b8'
      const line = chart.addLineSeries({
        color,
        lineWidth: 1,
        priceScaleId: 'right',
      })

      const levels = LEVEL_CONFIG[mode]
      if (levels) {
        line.createPriceLine({
          price: levels.ob,
          color: 'rgba(239, 68, 68, 0.5)',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `${levels.ob}`,
        })
        line.createPriceLine({
          price: levels.os,
          color: 'rgba(34, 197, 94, 0.5)',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `${levels.os}`,
        })
        line.createPriceLine({
          price: 50,
          color: 'rgba(100, 200, 255, 0.2)',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: false,
          title: '',
        })
      }

      lineSeriesRef.current = line
    }

    chartRef.current = chart

    const ro = new ResizeObserver((entries) => {
      chart.applyOptions({ width: entries[0].contentRect.width })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      lineSeriesRef.current = null
      histSeriesRef.current = null
      sigSeriesRef.current = null
    }
  }, [mode, height])

  useEffect(() => {
    if (!lineSeriesRef.current || mode === 'macd') return

    const source =
      mode === 'rsi' ? rsiData : mode === 'stochastic' ? stochasticData : atrData
    if (!source.length) return

    const lineData: LineData[] = source.map((p) => ({
      time: p.time,
      value: p.value,
    }))
    lineSeriesRef.current.setData(lineData)
    chartRef.current?.timeScale().fitContent()
  }, [rsiData, stochasticData, atrData, mode])

  useEffect(() => {
    if (mode !== 'macd') return
    if (
      !histSeriesRef.current ||
      !lineSeriesRef.current ||
      !sigSeriesRef.current ||
      !macdData.length
    ) {
      return
    }

    const histD: HistogramData[] = macdData.map((p) => ({
      time: p.time,
      value: p.histogram,
      color:
        p.histogram >= 0 ? 'rgba(34, 197, 94, 0.5)' : 'rgba(239, 68, 68, 0.5)',
    }))
    const macdD: LineData[] = macdData.map((p) => ({ time: p.time, value: p.macd }))
    const sigD: LineData[] = macdData.map((p) => ({ time: p.time, value: p.signal }))

    histSeriesRef.current.setData(histD)
    lineSeriesRef.current.setData(macdD)
    sigSeriesRef.current.setData(sigD)
    chartRef.current?.timeScale().fitContent()
  }, [macdData, mode])

  const data =
    mode === 'rsi'
      ? rsiData
      : mode === 'macd'
        ? macdData
        : mode === 'stochastic'
          ? stochasticData
          : atrData

  if (!data.length) return null

  return (
    <div className="space-y-0.5">
      <div className="px-1 font-mono text-[9px] text-holo/40">{MODE_LABELS[mode]}</div>
      <div ref={containerRef} style={{ height }} className="w-full" />
    </div>
  )
}

export default OscillatorPanel
