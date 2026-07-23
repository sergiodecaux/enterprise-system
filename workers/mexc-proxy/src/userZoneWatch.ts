/**
 * User-defined zone watch: coin + price range → L/S bias, bounce target, monitor.
 */

import {
  analyzeConfluence,
  buildBotScoreCard,
} from './confluence'
import {
  assessZoneFuel,
  buildHtfLiquidityMap,
  findSmartZone,
} from './liquidityZones'
import { detectMarketRegime } from './regime'
import type { ConditionalSetupPayload } from './watchedSetups'

type Candle = [number, number, number, number, number, number]
type Side = 'LONG' | 'SHORT'

const MEXC = 'https://contract.mexc.com'

async function mexcJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${MEXC}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'EnterpriseSystem/2.0' },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  const json = await mexcJson<{
    data: {
      time: number[]
      open: number[]
      high: number[]
      low: number[]
      close: number[]
      vol: number[]
    }
  }>(`/api/v1/contract/kline/${symbol}?interval=${interval}&limit=${limit}`)
  const d = json?.data
  if (!d?.time?.length) return []
  const out: Candle[] = []
  for (let i = 0; i < d.time.length; i++) {
    out.push([
      d.time[i] * 1000,
      Number(d.open[i]),
      Number(d.high[i]),
      Number(d.low[i]),
      Number(d.close[i]),
      Number(d.vol[i] ?? 0),
    ])
  }
  return out
}

async function fetchBookImbalance(symbol: string): Promise<number | null> {
  const json = await mexcJson<{
    data?: { asks?: [number, number, number][]; bids?: [number, number, number][] }
  }>(`/api/v1/contract/depth/${symbol}?limit=20`)
  const asks = json?.data?.asks ?? []
  const bids = json?.data?.bids ?? []
  if (!asks.length || !bids.length) return null
  let askVol = 0
  let bidVol = 0
  for (const a of asks) askVol += Number(a[1] ?? 0)
  for (const b of bids) bidVol += Number(b[1] ?? 0)
  const tot = askVol + bidVol
  if (!(tot > 0)) return null
  return ((bidVol - askVol) / tot) * 100
}

async function fetchLastPrice(symbol: string): Promise<number | null> {
  const json = await mexcJson<{
    data?: { lastPrice?: number; symbol?: string } | Array<{ lastPrice?: number; symbol?: string }>
  }>(`/api/v1/contract/ticker?symbol=${symbol}`)
  const row = Array.isArray(json?.data) ? json?.data[0] : json?.data
  const px = Number(row?.lastPrice)
  return px > 0 ? px : null
}

