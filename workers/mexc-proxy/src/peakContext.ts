/**
 * PEAK SHORT context: HTF from 1m (no extra HTTP), candle patterns,
 * and a hard book veto so we do not fade into live bid walls.
 */

import type { Candle } from './peakFuelFail'
import type { CrowdBookMetrics, OrderBookSnapshot } from './orderBookReader'
import type { MemeBookForecast } from './memeBookForecast'

export type UtcSession = 'ASIA' | 'LONDON' | 'NY' | 'LATE'

export function utcSession(at = Date.now()): UtcSession {
  const h = new Date(at).getUTCHours()
  if (h >= 0 && h < 7) return 'ASIA'
  if (h >= 7 && h < 13) return 'LONDON'
  if (h >= 13 && h < 21) return 'NY'
  return 'LATE'
}

export function aggregateTf(candles: Candle[], every: number): Candle[] {
  if (every < 2 || candles.length < every) return []
  const out: Candle[] = []
  for (let i = 0; i + every <= candles.length; i += every) {
    const w = candles.slice(i, i + every)
    const t = w[0]![0]
    const o = w[0]![1]
    let h = w[0]![2]
    let l = w[0]![3]
    const c = w[w.length - 1]![4]
    let v = 0
    for (const x of w) {
      h = Math.max(h, x[2])
      l = Math.min(l, x[3])
      v += x[5]
    }
    out.push([t, o, h, l, c, v])
  }
  return out
}

function rangeOf(c: Candle): number {
  return c[2] - c[3]
}

function bodyOf(c: Candle): number {
  return Math.abs(c[4] - c[1])
}

export function stillMakingHH(candles: Candle[], bars = 6): boolean {
  const w = candles.slice(-Math.max(3, bars))
  if (w.length < 3) return false
  const last3 = w.slice(-3)
  const rising3 =
    last3[2]![2] > last3[1]![2] * 1.0001 &&
    last3[1]![2] > last3[0]![2] * 1.0001
  const closesUp = w[w.length - 1]![4] > w[0]![4] * 1.0004
  const higherLow =
    last3[2]![3] >= last3[0]![3] * 0.999 && last3[1]![3] >= last3[0]![3] * 0.998
  return rising3 && closesUp && higherLow
}

function shootingStar(c: Candle | undefined): boolean {
  if (!c) return false
  const range = rangeOf(c)
  if (!(range > 0)) return false
  const upper = c[2] - Math.max(c[1], c[4])
  const lower = Math.min(c[1], c[4]) - c[3]
  const body = bodyOf(c)
  return (
    upper >= range * 0.5 &&
    upper >= body * 2 &&
    lower <= range * 0.18 &&
    c[4] <= c[1]
  )
}

function hangingMan(c: Candle | undefined): boolean {
  if (!c) return false
  const range = rangeOf(c)
  if (!(range > 0)) return false
  const lower = Math.min(c[1], c[4]) - c[3]
  const upper = c[2] - Math.max(c[1], c[4])
  const body = bodyOf(c)
  return lower >= range * 0.55 && body <= range * 0.28 && upper <= range * 0.15
}

function bearishEngulfing(prev: Candle | undefined, last: Candle | undefined): boolean {
  if (!prev || !last) return false
  const prevUp = prev[4] > prev[1]
  const lastDn = last[4] < last[1]
  if (!prevUp || !lastDn) return false
  return last[1] >= prev[4] * 0.9995 && last[4] <= prev[1] * 1.0005
}

function darkCloud(prev: Candle | undefined, last: Candle | undefined): boolean {
  if (!prev || !last) return false
  if (!(prev[4] > prev[1]) || !(last[4] < last[1])) return false
  const mid = (prev[1] + prev[4]) / 2
  return last[1] > prev[2] * 0.998 && last[4] < mid && last[4] > prev[1]
}

function eveningStar(
  a: Candle | undefined,
  b: Candle | undefined,
  c: Candle | undefined
): boolean {
  if (!a || !b || !c) return false
  if (!(a[4] > a[1])) return false
  const small = bodyOf(b) <= bodyOf(a) * 0.45
  const gap = b[1] >= Math.max(a[1], a[4]) * 0.999
  const bear = c[4] < c[1] && c[4] < (a[1] + a[4]) / 2
  return small && gap && bear
}

