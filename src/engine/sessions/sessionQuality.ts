export type SessionName = 'OVERLAP' | 'LONDON' | 'NY' | 'ASIA' | 'DEAD'

export type SessionPhase =
  | 'ASIA'
  | 'LONDON'
  | 'NY'
  | 'LONDON_NY_OVERLAP'
  | 'LOW_LIQUIDITY'

export interface SessionContext {
  session: SessionPhase
  dayType: 'WEEKDAY' | 'WEEKEND'
  isFridayClose: boolean
  isMondayOpen: boolean
  isMonthEnd: boolean
  isQuarterEnd: boolean
}

export interface SessionQuality {
  score: number
  session: SessionName
  avoid: boolean
}

/** Clock + calendar. Session hours match evaluateSessionQuality. */
export function buildSessionContext(nowMs = Date.now()): SessionContext {
  const d = new Date(nowMs)
  const hour = d.getUTCHours()
  const dow = d.getUTCDay()
  let session: SessionPhase
  if (hour >= 12 && hour < 16) session = 'LONDON_NY_OVERLAP'
  else if (hour >= 7 && hour < 12) session = 'LONDON'
  else if (hour >= 16 && hour < 21) session = 'NY'
  else if (hour >= 0 && hour < 7) session = 'ASIA'
  else session = 'LOW_LIQUIDITY'

  const year = d.getUTCFullYear()
  const month = d.getUTCMonth()
  const date = d.getUTCDate()
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const isMonthEnd = date >= daysInMonth - 1
  const isQuarterMonth = month === 2 || month === 5 || month === 8 || month === 11

  return {
    session,
    dayType: dow === 0 || dow === 6 ? 'WEEKEND' : 'WEEKDAY',
    isFridayClose: dow === 5 && hour >= 20,
    isMondayOpen: dow === 1 && hour < 8,
    isMonthEnd,
    isQuarterEnd: isMonthEnd && isQuarterMonth,
  }
}

/** UTC session quality for ScoreCard (London / NY / Overlap preferred). */
export function evaluateSessionQuality(nowMs = Date.now()): SessionQuality {
  const hour = new Date(nowMs).getUTCHours()

  if (hour >= 12 && hour < 16) {
    return { score: 100, session: 'OVERLAP', avoid: false }
  }
  if (hour >= 7 && hour < 12) {
    return { score: 85, session: 'LONDON', avoid: false }
  }
  if (hour >= 16 && hour < 21) {
    return { score: 80, session: 'NY', avoid: false }
  }
  if (hour >= 0 && hour < 7) {
    return { score: 35, session: 'ASIA', avoid: true }
  }
  return { score: 20, session: 'DEAD', avoid: true }
}
