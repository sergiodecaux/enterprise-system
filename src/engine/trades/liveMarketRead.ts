/**
 * Trader-style live tape: zone reaction, hour close, nearest bounce → D1/W targets.
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { FoundTradeZone } from '../zones/findTradeZones'

export type ZoneReactionKind =
  | 'IN_ZONE_TESTING'
  | 'BOUNCE_NO_HOLD'
  | 'BOUNCE_HELD'
  | 'BREAKING'
  | 'CONSOLIDATING'
  | 'APPROACHING'
  | 'EXTENDED'

export interface MagTarget {
  tf: '1D' | '1W'
  price: number
  label: string
  side: 'ABOVE' | 'BELOW'
  distancePct: number
}

export interface HourCloseRead {
  bull: boolean
  bodyPct: number
  rangePct: number
  closeNearHigh: boolean
  closeNearLow: boolean
  note: string
}

export interface BouncePlan {
  side: 'LONG' | 'SHORT'
  zoneLabel: string
  zoneMid: number
  zoneTop: number
  zoneBottom: number
  distancePct: number
  winPct: number
  thesis: string
  steps: string[]
  targets: MagTarget[]
  invalidation: number
}

export interface LiveMarketRead {
  whatNow: string
  reaction: ZoneReactionKind
  reactionNote: string
  hourClose: HourCloseRead | null
  dayBias: 'BULL' | 'BEAR' | 'DOJI'
  dayNote: string
  nearestBounce: BouncePlan | null
  targets: MagTarget[]
  lines: string[]
}

function closed(candles: OhlcvCandle[]): OhlcvCandle[] {
  return candles.length >= 2 ? candles.slice(0, -1) : candles
}

function fmt(p: number): string {
  if (!(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toFixed(6)
}

function distPct(price: number, level: number): number {
  if (!(price > 0)) return 999
  return ((level - price) / price) * 100
}

function weeklyCandles(candles1d: OhlcvCandle[], weeks = 12): OhlcvCandle[] {
  const c = closed(candles1d)
  if (c.length < 7) return []
  const out: OhlcvCandle[] = []
  for (let i = c.length - 1; i >= 6 && out.length < weeks; i -= 7) {
    const slice = c.slice(Math.max(0, i - 6), i + 1)
    if (!slice.length) continue
    const o = slice[0]![1]
    const cl = slice[slice.length - 1]![4]
    const h = Math.max(...slice.map((x) => x[2]))
    const l = Math.min(...slice.map((x) => x[3]))
    const v = slice.reduce((s, x) => s + x[5], 0)
    out.unshift([slice[0]![0], o, h, l, cl, v])
  }
  return out
}

function pickSwingLevels(
  candles: OhlcvCandle[],
  price: number
): { highs: number[]; lows: number[] } {
  const c = closed(candles)
  const highs: number[] = []
  const lows: number[] = []
  for (let i = 2; i < c.length - 2; i++) {
    const h = c[i]![2]
    const l = c[i]![3]
    if (
      h >= c[i - 1]![2] &&
      h >= c[i - 2]![2] &&
      h >= c[i + 1]![2] &&
      h >= c[i + 2]![2]
    ) {
      highs.push(h)
    }
    if (
      l <= c[i - 1]![3] &&
      l <= c[i - 2]![3] &&
      l <= c[i + 1]![3] &&
      l <= c[i + 2]![3]
    ) {
      lows.push(l)
    }
  }
  const above = highs.filter((x) => x > price * 1.002).sort((a, b) => a - b)
  const below = lows.filter((x) => x < price * 0.998).sort((a, b) => b - a)
  return { highs: above.slice(0, 4), lows: below.slice(0, 4) }
}

export function buildHtfTargets(
  price: number,
  candles1d: OhlcvCandle[]
): MagTarget[] {
  const targets: MagTarget[] = []
  const d = pickSwingLevels(candles1d, price)
  if (d.highs[0]) {
    targets.push({
      tf: '1D',
      price: d.highs[0],
      label: 'D1 swing high',
      side: 'ABOVE',
      distancePct: distPct(price, d.highs[0]),
    })
  }
  if (d.lows[0]) {
    targets.push({
      tf: '1D',
      price: d.lows[0],
      label: 'D1 swing low',
      side: 'BELOW',
      distancePct: distPct(price, d.lows[0]),
    })
  }

  const w = weeklyCandles(candles1d)
  if (w.length >= 3) {
    const wh = Math.max(...w.slice(-8).map((x) => x[2]))
    const wl = Math.min(...w.slice(-8).map((x) => x[3]))
    if (wh > price * 1.003) {
      targets.push({
        tf: '1W',
        price: wh,
        label: 'W high (8н)',
        side: 'ABOVE',
        distancePct: distPct(price, wh),
      })
    }
    if (wl < price * 0.997) {
      targets.push({
        tf: '1W',
        price: wl,
        label: 'W low (8н)',
        side: 'BELOW',
        distancePct: distPct(price, wl),
      })
    }
  }

  const seen: MagTarget[] = []
  for (const t of targets.sort(
    (a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct)
  )) {
    if (seen.some((s) => Math.abs(s.price - t.price) / t.price < 0.004)) continue
    seen.push(t)
  }
  return seen.slice(0, 6)
}

export function readHourClose(candles1h: OhlcvCandle[]): HourCloseRead | null {
  const c = closed(candles1h)
  if (c.length < 2) return null
  const bar = c[c.length - 1]!
  const o = bar[1]
  const h = bar[2]
  const l = bar[3]
  const cl = bar[4]
  if (!(o > 0) || !(h > l)) return null
  const bodyPct = ((cl - o) / o) * 100
  const rangePct = ((h - l) / o) * 100
  const bull = cl >= o
  const closeNearHigh = (h - cl) / (h - l) <= 0.25
  const closeNearLow = (cl - l) / (h - l) <= 0.25

  let note: string
  if (bull && closeNearHigh && Math.abs(bodyPct) >= 0.15) {
    note = `Час закрыт бычье у хая (+${bodyPct.toFixed(2)}%) — давление вверх`
  } else if (!bull && closeNearLow && Math.abs(bodyPct) >= 0.15) {
    note = `Час закрыт медвежье у лоя (${bodyPct.toFixed(2)}%) — давление вниз`
  } else if (bull && closeNearLow) {
    note = `Час зелёный, но закрытие у лоя — слабый бык / ловушка`
  } else if (!bull && closeNearHigh) {
    note = `Час красный, но закрытие у хая — слабый медведь / поглощение`
  } else if (rangePct < 0.25) {
    note = `Час сжатый (range ${rangePct.toFixed(2)}%) — консолидация`
  } else {
    note = `Час ${bull ? 'бычий' : 'медвежий'} ${bodyPct >= 0 ? '+' : ''}${bodyPct.toFixed(2)}% · range ${rangePct.toFixed(2)}%`
  }

  return { bull, bodyPct, rangePct, closeNearHigh, closeNearLow, note }
}

function dayBiasOf(candles1d: OhlcvCandle[]): {
  bias: 'BULL' | 'BEAR' | 'DOJI'
  note: string
} {
  const c = closed(candles1d)
  if (c.length < 2) return { bias: 'DOJI', note: 'D1: мало данных' }
  const bar = c[c.length - 1]!
  const o = bar[1]
  const cl = bar[4]
  if (!(o > 0)) return { bias: 'DOJI', note: 'D1: нет цены' }
  const pct = ((cl - o) / o) * 100
  if (Math.abs(pct) < 0.15) {
    return {
      bias: 'DOJI',
      note: `День дожи (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`,
    }
  }
  if (pct > 0) {
    return {
      bias: 'BULL',
      note: `День зелёный +${pct.toFixed(2)}% — цели вверх приоритетнее`,
    }
  }
  return {
    bias: 'BEAR',
    note: `День красный ${pct.toFixed(2)}% — цели вниз приоритетнее`,
  }
}

export function readZoneReaction(opts: {
  price: number
  zones: FoundTradeZone[]
  candles: OhlcvCandle[]
}): { reaction: ZoneReactionKind; note: string; near: FoundTradeZone | null } {
  const near = [...opts.zones].sort(
    (a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct)
  )[0]
  if (!near) {
    return {
      reaction: 'EXTENDED',
      note: 'Нет ближайшей HTF-зоны — ждём карту ликвидности',
      near: null,
    }
  }

  const d = Math.abs(near.distancePct)
  const inZone =
    opts.price >= near.bottom * 0.998 && opts.price <= near.top * 1.002
  const c = closed(opts.candles)
  const recent = c.slice(-8)
  if (recent.length < 3) {
    return {
      reaction: inZone
        ? 'IN_ZONE_TESTING'
        : d <= 1.2
          ? 'APPROACHING'
          : 'EXTENDED',
      note: inZone
        ? `Цена в ${near.label} — тест`
        : `До ${near.label}: ${d.toFixed(2)}%`,
      near,
    }
  }

  const touched = recent.some(
    (bar) => bar[3] <= near.top * 1.001 && bar[2] >= near.bottom * 0.999
  )
  const last = recent[recent.length - 1]!
  const closedInZone =
    last[4] >= near.bottom * 0.998 && last[4] <= near.top * 1.002

  if (near.side === 'LONG' && touched) {
    const held =
      closedInZone ||
      (last[4] > near.mid && last[4] > last[1])
    const afterTouch = recent.slice(-4)
    const hadGreen = afterTouch.some(
      (b) => b[4] > b[1] && b[4] > near.mid
    )
    if (
      hadGreen &&
      last[4] < near.top &&
      last[4] < afterTouch[0]![4] &&
      !held
    ) {
      return {
        reaction: 'BOUNCE_NO_HOLD',
        note: `Отскок от ${near.label} был, но не закрепился — цена снова ниже/в зоне`,
        near,
      }
    }
    if (held && last[4] > near.mid && last[4] >= last[1]) {
      return {
        reaction: 'BOUNCE_HELD',
        note: `Отскок от ${near.label} держится — закрытие выше середины зоны`,
        near,
      }
    }
    if (last[4] < near.bottom * 0.995) {
      return {
        reaction: 'BREAKING',
        note: `Слом ${near.label} вниз — SSL пробит, жди reclaim или цели ниже`,
        near,
      }
    }
  }

  if (near.side === 'SHORT' && touched) {
    const held =
      closedInZone || (last[4] < near.mid && last[4] < last[1])
    const afterTouch = recent.slice(-4)
    const hadRed = afterTouch.some((b) => b[4] < b[1] && b[4] < near.mid)
    if (
      hadRed &&
      last[4] > near.bottom &&
      last[4] > afterTouch[0]![4] &&
      !held
    ) {
      return {
        reaction: 'BOUNCE_NO_HOLD',
        note: `Отбой от ${near.label} был, но не закрепился — цена снова выше/в зоне`,
        near,
      }
    }
    if (held && last[4] < near.mid && last[4] <= last[1]) {
      return {
        reaction: 'BOUNCE_HELD',
        note: `Отбой от ${near.label} держится — закрытие ниже середины зоны`,
        near,
      }
    }
    if (last[4] > near.top * 1.005) {
      return {
        reaction: 'BREAKING',
        note: `Слом ${near.label} вверх — BSL пробит, жди reclaim или цели выше`,
        near,
      }
    }
  }

  if (inZone || closedInZone) {
    const range =
      recent.reduce((s, b) => s + (b[2] - b[3]), 0) / Math.max(recent.length, 1)
    const avgBody =
      recent.reduce((s, b) => s + Math.abs(b[4] - b[1]), 0) /
      Math.max(recent.length, 1)
    if (avgBody < range * 0.35) {
      return {
        reaction: 'CONSOLIDATING',
        note: `Консолидация в ${near.label} — жду импульс или выход`,
        near,
      }
    }
    return {
      reaction: 'IN_ZONE_TESTING',
      note: `Тест ${near.label} сейчас — нужна реакция стакана/свечи`,
      near,
    }
  }

  if (d <= 1.2) {
    return {
      reaction: 'APPROACHING',
      note: `Подход к ${near.label} (${d.toFixed(2)}%) — готовить лимит`,
      near,
    }
  }

  return {
    reaction: 'EXTENDED',
    note: `Далеко от ${near.label} (${d.toFixed(1)}%) — не догонять, ждать зону`,
    near,
  }
}

function buildBouncePlan(opts: {
  zones: FoundTradeZone[]
  price: number
  targets: MagTarget[]
  dayBias: 'BULL' | 'BEAR' | 'DOJI'
  hour: HourCloseRead | null
  reaction: ZoneReactionKind
}): BouncePlan | null {
  const longs = opts.zones
    .filter((z) => z.side === 'LONG' && z.mid < opts.price * 1.002)
    .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))
  const shorts = opts.zones
    .filter((z) => z.side === 'SHORT' && z.mid > opts.price * 0.998)
    .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))

  const preferLong =
    opts.dayBias === 'BULL' ||
    (opts.dayBias === 'DOJI' && (opts.hour?.bull ?? true))
  const preferShort =
    opts.dayBias === 'BEAR' ||
    (opts.dayBias === 'DOJI' && opts.hour != null && !opts.hour.bull)

  let pick = preferLong
    ? longs[0]
    : preferShort
      ? shorts[0]
      : (longs[0] ?? shorts[0])
  if (!pick) pick = longs[0] ?? shorts[0]
  if (!pick) return null

  if (opts.reaction === 'BOUNCE_NO_HOLD' || opts.reaction === 'BREAKING') {
    const pool = pick.side === 'LONG' ? longs : shorts
    pick = pool[1] ?? pool[0] ?? pick
  }

  const alignedTargets = opts.targets.filter((t) =>
    pick!.side === 'LONG' ? t.side === 'ABOVE' : t.side === 'BELOW'
  )
  const path = alignedTargets.slice(0, 3)

  let winPct = 58
  if (opts.reaction === 'APPROACHING' || opts.reaction === 'IN_ZONE_TESTING') {
    winPct += 6
  }
  if (opts.reaction === 'BOUNCE_HELD') winPct += 8
  if (opts.reaction === 'BOUNCE_NO_HOLD') winPct -= 8
  if (opts.reaction === 'BREAKING') winPct -= 10
  if (
    (pick.side === 'LONG' && opts.dayBias === 'BULL') ||
    (pick.side === 'SHORT' && opts.dayBias === 'BEAR')
  ) {
    winPct += 5
  }
  if (opts.hour) {
    if (
      (pick.side === 'LONG' && opts.hour.bull && opts.hour.closeNearHigh) ||
      (pick.side === 'SHORT' && !opts.hour.bull && opts.hour.closeNearLow)
    ) {
      winPct += 4
    }
  }
  winPct = Math.max(35, Math.min(82, winPct + Math.round(pick.strength)))

  const steps = [
    `Ждать ${pick.label} @ ${fmt(pick.mid)} (сейчас ${Math.abs(pick.distancePct).toFixed(2)}%)`,
    `Реакция: пинбар/поглощение + стакан за ${pick.side}`,
    path[0]
      ? `Цель 1: ${path[0].label} @ ${fmt(path[0].price)} (${path[0].distancePct.toFixed(1)}%)`
      : 'Цель: ближайшая противоположная ликвидность',
    path[1]
      ? `Цель 2 (HTF): ${path[1].label} @ ${fmt(path[1].price)}`
      : 'Дальше — магнит D1/W по тренду дня',
  ]

  return {
    side: pick.side,
    zoneLabel: pick.label,
    zoneMid: pick.mid,
    zoneTop: pick.top,
    zoneBottom: pick.bottom,
    distancePct: pick.distancePct,
    winPct,
    thesis:
      pick.side === 'LONG'
        ? `Ближайший отскок LONG от ${pick.label} → полёт к дневным/недельным хаям`
        : `Ближайший отбой SHORT от ${pick.label} → полёт к дневным/недельным лоям`,
    steps,
    targets: path,
    invalidation:
      pick.side === 'LONG' ? pick.bottom * 0.992 : pick.top * 1.008,
  }
}

export function analyzeLiveMarket(opts: {
  price: number
  candles: OhlcvCandle[]
  candles1h?: OhlcvCandle[]
  candles1d?: OhlcvCandle[]
  zones: FoundTradeZone[]
}): LiveMarketRead {
  const candles1d = opts.candles1d ?? []
  const targets =
    candles1d.length >= 20 ? buildHtfTargets(opts.price, candles1d) : []
  const hourClose =
    opts.candles1h && opts.candles1h.length >= 3
      ? readHourClose(opts.candles1h)
      : null
  const { bias: dayBias, note: dayNote } = dayBiasOf(candles1d)
  const { reaction, note: reactionNote } = readZoneReaction({
    price: opts.price,
    zones: opts.zones,
    candles: opts.candles,
  })

  const nearestBounce = buildBouncePlan({
    zones: opts.zones,
    price: opts.price,
    targets,
    dayBias,
    hour: hourClose,
    reaction,
  })

  const lines: string[] = [reactionNote]
  if (hourClose) lines.push(hourClose.note)
  lines.push(dayNote)
  if (nearestBounce) {
    lines.push(
      `План: ${nearestBounce.side} от ${nearestBounce.zoneLabel} → ${
        nearestBounce.targets[0]
          ? nearestBounce.targets[0].label
          : 'HTF цель'
      } (~${nearestBounce.winPct}%)`
    )
  }
  for (const t of targets.slice(0, 3)) {
    lines.push(
      `${t.tf} ${t.side === 'ABOVE' ? '↑' : '↓'} ${t.label} @ ${fmt(t.price)} (${t.distancePct.toFixed(1)}%)`
    )
  }

  let whatNow = reactionNote
  if (reaction === 'BOUNCE_NO_HOLD') {
    whatNow =
      'Отскок был, закрепления нет — не входить вдогонку; ждать следующую зону или reclaim.'
  } else if (reaction === 'BOUNCE_HELD') {
    whatNow =
      'Зона отработала и держит — можно работать продолжение к D1/W целям по тренду дня.'
  } else if (reaction === 'CONSOLIDATING') {
    whatNow =
      'Цена крепится в зоне — жди выход с объёмом; лимит на границе зоны.'
  } else if (reaction === 'BREAKING') {
    whatNow =
      'Зона сломана — сценарий отскока отменён, пока нет reclaim; цель — следующая ликвидность.'
  }

  return {
    whatNow,
    reaction,
    reactionNote,
    hourClose,
    dayBias,
    dayNote,
    nearestBounce,
    targets,
    lines: lines.slice(0, 10),
  }
}