function tweezerTop(a: Candle | undefined, b: Candle | undefined): boolean {
  if (!a || !b) return false
  const hi = Math.max(a[2], b[2])
  if (!(hi > 0)) return false
  return Math.abs(a[2] - b[2]) / hi <= 0.0012 && b[4] < b[1]
}

function htfUptrend(c15: Candle[]): boolean {
  if (c15.length < 4) return false
  const w = c15.slice(-4)
  const hh =
    w[3]![2] > w[2]![2] * 0.999 && w[2]![2] >= w[1]![2] * 0.998
  const hl =
    w[3]![3] >= w[2]![3] * 0.997 && w[2]![3] >= w[1]![3] * 0.997
  const rising = w[3]![4] > w[0]![4]
  return hh && hl && rising
}

export interface PeakCandleRead {
  failed: boolean
  wick: boolean
  lh: boolean
  stall: boolean
  shootingStar: boolean
  hangingMan: boolean
  engulfing: boolean
  darkCloud: boolean
  eveningStar: boolean
  tweezer: boolean
  stillHH: boolean
  htfUp: boolean
  /** Rejection pattern, not just "price is high" */
  reversalPattern: boolean
  /** Safe to consider a fade vs still-alive long */
  globalOk: boolean
  patterns: string[]
}

export function readPeakCandles(opts: {
  candles1m: Candle[]
  price: number
  hi: number
  failed: boolean
  wick: boolean
  lh: boolean
  stall: boolean
}): PeakCandleRead {
  const c = opts.candles1m
  const last = c[c.length - 1]
  const prev = c[c.length - 2]
  const prev2 = c[c.length - 3]
  const star = shootingStar(last) || shootingStar(prev)
  const hang = hangingMan(last)
  const engulf = bearishEngulfing(prev, last)
  const cloud = darkCloud(prev, last)
  const eve = eveningStar(prev2, prev, last)
  const tweezer = tweezerTop(prev, last)
  const stillHH = stillMakingHH(c, 6)
  const c15 = aggregateTf(c, 15)
  const c5 = aggregateTf(c, 5)
  const htfUp = htfUptrend(c15) || htfUptrend(c5)
  const reversalPattern =
    opts.failed ||
    opts.wick ||
    star ||
    engulf ||
    eve ||
    cloud ||
    hang ||
    tweezer ||
    (opts.lh && !stillHH)
  const patterns: string[] = []
  if (star) patterns.push('shooting_star')
  if (hang) patterns.push('hanging_man')
  if (engulf) patterns.push('bearish_engulfing')
  if (cloud) patterns.push('dark_cloud')
  if (eve) patterns.push('evening_star')
  if (tweezer) patterns.push('tweezer_top')
  if (opts.failed) patterns.push('failed_break')
  if (opts.wick) patterns.push('rejection_wick')
  if (opts.lh) patterns.push('lower_high')
  if (opts.stall) patterns.push('stall')
  if (stillHH) patterns.push('1m_still_HH')
  if (htfUp) patterns.push('htf_uptrend')

  // Fade only a failed long: reversal print, 1m not still HH,
  // and HTF uptrend needs a real rejection (not stall/hanging-man).
  const htfAllowsFade =
    !htfUp || opts.failed || engulf || eve || star || opts.wick
  const globalOk = reversalPattern && !stillHH && htfAllowsFade

  return {
    failed: opts.failed,
    wick: opts.wick,
    lh: opts.lh,
    stall: opts.stall,
    shootingStar: star,
    hangingMan: hang,
    engulfing: engulf,
    darkCloud: cloud,
    eveningStar: eve,
    tweezer,
    stillHH,
    htfUp,
    reversalPattern,
    globalOk,
    patterns,
  }
}

export interface PeakBookRead {
  allow: boolean
  skip: string | null
  adj: number
  notes: string[]
}

