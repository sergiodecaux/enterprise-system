import type { SessionSegment, WeekendSegment, SessionSettings } from './types'
import { SESSION_DEFINITIONS, getSessionSegmentsForDay } from './sessionMap'

function getDayStart(ts: number): number {
  const d = new Date(ts * 1000)
  d.setUTCHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

function isWeekend(ts: number): boolean {
  const dow = new Date(ts * 1000).getUTCDay()
  return dow === 0 || dow === 6
}

function scaleAlpha(rgba: string, factor: number): string {
  return rgba.replace(
    /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/,
    (_, r, g, b, a) =>
      `rgba(${r},${g},${b},${(parseFloat(a) * factor).toFixed(3)})`
  )
}

export function calculateSessionSegments(
  fromTs: number,
  toTs: number,
  settings: SessionSettings
): SessionSegment[] {
  if (!settings.enabled) return []

  const segments: SessionSegment[] = []
  const opacityFactor = settings.opacity / 100

  let dayStart = getDayStart(fromTs)
  const dayEnd = getDayStart(toTs) + 86400

  while (dayStart < dayEnd) {
    if (!isWeekend(dayStart)) {
      const daySessions = getSessionSegmentsForDay(dayStart)

      for (const { name, startTs, endTs } of daySessions) {
        if (name === 'ASIA' && !settings.showAsia) continue
        if (name === 'LONDON' && !settings.showLondon) continue
        if (name === 'NEW_YORK' && !settings.showNewYork) continue
        if (name === 'OVERLAP' && !settings.showOverlap) continue
        if (name === 'CLOSED') continue

        const def = SESSION_DEFINITIONS[name]
        const clippedStart = Math.max(startTs, fromTs - 3600)
        const clippedEnd = Math.min(endTs, toTs + 3600)
        if (clippedStart >= clippedEnd) continue

        segments.push({
          session: name,
          label: def.label,
          startTs: clippedStart,
          endTs: clippedEnd,
          color: scaleAlpha(def.color, opacityFactor),
          lineColor: def.lineColor,
          textColor: def.textColor,
          isOverlap: name === 'OVERLAP',
        })
      }
    }

    dayStart += 86400
  }

  return segments
}

export function calculateWeekendSegments(
  fromTs: number,
  toTs: number,
  enabled: boolean
): WeekendSegment[] {
  if (!enabled) return []

  const segments: WeekendSegment[] = []
  let dayStart = getDayStart(fromTs)

  while (dayStart < toTs + 86400) {
    const dow = new Date(dayStart * 1000).getUTCDay()

    if (dow === 5) {
      const wkndStart = dayStart + 22 * 3600
      const wkndEnd = dayStart + 86400 * 2 + 22 * 3600
      const clippedStart = Math.max(wkndStart, fromTs)
      const clippedEnd = Math.min(wkndEnd, toTs + 86400)

      if (clippedStart < clippedEnd) {
        segments.push({
          startTs: clippedStart,
          endTs: clippedEnd,
          label: 'Сб–Вс',
        })
      }
    }

    dayStart += 86400
  }

  return segments
}
