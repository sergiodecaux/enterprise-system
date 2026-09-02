/**
 * Elite briefing — BTC + TOP-8 alts, Mini-App-style market picture.
 * Hourly: F&G, news, zones, scalp/intraday ideas, liq map.
 * Daily: how the day closed per coin.
 */

import { getMarketContext, type MarketContext } from '../marketContext'
import {
  biasFromCandles,
  buildGlobalScanContext,
  type GlobalScanContext,
} from '../globalScanContext'
import {
  buildHtfLiquidityMap,
  findSmartZone,
} from '../liquidityZones'
import { detectMarketRegime } from '../regime'
import { atr, fetchTickers, type VaneTicker } from '../vane/mexc'
import { fetchKlinesCached } from '../vane/htfCache'
import { evaluateVaneSession } from '../vane/sessionFilter'
import type { Candle, Side, VaneKv } from '../vane/types'
import { PREFERRED_ALTS } from '../vane/universe'

export const ELITE_BRIEF_SYMBOLS = [
  'BTC_USDT',
  ...PREFERRED_ALTS,
] as const

export type BriefKind = 'hourly' | 'daily'

export interface CoinBriefRow {
  symbol: string
  base: string
  price: number
  chg24: number
  bias1h: 'BULL' | 'BEAR' | 'FLAT'
  bias4h: 'BULL' | 'BEAR' | 'FLAT'
  bias1d: 'BULL' | 'BEAR' | 'FLAT'
  regime: string
  dayColor: 'GREEN' | 'RED' | 'DOJI'
  dayChgPct: number
  fundingPct: number | null
  zoneLong: string | null
  zoneShort: string | null
  scalpIdea: string | null
  intraIdea: string | null
  liqNote: string | null
  newsNote: string | null
}

export interface EliteBriefing {
  kind: BriefKind
  generatedAt: number
  sessionLine: string
  marketLines: string[]
  fearGreedLine: string
  newsLines: string[]
  coins: CoinBriefRow[]
  rankedIdeas: string[]
  htmlParts: string[]
}

function baseOf(symbol: string): string {
  return symbol.replace(/_USDT$/i, '')
}

function fmt(n: number, d = 4): string {
  if (!(n > 0)) return '—'
  if (n >= 1000) return n.toFixed(2)
  if (n >= 1) return n.toFixed(4)
  return n.toPrecision(4)
}

function dayStats(candles1d: Candle[]): {
  color: 'GREEN' | 'RED' | 'DOJI'
  chgPct: number
} {
  if (candles1d.length < 2) return { color: 'DOJI', chgPct: 0 }
  // Prefer last closed day if available
  const c =
    candles1d.length >= 2
      ? candles1d[candles1d.length - 2]!
      : candles1d[candles1d.length - 1]!
  const [, o, h, l, close] = c
  const body = Math.abs(close - o)
  const range = Math.max(h - l, 1e-12)
  const color: 'GREEN' | 'RED' | 'DOJI' =
    body / range < 0.12 ? 'DOJI' : close >= o ? 'GREEN' : 'RED'
  const chgPct = o > 0 ? ((close - o) / o) * 100 : 0
  return { color, chgPct }
}

function phaseDist(
  price: number,
  low: number,
  high: number
): { phase: string; distPct: number } {
  const mid = (low + high) / 2
  const distPct = (Math.abs(price - mid) / price) * 100
  if (price >= low * 0.997 && price <= high * 1.003) {
    return { phase: 'TOUCH', distPct }
  }
  if (distPct <= 1.8) return { phase: 'APPROACH', distPct }
  return { phase: 'FAR', distPct }
}

function zoneLine(
  side: Side,
  price: number,
  map: ReturnType<typeof buildHtfLiquidityMap>,
  atr15: number
): string | null {
  const z = findSmartZone(side, price, map, atr15, { relaxed: true })
  if (!z) return null
  const { phase, distPct } = phaseDist(price, z.zoneLow, z.zoneHigh)
  return `${side} ${z.tf} ${z.source} ${fmt(z.zoneLow)}–${fmt(z.zoneHigh)} · ${phase} ${distPct.toFixed(1)}% · сила ${z.strength}`
}