/** Normalize user input → MEXC contract symbol */
export function resolveMexcSymbol(raw: string): string | null {
  let s = (raw || '').trim().toUpperCase()
  if (!s) return null
  s = s.replace(/\//g, '').replace(/-/g, '').replace(/_/g, '')
  if (s.endsWith('USDT')) {
    const base = s.slice(0, -4)
    return base ? `${base}_USDT` : null
  }
  // BTC, ETH, PEPE…
  if (/^[A-Z0-9]{2,15}$/.test(s)) return `${s}_USDT`
  return null
}

export interface ParsedZoneCommand {
  symbol: string
  zoneLow: number
  zoneHigh: number
  sideHint: Side | 'AUTO'
}

/**
 * Parse:
 *   BTC 94000-96000
 *   BTC 94000 96000
 *   ETH 3200-3350 long
 *   SOL 140–155 short
 */
export function parseZoneArg(arg: string): ParsedZoneCommand | { error: string } {
  const text = (arg || '').trim()
  if (!text) {
    return {
      error:
        'Формат: /zone BTC 94000-96000\nили /zone ETH 3200 3350 long\nили /zone SOL 140-155 short',
    }
  }
  const parts = text.split(/\s+/).filter(Boolean)
  if (parts.length < 2) {
    return { error: 'Нужны монета и диапазон. Пример: /zone BTC 94000-96000' }
  }

  const symbol = resolveMexcSymbol(parts[0])
  if (!symbol) return { error: `Не понял монету «${parts[0]}»` }

  let sideHint: Side | 'AUTO' = 'AUTO'
  const last = parts[parts.length - 1]?.toLowerCase()
  const rest = [...parts.slice(1)]
  if (last === 'long' || last === 'л' || last === 'лонг') {
    sideHint = 'LONG'
    rest.pop()
  } else if (last === 'short' || last === 'ш' || last === 'шорт') {
    sideHint = 'SHORT'
    rest.pop()
  }

  const rangeJoined = rest.join(' ')
  // 94000-96000 or 94000–96000 or 94000 96000
  const m = rangeJoined.match(
    /([0-9]+(?:[.,][0-9]+)?)\s*[-–—]\s*([0-9]+(?:[.,][0-9]+)?)/
  )
  let a: number
  let b: number
  if (m) {
    a = Number(m[1].replace(',', '.'))
    b = Number(m[2].replace(',', '.'))
  } else if (rest.length >= 2) {
    a = Number(rest[0].replace(',', '.'))
    b = Number(rest[1].replace(',', '.'))
  } else {
    return {
      error: 'Диапазон зоны: 94000-96000 или два числа. Пример: /zone BTC 94000 96000',
    }
  }
  if (!(a > 0) || !(b > 0) || a === b) {
    return { error: 'Цены зоны должны быть > 0 и разными' }
  }
  return {
    symbol,
    zoneLow: Math.min(a, b),
    zoneHigh: Math.max(a, b),
    sideHint,
  }
}

function tfBias(candles: Candle[]): 'BULL' | 'BEAR' | 'FLAT' {
  if (candles.length < 20) return 'FLAT'
  const closes = candles.map((c) => c[4])
  const last = closes[closes.length - 1]
  const sma =
    closes.slice(-20).reduce((s, x) => s + x, 0) / Math.min(20, closes.length)
  const look = Math.min(8, closes.length - 1)
  const mom =
    look > 0 && closes[closes.length - 1 - look] > 0
      ? ((last - closes[closes.length - 1 - look]) /
          closes[closes.length - 1 - look]) *
        100
      : 0
  if (last > sma * 1.002 && mom >= 0.15) return 'BULL'
  if (last < sma * 0.998 && mom <= -0.15) return 'BEAR'
  return 'FLAT'
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1000) return n.toFixed(2)
  if (Math.abs(n) >= 1) return n.toFixed(4)
  return n.toFixed(6)
}

export interface UserZoneAnalysis {
  symbol: string
  display: string
  price: number
  zoneLow: number
  zoneHigh: number
  preferredSide: Side
  altSide: Side
  biasNote: string
  reactionNote: string
  flyTarget: number
  flyLabel: string
  invalidate: number
  limitEntry: number
  probability: number
  scoreGrade: string
  phase: 'FAR' | 'APPROACH' | 'TOUCH'
  reportHtml: string
  setup: ConditionalSetupPayload
}

