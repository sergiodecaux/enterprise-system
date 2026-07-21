import type { NewsEvent, NewsImportance } from './types'

function toTs(dateStr: string, hourUTC: number, minuteUTC = 30): number {
  const d = new Date(
    `${dateStr}T${String(hourUTC).padStart(2, '0')}:${String(minuteUTC).padStart(2, '0')}:00Z`
  )
  return Math.floor(d.getTime() / 1000)
}

function firstFriday(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month - 1, 1))
  const dow = d.getUTCDay()
  const diff = dow <= 5 ? 5 - dow : 12 - dow
  d.setUTCDate(1 + diff)
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(month).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}

const FOMC_DATES = [
  '2025-01-29',
  '2025-03-19',
  '2025-05-07',
  '2025-06-18',
  '2025-07-30',
  '2025-09-17',
  '2025-10-29',
  '2025-12-10',
  '2026-01-28',
  '2026-03-18',
  '2026-04-29',
  '2026-06-17',
  '2026-07-29',
  '2026-09-16',
  '2026-10-28',
  '2026-12-09',
]

const US_CPI_DATES = [
  '2025-01-15',
  '2025-02-12',
  '2025-03-12',
  '2025-04-10',
  '2025-05-13',
  '2025-06-11',
  '2025-07-15',
  '2025-08-12',
  '2025-09-10',
  '2025-10-15',
  '2025-11-13',
  '2025-12-10',
  '2026-01-14',
  '2026-02-11',
  '2026-03-11',
  '2026-04-08',
  '2026-05-13',
  '2026-06-10',
  '2026-07-15',
  '2026-08-12',
  '2026-09-09',
  '2026-10-14',
  '2026-11-12',
  '2026-12-09',
]

function buildEventList(year: number, month: number): NewsEvent[] {
  const events: NewsEvent[] = []
  const prefix = `${year}-${String(month).padStart(2, '0')}`

  const nfpDate = firstFriday(year, month)
  events.push({
    id: `nfp_${nfpDate}`,
    name: 'NFP',
    fullName: 'Non-Farm Payrolls (США)',
    timestamp: toTs(nfpDate, 12, 30),
    importance: 'CRITICAL',
    currency: 'USD',
    forecast: '—',
  })

  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate()
  for (let d = 1; d <= dim; d++) {
    const dt = new Date(Date.UTC(year, month - 1, d))
    if (dt.getUTCDay() !== 3) continue
    const dateStr = `${prefix}-${String(d).padStart(2, '0')}`
    events.push({
      id: `eia_${dateStr}`,
      name: 'EIA',
      fullName: 'EIA Crude Oil Inventories',
      timestamp: toTs(dateStr, 14, 30),
      importance: 'MEDIUM',
      currency: 'USD',
    })
  }

  for (const dateStr of FOMC_DATES) {
    if (!dateStr.startsWith(prefix)) continue
    events.push({
      id: `fomc_${dateStr}`,
      name: 'FOMC',
      fullName: 'FOMC Rate Decision (ФРС)',
      timestamp: toTs(dateStr, 18, 0),
      importance: 'CRITICAL',
      currency: 'USD',
    })
  }

  for (const dateStr of US_CPI_DATES) {
    if (!dateStr.startsWith(prefix)) continue
    events.push({
      id: `cpi_${dateStr}`,
      name: 'CPI',
      fullName: 'US Consumer Price Index',
      timestamp: toTs(dateStr, 12, 30),
      importance: 'HIGH',
      currency: 'USD',
    })
  }

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  for (let d = lastDay; d >= lastDay - 6; d--) {
    const dt = new Date(Date.UTC(year, month - 1, d))
    if (dt.getUTCDay() !== 5) continue
    const dateStr = `${prefix}-${String(d).padStart(2, '0')}`
    events.push({
      id: `pce_${dateStr}`,
      name: 'PCE',
      fullName: 'Core PCE Price Index',
      timestamp: toTs(dateStr, 12, 30),
      importance: 'HIGH',
      currency: 'USD',
    })
    break
  }

  return events.sort((a, b) => a.timestamp - b.timestamp)
}

const eventCache = new Map<string, NewsEvent[]>()

export function getEventsInRange(fromTs: number, toTs: number): NewsEvent[] {
  const result: NewsEvent[] = []
  const fromDate = new Date(fromTs * 1000)
  const toDate = new Date(toTs * 1000)

  let year = fromDate.getUTCFullYear()
  let month = fromDate.getUTCMonth() + 1
  const endYear = toDate.getUTCFullYear()
  const endMonth = toDate.getUTCMonth() + 1

  while (year < endYear || (year === endYear && month <= endMonth)) {
    const key = `${year}-${month}`
    if (!eventCache.has(key)) {
      eventCache.set(key, buildEventList(year, month))
    }
    result.push(...(eventCache.get(key) ?? []))

    month++
    if (month > 12) {
      month = 1
      year++
    }
  }

  return result.filter((e) => e.timestamp >= fromTs && e.timestamp <= toTs)
}

export function getNewsColor(importance: NewsImportance): {
  line: string
  dot: string
  bg: string
} {
  switch (importance) {
    case 'CRITICAL':
      return {
        line: 'rgba(239, 68, 68, 0.6)',
        dot: '#ef4444',
        bg: 'rgba(239, 68, 68, 0.85)',
      }
    case 'HIGH':
      return {
        line: 'rgba(249, 115, 22, 0.5)',
        dot: '#f97316',
        bg: 'rgba(249, 115, 22, 0.85)',
      }
    case 'MEDIUM':
      return {
        line: 'rgba(234, 179, 8, 0.4)',
        dot: '#eab308',
        bg: 'rgba(234, 179, 8, 0.85)',
      }
    default:
      return {
        line: 'rgba(148, 163, 184, 0.3)',
        dot: '#94a3b8',
        bg: 'rgba(148, 163, 184, 0.75)',
      }
  }
}
