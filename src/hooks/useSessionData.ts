import { useState, useEffect, useCallback, useRef } from 'react'
import type { IChartApi } from 'lightweight-charts'
import type {
  SessionSegment,
  WeekendSegment,
  NewsEvent,
  SessionSettings,
} from '../engine/sessions/types'
import {
  calculateSessionSegments,
  calculateWeekendSegments,
} from '../engine/sessions/sessionCalculator'
import { getEventsInRange } from '../engine/sessions/newsCalendar'

interface SessionData {
  sessions: SessionSegment[]
  weekends: WeekendSegment[]
  news: NewsEvent[]
}

const SESSION_TIMEFRAMES = new Set(['1m', '5m', '15m', '1h'])

export function useSessionData(
  chart: IChartApi | null,
  timeframe: string,
  settings: SessionSettings
): SessionData {
  const [data, setData] = useState<SessionData>({
    sessions: [],
    weekends: [],
    news: [],
  })

  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const recalculate = useCallback(() => {
    if (!chart) return

    if (!SESSION_TIMEFRAMES.has(timeframe)) {
      setData({ sessions: [], weekends: [], news: [] })
      return
    }

    const currentSettings = settingsRef.current
    if (!currentSettings.enabled) {
      setData({ sessions: [], weekends: [], news: [] })
      return
    }

    try {
      const visible = chart.timeScale().getVisibleRange()
      if (!visible) return

      const fromTs = visible.from as number
      const toTs = visible.to as number
      const paddedFrom = fromTs - 86400
      const paddedTo = toTs + 86400

      setData({
        sessions: calculateSessionSegments(paddedFrom, paddedTo, currentSettings),
        weekends: calculateWeekendSegments(
          paddedFrom,
          paddedTo,
          currentSettings.showWeekends
        ),
        news: currentSettings.showNews
          ? getEventsInRange(paddedFrom, paddedTo)
          : [],
      })
    } catch {
      // timeScale may not be ready
    }
  }, [chart, timeframe])

  useEffect(() => {
    recalculate()
  }, [recalculate, settings])

  useEffect(() => {
    if (!chart) return
    chart.timeScale().subscribeVisibleLogicalRangeChange(recalculate)
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(recalculate)
    }
  }, [chart, recalculate])

  return data
}