export async function analyzeUserZone(opts: {
  symbol: string
  zoneLow: number
  zoneHigh: number
  sideHint: Side | 'AUTO'
}): Promise<UserZoneAnalysis | { error: string }> {
  const symbol = opts.symbol
  const zoneLow = opts.zoneLow
  const zoneHigh = opts.zoneHigh
  const mid = (zoneLow + zoneHigh) / 2

  const [price, c1m, c1h, c4h, c1d, bookImb] = await Promise.all([
    fetchLastPrice(symbol),
    fetchKlines(symbol, 'Min1', 80),
    fetchKlines(symbol, 'Min60', 48),
    fetchKlines(symbol, 'Hour4', 90),
    fetchKlines(symbol, 'Day1', 60),
    fetchBookImbalance(symbol),
  ])

  if (!(price != null && price > 0)) {
    return { error: `Нет цены по ${symbol} на MEXC Futures (проверь имя контракта)` }
  }
  if (c4h.length < 20) {
    return { error: `Мало 4H данных по ${symbol}` }
  }

  const bias4h = tfBias(c4h)
  const bias1h = tfBias(c1h)
  const map = buildHtfLiquidityMap({
    candles4h: c4h,
    candles1d: c1d,
    candles1h: c1h,
    price,
  })
  const atr =
    c4h.length > 2
      ? Math.max(
          c4h[c4h.length - 1][2] - c4h[c4h.length - 1][3],
          price * 0.008
        )
      : price * 0.01

  // Score both sides against user zone
  const scoreSide = (side: Side) => {
    const conf = analyzeConfluence({
      candles4h: c4h,
      candles1m: c1m,
      side,
      price: mid,
    })
    const fuel = assessZoneFuel({
      side,
      price,
      zoneLow,
      zoneHigh,
      candles1m: c1m,
      bookImb,
    })
    const smart = findSmartZone(side, price, map, atr)
    const align: 'WITH_TREND' | 'COUNTER' =
      (side === 'LONG' && bias4h === 'BULL') ||
      (side === 'SHORT' && bias4h === 'BEAR') ||
      bias4h === 'FLAT'
        ? 'WITH_TREND'
        : 'COUNTER'
    const inv =
      side === 'LONG' ? zoneLow * 0.994 : zoneHigh * 1.006
    const flySmart =
      side === 'LONG'
        ? map.nearestBSL
        : map.nearestSSL
    const flyTarget = flySmart?.price
      ? flySmart.price
      : side === 'LONG'
        ? mid + Math.max(atr * 2.5, price * 0.015)
        : mid - Math.max(atr * 2.5, price * 0.015)
    const card = buildBotScoreCard({
      side,
      style: 'INTRADAY',
      bias4h,
      bias1h,
      align,
      regime: detectMarketRegime(c1h.length >= 20 ? c1h : c4h),
      bookImb,
      raid: conf.raid,
      absorption: conf.absorption,
      inOrderBlock: conf.inOrderBlock,
      inFvg: conf.inFvg,
      hasHtfZone: Boolean(smart) || true, // user supplied zone counts as zone
      zoneStrength: smart?.strength ?? 6,
      entry: mid,
      sl: inv,
      tp: flyTarget,
      toxicBook: false,
    })
    let pts = card.total
    // Price location relative to zone
    if (side === 'LONG' && price >= zoneLow && price <= zoneHigh * 1.002) pts += 1
    if (side === 'SHORT' && price <= zoneHigh && price >= zoneLow * 0.998) pts += 1
    // Book
    if (side === 'LONG' && bookImb != null && bookImb >= 12) pts += 1
    if (side === 'SHORT' && bookImb != null && bookImb <= -12) pts += 1
    // HTF
    if (side === 'LONG' && bias4h === 'BULL') pts += 1
    if (side === 'SHORT' && bias4h === 'BEAR') pts += 1
    return {
      side,
      pts,
      card,
      conf,
      fuel,
      flyTarget,
      flyLabel: flySmart
        ? `${flySmart.tf} ${side === 'LONG' ? 'BSL' : 'SSL'} ×${flySmart.touches} (${flySmart.strength})`
        : 'ATR/swing цель',
      inv,
      align,
    }
  }

  const longS = scoreSide('LONG')
  const shortS = scoreSide('SHORT')

  let preferred: Side
  if (opts.sideHint === 'LONG' || opts.sideHint === 'SHORT') {
    preferred = opts.sideHint
  } else {
    preferred = longS.pts >= shortS.pts ? 'LONG' : 'SHORT'
  }
  const chosen = preferred === 'LONG' ? longS : shortS
  const alt = preferred === 'LONG' ? shortS : longS

  const inZone = price >= zoneLow * 0.998 && price <= zoneHigh * 1.002
  const distPct = ((price - mid) / price) * 100
  const phase: UserZoneAnalysis['phase'] = inZone
    ? 'TOUCH'
    : Math.abs(distPct) <= 0.8
      ? 'APPROACH'
      : 'FAR'

  const limitEntry = preferred === 'LONG' ? (zoneLow + mid) / 2 : (zoneHigh + mid) / 2
  const risk = Math.abs(limitEntry - chosen.inv)
  const reward = Math.abs(chosen.flyTarget - limitEntry)
  const rr = risk > 0 ? reward / risk : 0
  const probability = Math.round(
    Math.min(
      82,
      Math.max(
        48,
        50 +
          chosen.pts * 2 +
          (chosen.card.grade === 'A+' ? 8 : chosen.card.grade === 'A' ? 5 : 0) +
          (phase === 'APPROACH' || phase === 'TOUCH' ? 4 : 0)
      )
    )
  )

  const strengthWeak =
    preferred === 'LONG'
      ? chosen.fuel.reactionOk || (bookImb != null && bookImb >= 12)
        ? 'сила на лонг (поглощение / стакан за покупки)'
        : 'пока нет явной силы — ждём реакцию в зоне'
      : chosen.fuel.reactionOk || (bookImb != null && bookImb <= -12)
        ? 'слабость на шорт (reject / стакан за продажи)'
        : 'пока нет явной слабости — ждём реакцию в зоне'

  const biasNote =
    preferred === 'LONG'
      ? `Предпочтительнее LONG (отскок вверх). Альтернатива SHORT слабее (${alt.pts} vs ${chosen.pts} pts).`
      : `Предпочтительнее SHORT (отскок вниз). Альтернатива LONG слабее (${alt.pts} vs ${chosen.pts} pts).`

  const display = symbol.replace('_USDT', '/USDT')
  const reportHtml = [
    `<b>📍 Зона пользователя · ${display}</b>`,
    `Контракт: <code>${symbol}</code>`,
    `Цена сейчас: <b>${fmt(price)}</b>`,
    `Твоя зона: <b>${fmt(zoneLow)} – ${fmt(zoneHigh)}</b> · фаза <b>${phase}</b>`,
    '',
    preferred === 'LONG' ? '🟢 <b>Идея: LONG</b>' : '🔴 <b>Идея: SHORT</b>',
    biasNote,
    `Реакция: ${strengthWeak}`,
    `Bias 4h/1h: ${bias4h}/${bias1h}`,
    bookImb == null
      ? 'OBI: n/a'
      : `OBI: ${bookImb >= 0 ? '+' : ''}${bookImb.toFixed(0)}%`,
    '',
    `<b>Куда может полететь:</b> ${fmt(chosen.flyTarget)}`,
    `Ликвидность: ${chosen.flyLabel}`,
    `Лимитка в зоне: ${fmt(limitEntry)}`,
    `Стоп / inv: ${fmt(chosen.inv)}`,
    `R:R ≈ 1:${rr.toFixed(1)} · вероятность ~${probability}%`,
    `ScoreCard: ${chosen.card.grade} (${chosen.card.total}/${chosen.card.max})`,
    '',
    'Confluence:',
    ...chosen.conf.lines.map((l) => `· ${l}`),
    ...chosen.card.factors.slice(0, 5).map((l) => `· ${l}`),
    '',
    '📡 Поставил на мониторинг (cron каждые 2 мин).',
    'Фазы: APPROACH → TOUCH → REACTION → FUEL → READY',
    'Команды: /zones — список · /zoneoff SYMBOL — снять',
  ].join('\n')

  const setup: ConditionalSetupPayload = {
    id: `user_zone_${symbol}_${preferred}_${Math.floor(zoneLow)}_${Math.floor(zoneHigh)}`,
    kind: 'USER_ZONE',
    side: preferred,
    title: `👤 Зона ${fmt(zoneLow)}–${fmt(zoneHigh)} · ${preferred}`,
    probability,
    preconditions: [
      {
        id: 'touch',
        label: `Касание твоей зоны ${fmt(zoneLow)}–${fmt(zoneHigh)}`,
        status: inZone ? 'MET' : 'PENDING',
      },
      {
        id: 'book',
        label: 'Стакан / топливо за сторону',
        status: 'PENDING',
      },
      {
        id: 'confirm',
        label:
          preferred === 'LONG'
            ? 'Сила на лонг (reclaim / absorption)'
            : 'Слабость на шорт (reject)',
        status: 'PENDING',
      },
    ],
    entryZone: { top: zoneHigh, bottom: zoneLow },
    limitEntry,
    target: chosen.flyTarget,
    invalidation: chosen.inv,
    triggerSummary: `USER ZONE ${preferred} → fly ${fmt(chosen.flyTarget)} (${chosen.flyLabel})`,
    reasoning: [
      biasNote,
      `Реакция: ${strengthWeak}`,
      `Цель: ${chosen.flyLabel} @ ${fmt(chosen.flyTarget)}`,
      `ScoreCard ${chosen.card.grade}`,
      ...chosen.conf.lines.slice(0, 3),
    ],
    status: inZone ? 'ARMED' : 'HYPOTHESIS',
    symbol,
    internalSymbol: symbol,
    createdAt: Date.now(),
  }

  return {
    symbol,
    display,
    price,
    zoneLow,
    zoneHigh,
    preferredSide: preferred,
    altSide: alt.side,
    biasNote,
    reactionNote: strengthWeak,
    flyTarget: chosen.flyTarget,
    flyLabel: chosen.flyLabel,
    invalidate: chosen.inv,
    limitEntry,
    probability,
    scoreGrade: chosen.card.grade,
    phase,
    reportHtml,
    setup,
  }
}