function ideaFromZone(
  style: 'SCALP' | 'INTRADAY',
  side: Side,
  price: number,
  map: ReturnType<typeof buildHtfLiquidityMap>,
  atr15: number,
  bias4h: string,
  bias1h: string
): string | null {
  const z = findSmartZone(side, price, map, atr15, { relaxed: true })
  if (!z) return null
  const { phase, distPct } = phaseDist(price, z.zoneLow, z.zoneHigh)
  if (phase === 'FAR' && distPct > 2.5) return null
  const withHtf =
    (side === 'LONG' && (bias4h === 'BULL' || bias1h === 'BULL')) ||
    (side === 'SHORT' && (bias4h === 'BEAR' || bias1h === 'BEAR'))
  if (style === 'SCALP' && phase !== 'TOUCH' && phase !== 'APPROACH') return null
  if (style === 'INTRADAY' && distPct > 3.5) return null
  const align = withHtf ? 'WITH' : 'WAIT/COUNTER'
  const tgt =
    side === 'LONG'
      ? price * (1 + (style === 'SCALP' ? 0.006 : 0.018))
      : price * (1 - (style === 'SCALP' ? 0.006 : 0.018))
  return `${style} ${side} от ${fmt(z.limitEntry)} → ~${fmt(tgt)} · ${phase} · ${align}`
}

function liqNote(
  price: number,
  map: ReturnType<typeof buildHtfLiquidityMap>,
  funding: number | null
): string {
  const parts: string[] = []
  if (map.nearestSSL?.price) {
    const d = ((price - map.nearestSSL.price) / price) * 100
    parts.push(
      `SSL↓ ${fmt(map.nearestSSL.price)} (${d.toFixed(2)}% · ${map.nearestSSL.tf}/${map.nearestSSL.strength})`
    )
  }
  if (map.nearestBSL?.price) {
    const d = ((map.nearestBSL.price - price) / price) * 100
    parts.push(
      `BSL↑ ${fmt(map.nearestBSL.price)} (${d.toFixed(2)}% · ${map.nearestBSL.tf}/${map.nearestBSL.strength})`
    )
  }
  if (funding != null) {
    const f = funding * 100
    if (Math.abs(f) >= 0.03) {
      parts.push(
        f > 0
          ? `funding +${f.toFixed(3)}% (лонги платят)`
          : `funding ${f.toFixed(3)}% (шорты платят)`
      )
    }
  }
  return parts.length ? parts.join(' · ') : 'ликвидационные карманы без явного края'
}

async function loadCoinRow(
  symbol: string,
  ticker: VaneTicker | undefined,
  kv: VaneKv | undefined,
  mctx: MarketContext,
  kind: BriefKind
): Promise<CoinBriefRow | null> {
  const price = Number(ticker?.lastPrice ?? 0)
  if (!(price > 0)) return null

  const [c1h, c4h, c1d, c15m] = await Promise.all([
    fetchKlinesCached(kv, symbol, 'Min60', 48),
    fetchKlinesCached(kv, symbol, 'Hour4', 90),
    fetchKlinesCached(kv, symbol, 'Day1', 40),
    kind === 'hourly'
      ? fetchKlinesCached(kv, symbol, 'Min15', 64)
      : Promise.resolve([] as Candle[]),
  ])
  if (c4h.length < 20) return null

  const bias1h = biasFromCandles(c1h)
  const bias4h = biasFromCandles(c4h)
  const bias1d = biasFromCandles(c1d)
  const regime = detectMarketRegime(c1h.length >= 20 ? c1h : c4h)
  const day = dayStats(c1d)
  const atr15 =
    c15m.length >= 20 ? atr(c15m, 14) || price * 0.008 : price * 0.008
  const map = buildHtfLiquidityMap({
    candles4h: c4h,
    candles1d: c1d,
    candles1h: c1h,
    price,
  })

  const base = baseOf(symbol)
  const coinNews = mctx.coinNews[base]
  const newsNote = coinNews?.headlines?.[0]
    ? `${coinNews.label}: ${coinNews.headlines[0].slice(0, 80)}`
    : null

  const funding =
    ticker?.fundingRate != null ? Number(ticker.fundingRate) : null

  const scalpLong = ideaFromZone(
    'SCALP',
    'LONG',
    price,
    map,
    atr15,
    bias4h,
    bias1h
  )
  const scalpShort = ideaFromZone(
    'SCALP',
    'SHORT',
    price,
    map,
    atr15,
    bias4h,
    bias1h
  )
  const intraLong = ideaFromZone(
    'INTRADAY',
    'LONG',
    price,
    map,
    atr15,
    bias4h,
    bias1h
  )
  const intraShort = ideaFromZone(
    'INTRADAY',
    'SHORT',
    price,
    map,
    atr15,
    bias4h,
    bias1h
  )

  // Prefer WITH-trend idea
  const preferLong = bias4h === 'BULL' || bias1h === 'BULL'
  const preferShort = bias4h === 'BEAR' || bias1h === 'BEAR'
  const scalpIdea = preferLong
    ? scalpLong ?? scalpShort
    : preferShort
      ? scalpShort ?? scalpLong
      : scalpLong ?? scalpShort
  const intraIdea = preferLong
    ? intraLong ?? intraShort
    : preferShort
      ? intraShort ?? intraLong
      : intraLong ?? intraShort

  return {
    symbol,
    base,
    price,
    chg24: Number(ticker?.riseFallRate ?? 0) * 100,
    bias1h,
    bias4h,
    bias1d,
    regime,
    dayColor: day.color,
    dayChgPct: day.chgPct,
    fundingPct: funding != null ? funding * 100 : null,
    zoneLong: zoneLine('LONG', price, map, atr15),
    zoneShort: zoneLine('SHORT', price, map, atr15),
    scalpIdea,
    intraIdea,
    liqNote: liqNote(price, map, funding),
    newsNote,
  }
}

