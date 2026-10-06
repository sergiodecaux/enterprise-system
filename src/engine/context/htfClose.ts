import type { OhlcvCandle } from '../../api/mexc'
import type { CandleBias, CloseLocation, HTFCloseContext, OhlcClose } from './types'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

function aggregateWeekly(daily: OhlcvCandle[]): OhlcvCandle[] {
  if (!daily.length) return []
  const weeks: OhlcvCandle[] = []
  let cur: OhlcvCandle | null = null
  let weekKey = Number.NaN
  for (const c of daily) {
    const day = new Date(c[0]).getUTCDay()
    const mondayMs = c[0] - ((day + 6) % 7) * DAY_MS
    const key = Math.floor(mondayMs / DAY_MS)
    if (key !== weekKey) {
      if (cur) weeks.push(cur)
      weekKey = key
      cur = [mondayMs, c[1], c[2], c[3], c[4], c[5]]
    } else if (cur) {
      cur = [cur[0], cur[1], Math.max(cur[2], c[2]), Math.min(cur[3], c[3]), c[4], cur[5] + c[5]]
    }
  }
  if (cur) weeks.push(cur)
  return weeks
}

function lastClosed(
  candles: OhlcvCandle[],
  periodMs: number,
  now: number
): OhlcvCandle | null {
  if (!candles.length) return null
  const last = candles[candles.length - 1]
  const forming = last[0] <= now && now - last[0] < periodMs
  if (forming && candles.length >= 2) return candles[candles.length - 2]
  return last
}

function biasOf(c: OhlcvCandle): CandleBias {
  if (c[4] > c[1]) return 'BULL'
  if (c[4] < c[1]) return 'BEAR'
  return 'NEUTRAL'
}

function locationOf(c: OhlcvCandle): CloseLocation {
  const range = c[2] - c[3]
  if (!(range > 0)) return 'MID'
  const pos = (c[4] - c[3]) / range
  if (pos >= 0.75) return 'HIGH'
  if (pos <= 0.25) return 'LOW'
  return 'MID'
}

function pack(c: OhlcvCandle): OhlcClose {
  return {
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    bias: biasOf(c),
  }
}

/** Last completed daily and weekly candle. Forming bars are skipped. */
export function buildHtfCloseContext(
  candles1d: OhlcvCandle[] | undefined,
  now = Date.now()
): HTFCloseContext | null {
  if (!candles1d || candles1d.length < 3) return null
  const daily = lastClosed(candles1d, DAY_MS, now)
  const weekly = lastClosed(aggregateWeekly(candles1d), WEEK_MS, now)
  if (!daily || !weekly) return null
  const mid = (daily[2] + daily[3]) / 2
  return {
    dailyClose: pack(daily),
    weeklyClose: pack(weekly),
    closedAboveMidpoint: daily[4] >= mid,
    closedNearHighOrLow: locationOf(daily),
  }
}
