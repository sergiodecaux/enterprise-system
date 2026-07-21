import type { SessionDefinition, SessionName } from './types'

export const SESSION_DEFINITIONS: Record<SessionName, SessionDefinition> = {
  ASIA: {
    name: 'ASIA',
    label: 'Азия',
    startHour: 0,
    endHour: 9,
    color: 'rgba(99, 102, 241, 0.16)',
    lineColor: 'rgba(99, 102, 241, 0.55)',
    textColor: 'rgba(165, 180, 252, 1)',
  },
  LONDON: {
    name: 'LONDON',
    label: 'Лондон',
    startHour: 7,
    endHour: 16,
    color: 'rgba(245, 158, 11, 0.16)',
    lineColor: 'rgba(245, 158, 11, 0.55)',
    textColor: 'rgba(252, 211, 77, 1)',
  },
  NEW_YORK: {
    name: 'NEW_YORK',
    label: 'Нью-Йорк',
    startHour: 13,
    endHour: 22,
    color: 'rgba(34, 197, 94, 0.16)',
    lineColor: 'rgba(34, 197, 94, 0.55)',
    textColor: 'rgba(134, 239, 172, 1)',
  },
  OVERLAP: {
    name: 'OVERLAP',
    label: 'Лондон + NY',
    startHour: 13,
    endHour: 16,
    color: 'rgba(239, 68, 68, 0.20)',
    lineColor: 'rgba(239, 68, 68, 0.70)',
    textColor: 'rgba(254, 202, 202, 1)',
  },
  CLOSED: {
    name: 'CLOSED',
    label: 'Закрыто',
    startHour: 22,
    endHour: 24,
    color: 'rgba(100, 100, 100, 0.10)',
    lineColor: 'rgba(100, 100, 100, 0.30)',
    textColor: 'rgba(148, 163, 184, 0.9)',
  },
}

export function getSessionAtHour(utcHour: number): SessionName {
  if (utcHour >= 13 && utcHour < 16) return 'OVERLAP'
  if (utcHour >= 7 && utcHour < 13) return 'LONDON'
  if (utcHour >= 16 && utcHour < 22) return 'NEW_YORK'
  if (utcHour >= 0 && utcHour < 7) return 'ASIA'
  return 'CLOSED'
}

/** Непересекающиеся сегменты дня (UTC midnight) для отрисовки */
export function getSessionSegmentsForDay(
  dayStartTs: number
): Array<{ name: SessionName; startTs: number; endTs: number }> {
  const h = (hours: number) => dayStartTs + hours * 3600

  // Без наложений: иначе цвета смешиваются и сессии неразличимы
  return [
    { name: 'ASIA', startTs: h(0), endTs: h(7) },
    { name: 'LONDON', startTs: h(7), endTs: h(13) },
    { name: 'OVERLAP', startTs: h(13), endTs: h(16) },
    { name: 'NEW_YORK', startTs: h(16), endTs: h(22) },
    { name: 'CLOSED', startTs: h(22), endTs: h(24) },
  ]
}