function fearLine(mctx: MarketContext): string {
  if (mctx.fearGreed == null) return 'Fear&Greed: —'
  const mood =
    mctx.fearGreed <= 25
      ? 'страх'
      : mctx.fearGreed <= 45
        ? 'осторожность'
        : mctx.fearGreed <= 55
          ? 'нейтрал'
          : mctx.fearGreed <= 75
            ? 'жадность'
            : 'эйфория'
  return `Fear&Greed: <b>${mctx.fearGreed}</b> (${mctx.fearGreedLabel} · ${mood})`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function formatHourlyHtml(
  session: string,
  global: GlobalScanContext,
  mctx: MarketContext,
  coins: CoinBriefRow[],
  ranked: string[],
  at: number
): string[] {
  const when = new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  const head = [
    `🏛 <b>ELITE HOURLY</b> · ${when}`,
    escapeHtml(session),
    '',
    '<b>Рынок</b>',
    ...global.lines.slice(0, 4).map(escapeHtml),
    fearLine(mctx),
    mctx.btcDominance != null
      ? `BTC.D: <b>${mctx.btcDominance.toFixed(2)}%</b>${
          mctx.btcDomDelta24h != null
            ? ` (${mctx.btcDomDelta24h >= 0 ? '+' : ''}${mctx.btcDomDelta24h.toFixed(2)}пп)`
            : ''
        }`
      : null,
    mctx.total3Usd != null
      ? `TOTAL3: <b>${
          mctx.total3Usd >= 1e12
            ? `$${(mctx.total3Usd / 1e12).toFixed(2)}T`
            : `$${(mctx.total3Usd / 1e9).toFixed(0)}B`
        }</b>${
          mctx.total3Delta24h != null
            ? ` (${mctx.total3Delta24h >= 0 ? '+' : ''}${mctx.total3Delta24h.toFixed(1)}%)`
            : ''
        } · ${
          mctx.altBias === 'LONG'
            ? 'лонг альты'
            : mctx.altBias === 'SHORT'
              ? 'шорт альты'
              : 'нейтрал'
        }`
      : null,
    '',
    '<b>Новости</b>',
    `Тон: <b>${mctx.newsLabel}</b>`,
    ...mctx.newsHeadlines.slice(0, 3).map((h) => `• ${escapeHtml(h.slice(0, 100))}`),
    '',
    '<b>Идеи сейчас</b> (отсортировано)',
    ...(ranked.length
      ? ranked.map((r, i) => `${i + 1}. ${escapeHtml(r)}`)
      : ['• нет чистых TOUCH/APPROACH идей — жду зоны']),
  ]
    .filter(Boolean)
    .join('\n')

  const parts: string[] = [head]
  // Coin cards in chunks of 3 to stay under TG limits
  for (let i = 0; i < coins.length; i += 3) {
    const chunk = coins.slice(i, i + 3)
    const body = chunk
      .map((c) => {
        const emoji =
          c.chg24 > 1 ? '🟢' : c.chg24 < -1 ? '🔴' : '⚪'
        return [
          `${emoji} <b>${c.base}</b> ${fmt(c.price)} · 24h ${c.chg24 >= 0 ? '+' : ''}${c.chg24.toFixed(2)}%`,
          `1H ${c.bias1h} · 4H ${c.bias4h} · 1D ${c.bias1d} · ${c.regime}`,
          c.zoneLong ? `📍 ${escapeHtml(c.zoneLong)}` : null,
          c.zoneShort ? `📍 ${escapeHtml(c.zoneShort)}` : null,
          c.scalpIdea ? `⚡ ${escapeHtml(c.scalpIdea)}` : null,
          c.intraIdea ? `📈 ${escapeHtml(c.intraIdea)}` : null,
          c.liqNote ? `💧 ${escapeHtml(c.liqNote)}` : null,
          c.newsNote ? `📰 ${escapeHtml(c.newsNote)}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      })
      .join('\n\n')
    parts.push(`<b>Монеты ${i + 1}–${i + chunk.length}</b>\n\n${body}`)
  }
  parts.push(
    '—\nElite Assistant · не сигнал входа, а карта для решения.\n/brief · /brief ETH · /zone · /market'
  )
  return parts
}

function formatDailyHtml(
  mctx: MarketContext,
  coins: CoinBriefRow[],
  at: number
): string[] {
  const when = new Date(at).toISOString().slice(0, 10)
  const sorted = [...coins].sort(
    (a, b) => Math.abs(b.dayChgPct) - Math.abs(a.dayChgPct)
  )
  const head = [
    `🌙 <b>ELITE DAILY CLOSE</b> · ${when} UTC`,
    fearLine(mctx),
    mctx.btcDominance != null
      ? `BTC.D ${mctx.btcDominance.toFixed(1)}%${
          mctx.btcDomDelta24h != null
            ? ` ${mctx.btcDomDelta24h >= 0 ? '+' : ''}${mctx.btcDomDelta24h.toFixed(2)}пп`
            : ''
        }`
      : '',
    mctx.altBias !== 'NEUTRAL'
      ? `Альты: <b>${mctx.altBias === 'LONG' ? 'лонг' : 'шорт'}</b> · ${escapeHtml(mctx.lines.find((l) => l.includes('TOTAL3') || l.includes('альт')) ?? '')}`
      : '',
    `Новости дня: <b>${mctx.newsLabel}</b>`,
    ...mctx.newsHeadlines.slice(0, 2).map((h) => `• ${escapeHtml(h.slice(0, 100))}`),
    '',
    '<b>Как закрылся день</b> (по |движению|)',
  ].join('\n')

  const lines = sorted.map((c, i) => {
    const icon =
      c.dayColor === 'GREEN' ? '🟢' : c.dayColor === 'RED' ? '🔴' : '⚪'
    return `${i + 1}. ${icon} <b>${c.base}</b> день ${c.dayChgPct >= 0 ? '+' : ''}${c.dayChgPct.toFixed(2)}% · 1D ${c.bias1d} · 24h ${c.chg24 >= 0 ? '+' : ''}${c.chg24.toFixed(2)}%\n   💧 ${escapeHtml(c.liqNote ?? '—')}`
  })

  const part1 = [head, ...lines.slice(0, 5)].join('\n')
  const part2 = [
    '<b>Остальные</b>',
    ...lines.slice(5),
    '',
    'Зоны на завтра:',
    ...sorted.slice(0, 4).map((c) => {
      const z = c.zoneLong ?? c.zoneShort
      return z ? `• ${c.base}: ${escapeHtml(z)}` : `• ${c.base}: зона далеко`
    }),
    '—\nElite Assistant · суточный итог',
  ].join('\n')

  return [part1, part2]
}

function rankIdeas(coins: CoinBriefRow[], global: GlobalScanContext): string[] {
  const scored: Array<{ s: number; text: string }> = []
  for (const c of coins) {
    for (const idea of [c.scalpIdea, c.intraIdea]) {
      if (!idea) continue
      let s = 10
      if (idea.includes('TOUCH')) s += 20
      if (idea.includes('APPROACH')) s += 12
      if (idea.includes('WITH')) s += 15
      if (idea.includes('SCALP')) s += 5
      if (idea.includes('INTRADAY')) s += 8
      if (c.base === 'BTC') s += 10
      if (
        (idea.includes('LONG') && global.preferIntraSide === 'LONG') ||
        (idea.includes('SHORT') && global.preferIntraSide === 'SHORT')
      ) {
        s += 10
      }
      if (Math.abs(c.chg24) >= 3) s += 5
      scored.push({ s, text: `${c.base}: ${idea}` })
    }
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, 8).map((x) => x.text)
}

/**
 * Build hourly or daily Elite briefing for BTC + TOP-8.
 */
export async function buildEliteBriefing(opts: {
  kind: BriefKind
  kv?: VaneKv
}): Promise<EliteBriefing> {
  const generatedAt = Date.now()
  const session = evaluateVaneSession()
  const sessionLine = session.ok
    ? `Сессия: ок · ${session.reason ?? 'торговля разрешена'}`
    : `Сессия: пауза · ${session.reason ?? 'blackout'}`

  const mctx = await getMarketContext()
  const tickers = await fetchTickers()
  const bySym = new Map(tickers.map((t) => [t.symbol, t]))

  // BTC klines for global context
  const [btc1h, btc4h, btc1d] = await Promise.all([
    fetchKlinesCached(opts.kv, 'BTC_USDT', 'Min60', 48),
    fetchKlinesCached(opts.kv, 'BTC_USDT', 'Hour4', 90),
    fetchKlinesCached(opts.kv, 'BTC_USDT', 'Day1', 40),
  ])
  const global = buildGlobalScanContext({
    btc1h,
    btc4h,
    btc1d,
    marketCtx: mctx,
  })

  const coins: CoinBriefRow[] = []
  for (const symbol of ELITE_BRIEF_SYMBOLS) {
    try {
      const row = await loadCoinRow(
        symbol,
        bySym.get(symbol),
        opts.kv,
        mctx,
        opts.kind
      )
      if (row) coins.push(row)
    } catch (err) {
      console.error('[elite] coin brief failed', symbol, err)
    }
  }

  // Sort coins: BTC first, then by |24h|
  coins.sort((a, b) => {
    if (a.base === 'BTC') return -1
    if (b.base === 'BTC') return 1
    return Math.abs(b.chg24) - Math.abs(a.chg24)
  })

  const rankedIdeas = rankIdeas(coins, global)
  const htmlParts =
    opts.kind === 'daily'
      ? formatDailyHtml(mctx, coins, generatedAt)
      : formatHourlyHtml(
          sessionLine,
          global,
          mctx,
          coins,
          rankedIdeas,
          generatedAt
        )

  return {
    kind: opts.kind,
    generatedAt,
    sessionLine,
    marketLines: global.lines,
    fearGreedLine: fearLine(mctx),
    newsLines: mctx.newsHeadlines.slice(0, 5),
    coins,
    rankedIdeas,
    htmlParts,
  }
}

/** Single-coin on-demand brief */
export async function buildEliteCoinBrief(
  symbolRaw: string,
  kv?: VaneKv
): Promise<string> {
  let symbol = symbolRaw.toUpperCase().replace('/', '_').replace('-', '_')
  if (!symbol.includes('_')) symbol = `${symbol}_USDT`
  const mctx = await getMarketContext()
  const tickers = await fetchTickers()
  const t = tickers.find((x) => x.symbol === symbol)
  const row = await loadCoinRow(symbol, t, kv, mctx, 'hourly')
  if (!row) return `Не смог собрать бриф по ${escapeHtml(symbol)}`
  return [
    `🔎 <b>ELITE · ${row.base}</b>`,
    `${fmt(row.price)} · 24h ${row.chg24 >= 0 ? '+' : ''}${row.chg24.toFixed(2)}%`,
    `1H ${row.bias1h} · 4H ${row.bias4h} · 1D ${row.bias1d} · ${row.regime}`,
    `День: ${row.dayColor} ${row.dayChgPct >= 0 ? '+' : ''}${row.dayChgPct.toFixed(2)}%`,
    fearLine(mctx),
    row.zoneLong ? `📍 ${escapeHtml(row.zoneLong)}` : null,
    row.zoneShort ? `📍 ${escapeHtml(row.zoneShort)}` : null,
    row.scalpIdea ? `⚡ ${escapeHtml(row.scalpIdea)}` : '⚡ скальп: нет чистой зоны',
    row.intraIdea ? `📈 ${escapeHtml(row.intraIdea)}` : '📈 интрадей: жду структуру',
    row.liqNote ? `💧 ${escapeHtml(row.liqNote)}` : null,
    row.newsNote ? `📰 ${escapeHtml(row.newsNote)}` : null,
    '—\nПомощник · /brief · /zone',
  ]
    .filter(Boolean)
    .join('\n')
}
