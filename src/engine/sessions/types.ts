export type SessionName =
  | 'ASIA'
  | 'LONDON'
  | 'NEW_YORK'
  | 'OVERLAP'
  | 'CLOSED'

export interface SessionDefinition {
  name: SessionName
  label: string
  startHour: number
  endHour: number
  color: string
  lineColor: string
  textColor: string
}

export interface SessionSegment {
  session: SessionName
  label: string
  startTs: number
  endTs: number
  color: string
  lineColor: string
  textColor: string
  isOverlap: boolean
}

export type NewsImportance = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface NewsEvent {
  id: string
  name: string
  fullName: string
  timestamp: number
  importance: NewsImportance
  currency: string
  actual?: string
  forecast?: string
  previous?: string
}

export interface WeekendSegment {
  startTs: number
  endTs: number
  label: string
}

export interface SessionSettings {
  enabled: boolean
  showAsia: boolean
  showLondon: boolean
  showNewYork: boolean
  showOverlap: boolean
  showWeekends: boolean
  showNews: boolean
  showSessionLines: boolean
  opacity: number
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  enabled: true,
  showAsia: true,
  showLondon: true,
  showNewYork: true,
  showOverlap: true,
  showWeekends: true,
  showNews: true,
  showSessionLines: true,
  opacity: 100,
}
