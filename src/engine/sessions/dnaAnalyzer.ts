import type { OhlcvCandle } from '../../api/mexc'
import type {
  SessionDNA,
  SessionPersonality,
  SessionStat,
} from '../types'

/** Часы UTC для каждой сессии (включительно start, исключительно end) */
const SESSION_HOURS = {
  ASIA: { start: 0, end: 7 },
  LONDON: { start: 7, end: 13 },
  OVERLAP: { start: 13, end: 16 },
  NEW_YORK: { start: 16, end: 22 },
} as const

type SessionKey = keyof typeof SESSION_HOURS

const SESSION_LABELS: Record<SessionKey, string> = {
  ASIA: 'Азия',
  LONDON: 'Лондон',
  OVERLAP: 'Лондон + NY',
  NEW_YORK: 'Нью-Йорк',
}

/** Минимум дней для надёжной статистики */
const MIN_DAYS = 10

/**
 * Определяет сессию свечи по UTC-часу её открытия.
 * Возвращает null если свеча не попадает ни в одну сессию (CLOSED).
 */
function getCandleSession(timestampMs: number): SessionKey | null {
  const utcHour = new Date(timestampMs).getUTCHours()
  for (const [key, range] of Object.entries(
    SESSION_HOURS
  ) as [SessionKey, { start: number; end: number }][]) {
    if (utcHour >= range.start && utcHour < range.end) return key
  }
  return null
}

/**
 * Группирует 1H свечи по дням и сессиям.
 * Возвращает Map: dateStr → Record<SessionKey, OhlcvCandle[]>
 */