/**
 * Hard veto: large live bids / bid-heavy OBI = magnet up. Never SHORT into that.
 */
export function readPeakBook(opts: {
  bookSeen: boolean
  snap?: OrderBookSnapshot | null
  crowd?: CrowdBookMetrics | null
  forecast?: MemeBookForecast | null
  evSide?: 'LONG' | 'SHORT' | null
  evKind?: string
  evReady?: boolean
}): PeakBookRead {
  const notes: string[] = []
  let adj = 0
  if (!opts.bookSeen || !opts.snap) {
    return {
      allow: true,
      skip: null,
      adj: -1,
      notes: ['стакан не читали — только сильный разворот свечей'],
    }
  }

  const crowd = opts.crowd
  const obi = opts.snap.obi
  const maxBid = crowd?.maxBidUsd ?? 0
  const maxAsk = crowd?.maxAskUsd ?? 0
  const ratio = crowd?.bidAskUsdRatio ?? 0
  const bidUsd = crowd?.bidSupportUsd ?? 0

  if (
    crowd?.largeBidWall ||
    maxBid >= 1200 ||
    bidUsd >= 900 ||
    (crowd?.stackedBidWalls ?? 0) >= 2
  ) {
    notes.push(
      `биды $${Math.round(Math.max(maxBid, bidUsd))} ×${crowd?.stackedBidWalls ?? 0} — магнит вверх, шорт запрещён`
    )
    return { allow: false, skip: 'bid_wall_magnet', adj: -3, notes }
  }
  if (ratio >= 1.55) {
    notes.push(`bids/asks USD ${ratio.toFixed(2)} — стакан покупает`)
    return { allow: false, skip: 'bid_ask_usd_skew', adj: -3, notes }
  }
  if (obi >= 10) {
    notes.push(`OBI ${obi.toFixed(0)}% в бидах — не шортим в спрос`)
    return { allow: false, skip: 'obi_bid_heavy', adj: -3, notes }
  }
  if (
    opts.forecast?.bias === 'NEXT_UP' ||
    (opts.forecast?.reasons ?? []).some((r) => r === 'obi_against')
  ) {
    notes.push('прогноз стакана: покупки / NEXT_UP')
    return { allow: false, skip: 'book_next_up', adj: -3, notes }
  }
  const kind = opts.evKind ?? ''
  if (
    opts.evReady &&
    opts.evSide === 'LONG' &&
    (kind === 'BID_WALL_SUPPORT' ||
      kind === 'ABSORPTION_LONG' ||
      kind === 'BUY_FLOW_IMBALANCE' ||
      kind === 'SPOOF_SWEEP_LONG' ||
      kind === 'LIQ_CASCADE_LONG')
  ) {
    notes.push(`событие стакана ${kind} = лонг, не шорт`)
    return { allow: false, skip: `book_event_long:${kind}`, adj: -3, notes }
  }
  if (crowd?.spoofAskWall && crowd.largeBidWall) {
    notes.push('yank ask + живые биды — ловушка шортов')
    return { allow: false, skip: 'spoof_ask_bid_magnet', adj: -3, notes }
  }

  if (crowd?.shortBaitAsks) {
    adj -= 1
    notes.push(`мелкие asks ×${crowd.crowdAskLevels} — приманка`)
  }
  if (crowd?.largeAskWall && obi <= -6) {
    adj += 2
    notes.push('живая ask-стена + OBI в продажи')
  } else if (crowd?.largeAskWall) {
    adj += 1
    notes.push('ask-стена есть')
  }
  if (obi <= -12) {
    adj += 2
    notes.push(`OBI ${obi.toFixed(0)}% в асках`)
  }
  if (opts.forecast?.bias === 'NEXT_DOWN') {
    adj += 2
    notes.push('прогноз стакана NEXT_DOWN')
  }
  if (maxAsk >= 800 && maxAsk > maxBid * 1.2) {
    adj += 1
    notes.push(`крупный ask $${Math.round(maxAsk)}`)
  }

  return { allow: true, skip: null, adj: Math.max(-2, Math.min(3, adj)), notes }
}