function groupCandlesByDayAndSession(
  candles: OhlcvCandle[]
): Map<string, Partial<Record<SessionKey, OhlcvCandle[]>>> {
  const map = new Map<string, Partial<Record<SessionKey, OhlcvCandle[]>>>()

  for (const candle of candles) {
    const ts = candle[0]
    const date = new Date(ts)
    // UTC-дата как ключ
    const dateStr = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`
    const session = getCandleSession(ts)
    if (!session) continue

    if (!map.has(dateStr)) map.set(dateStr, {})
    const dayMap = map.get(dateStr)!
    if (!dayMap[session]) dayMap[session] = []
    dayMap[session]!.push(candle)
  }

  return map
}

/**
 * Считает статистику одной сессии по всем дням.
 */
function computeSessionStat(
  session: SessionKey,
  dayMap: Map<string, Partial<Record<SessionKey, OhlcvCandle[]>>>
): SessionStat {
  const days = Array.from(dayMap.values())
  void days

  let totalDays = 0
  let sumRangePct = 0
  let breaksPrevHigh = 0
  let breaksPrevLow = 0
  let fakeouts = 0
  let bullishDays = 0
  let sumVolume = 0

  // Предыдущая сессия для контекста
  const prevSessionMap: Record<SessionKey, SessionKey> = {
    ASIA: 'NEW_YORK', // предыдущий день NY
    LONDON: 'ASIA',
    OVERLAP: 'LONDON',
    NEW_YORK: 'OVERLAP',
  }
  const prevSession = prevSessionMap[session]

  const dayKeys = Array.from(dayMap.keys()).sort()

  for (let d = 1; d < dayKeys.length; d++) {
    const key = dayKeys[d]
    const prevKey = dayKeys[d - 1]
    const dayData = dayMap.get(key)
    const prevDayData = dayMap.get(prevKey)

    const sessionCandles = dayData?.[session]
    if (!sessionCandles || sessionCandles.length < 2) continue

    totalDays++

    // Диапазон сессии
    const sessionHigh = Math.max(...sessionCandles.map((c) => c[2]))
    const sessionLow = Math.min(...sessionCandles.map((c) => c[3]))
    const sessionOpen = sessionCandles[0][1]
    const sessionClose = sessionCandles[sessionCandles.length - 1][4]
    const midPrice = (sessionHigh + sessionLow) / 2

    if (midPrice > 0) {
      sumRangePct += ((sessionHigh - sessionLow) / midPrice) * 100
    }

    // Объём сессии
    const sessionVolume = sessionCandles.reduce((s, c) => s + c[5], 0)
    sumVolume += sessionVolume

    // Бычий/медвежий день
    if (sessionClose > sessionOpen) bullishDays++

    // Обновление хай/лоу предыдущей сессии
    const prevCandles =
      session === 'ASIA'
        ? prevDayData?.[prevSession] // берём предыдущий день
        : dayData?.[prevSession] // тот же день

    if (prevCandles && prevCandles.length >= 1) {
      const prevHigh = Math.max(...prevCandles.map((c) => c[2]))
      const prevLow = Math.min(...prevCandles.map((c) => c[3]))

      if (sessionHigh > prevHigh) breaksPrevHigh++
      if (sessionLow < prevLow) breaksPrevLow++

      // Fakeout: сессия прошла за prev high/low, но закрылась обратно
      const brokeHighAndReverted = sessionHigh > prevHigh && sessionClose < prevHigh
      const brokeLowAndReverted = sessionLow < prevLow && sessionClose > prevLow

      if (brokeHighAndReverted || brokeLowAndReverted) fakeouts++
    }
  }

  const safe = (n: number) => (totalDays > 0 ? (n / totalDays) * 100 : 0)

  return {
    session,
    label: SESSION_LABELS[session],
    totalDays,
    avgRangePct: totalDays > 0 ? sumRangePct / totalDays : 0,
    breaksPrevHighPct: safe(breaksPrevHigh),
    breaksPrevLowPct: safe(breaksPrevLow),
    fakeoutPct: safe(fakeouts),
    bullishPct: safe(bullishDays),
    avgVolume: totalDays > 0 ? sumVolume / totalDays : 0,
    isHighestVolume: false, // проставим после сравнения
  }
}

/**
 * Определяет "личность" монеты на основе статистики сессий.
 */
function resolvePersonality(
  stats: SessionStat[]
): { personality: SessionPersonality; label: string; icon: string; insight: string } {
  const get = (s: SessionKey) => stats.find((x) => x.session === s)
  const london = get('LONDON')
  const ny = get('NEW_YORK')
  const asia = get('ASIA')
  const overlap = get('OVERLAP')

  // FAKEOUT_KING: Лондон делает ложный вынос в 60%+ случаев
  if (london && london.fakeoutPct >= 60) {
    return {
      personality: 'FAKEOUT_KING',
      label: 'Король ложных пробоев',
      icon: '🎭',
      insight: `Лондон делает ложный вынос в ${london.fakeoutPct.toFixed(0)}% дней — входить после закрытия лондонской свечи`,
    }
  }

  // LONDON_BREAKER: Лондон обновляет хай или лоу Азии в 75%+ случаев
  if (london && (london.breaksPrevHighPct + london.breaksPrevLowPct) / 2 >= 75) {
    return {
      personality: 'LONDON_BREAKER',
      label: 'Лондонский пробойщик',
      icon: '💥',
      insight: `Лондон сносит уровни Азии в ${(
        (london.breaksPrevHighPct + london.breaksPrevLowPct) / 2
      ).toFixed(0)}% случаев`,
    }
  }

  // NY_REVERSAL: NY разворачивает движение Лондона в 55%+ случаев
  if (ny && london) {
    // NY fakeout относительно London = NY reversal паттерн
    if (ny.fakeoutPct >= 55) {
      return {
        personality: 'NY_REVERSAL',
        label: 'Разворот NY',
        icon: '🔄',
        insight: `Нью-Йорк разворачивает движение Лондона в ${ny.fakeoutPct.toFixed(0)}% случаев — не держать позицию через открытие NY`,
      }
    }
  }

  // TREND_FOLLOWER: NY подтверждает Лондон (оба bullishPct > 65% или оба < 35%)
  if (london && ny) {
    const londonBull = london.bullishPct
    const nyBull = ny.bullishPct
    const aligned =
      (londonBull > 65 && nyBull > 65) || (londonBull < 35 && nyBull < 35)
    if (aligned) {
      return {
        personality: 'TREND_FOLLOWER',
        label: 'Следование тренду',
        icon: '📈',
        insight:
          'Лондон и NY движутся в одном направлении в большинстве дней — сильные трендовые дни',
      }
    }
  }

  // OVERLAP_BEAST: Overlap самый волатильный (avgRangePct максимальный)
  if (overlap) {
    const maxRange = Math.max(...stats.map((s) => s.avgRangePct))
    if (overlap.avgRangePct >= maxRange * 0.95) {
      return {
        personality: 'OVERLAP_BEAST',
        label: 'Зверь пересечения',
        icon: '⚡',
        insight: `Пересечение Лондон+NY даёт самый большой диапазон (${overlap.avgRangePct.toFixed(2)}%) — торговать именно это время`,
      }
    }
  }

  // ASIA_RANGER: Азия торгует в узком диапазоне (avgRange < 0.8%)
  if (asia && asia.avgRangePct < 0.8 && asia.totalDays >= MIN_DAYS) {
    return {
      personality: 'ASIA_RANGER',
      label: 'Азиатский рейнджер',
      icon: '🌙',
      insight: `Азия торгует в диапазоне ${asia.avgRangePct.toFixed(2)}% — ожидать движение на Лондоне`,
    }
  }

  // STEADY_MOVER: нет явного характера
  if (stats.every((s) => s.totalDays >= MIN_DAYS)) {
    return {
      personality: 'STEADY_MOVER',
      label: 'Стабильный ход',
      icon: '⚖️',
      insight: 'Равномерная активность по всем сессиям — нет явного сессионного преимущества',
    }
  }

  return {
    personality: 'UNKNOWN',
    label: 'Анализируется',
    icon: '🔍',
    insight: 'Недостаточно данных для определения характера монеты',
  }
}

/**
 * analyzeSessionDNA — главная функция.
 *
 * Принимает 1H свечи (минимум 10 * 24 = 240 свечей = ~10 дней).
 * Рекомендуется: 720 свечей (30 дней).
 *
 * @param candles   - 1H OHLCV свечи
 * @param symbol    - internalSymbol монеты
 */
export function analyzeSessionDNA(candles: OhlcvCandle[], symbol: string): SessionDNA {
  const EMPTY: SessionDNA = {
    symbol,
    sessions: [],
    personality: 'UNKNOWN',
    personalityLabel: 'Анализируется',
    personalityIcon: '🔍',
    dominantSession: null,
    keyInsight: 'Недостаточно данных',
    candlesAnalyzed: candles.length,
    computedAt: Date.now(),
  }

  if (candles.length < MIN_DAYS * 20) return EMPTY

  // Группируем свечи
  const dayMap = groupCandlesByDayAndSession(candles)
  if (dayMap.size < MIN_DAYS) return EMPTY

  // Считаем статистику по каждой сессии
  const sessionKeys: SessionKey[] = ['ASIA', 'LONDON', 'OVERLAP', 'NEW_YORK']
  const stats: SessionStat[] = sessionKeys
    .map((key) => computeSessionStat(key, dayMap))
    .filter((s) => s.totalDays >= 3) // минимум 3 дня чтобы включить в анализ

  if (stats.length === 0) return EMPTY

  // Помечаем сессию с наибольшим объёмом
  const maxVol = Math.max(...stats.map((s) => s.avgVolume))
  stats.forEach((s) => {
    s.isHighestVolume = s.avgVolume >= maxVol * 0.95
  })

  // Доминирующая сессия
  const dominant = stats.reduce((best, cur) => (cur.avgVolume > best.avgVolume ? cur : best))
  const dominantSession =
    dominant.totalDays >= MIN_DAYS
      ? (dominant.session as SessionDNA['dominantSession'])
      : null

  // Личность
  const { personality, label, icon, insight } = resolvePersonality(stats)

  return {
    symbol,
    sessions: stats,
    personality,
    personalityLabel: label,
    personalityIcon: icon,
    dominantSession,
    keyInsight: insight,
    candlesAnalyzed: candles.length,
    computedAt: Date.now(),
  }
}

