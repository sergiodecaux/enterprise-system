/**
 * Meme pump/dump causality monitor (local).
 *
 * Goal: find WHY memes pump/dump — what happens in book/tape BEFORE the move.
 *
 *   npx tsx scripts/memeBookMonitor.ts --minutes=60
 *
 * Writes rolling reports under workers/mexc-proxy/reports/
 */

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  detectMmSignal,
  detectWashTrading,
  type MmBookSnap,
  type MmDeal,
} from '../workers/mexc-proxy/src/mmPatterns'

const MEXC = 'https://contract.mexc.com'
const BLUE = new Set([
  'BTC_USDT',
  'ETH_USDT',
  'BNB_USDT',
  'SOL_USDT',
  'XRP_USDT',
  'ADA_USDT',
  'AVAX_USDT',
  'LINK_USDT',
  'LTC_USDT',
  'DOT_USDT',
  'BCH_USDT',
  'NEAR_USDT',
  'ATOM_USDT',
  'UNI_USDT',
  'APT_USDT',
  'SUI_USDT',
  'TRX_USDT',
  'TON_USDT',
])

const args = process.argv.slice(2)
function argNum(name: string, fallback: number): number {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  if (!hit) return fallback
  const n = Number(hit.split('=')[1])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const TOTAL_MIN = argNum('minutes', 60)
const COINS_PER_BATCH = argNum('batch', 6)
const ROUNDS = argNum('rounds', 5)
const ROUND_MS = argNum('roundMs', 2500)
const PAUSE_BETWEEN_BATCH_MS = argNum('pauseMs', 40_000)
const MIN_VOL = 200_000
const MAX_VOL = 30_000_000
const MIN_ABS_CHG = 3.5
/** Impulse thresholds between batches */
const IMPULSE_CHG_PCT = 1.2
const IMPULSE_MID_BPS = 35

interface Ticker {
  symbol: string
  lastPrice?: number | string
  riseFallRate?: number | string
  amount24?: number | string
  volume24?: number | string
}

/** One batch snapshot for a coin — used for before→after causality */
interface Snap {
  at: number
  batch: number
  chg24hPct: number
  mid: number
  spreadBps: number
  obi: number
  bidDepth: number
  askDepth: number
  buyQ: number
  sellQ: number
  cvd: number
  askWall: { price: number; notional: number; multiple: number } | null
  bidWall: { price: number; notional: number; multiple: number } | null
  askWallGone: boolean
  bidWallGone: boolean
  wash: boolean
  mmPattern: string | null
  mmSide: string | null
  thinBook: boolean
  sellDominates: boolean
  buyDominates: boolean
  btcChg1hApprox: number | null
}

interface Impulse {
  at: string
  symbol: string
  direction: 'PUMP' | 'DUMP'
  chgDelta: number
  midBps: number
  fromChg: number
  toChg: number
  /** Conditions observed on the PREVIOUS snapshot */
  precursors: string[]
  /** Hypothesis label */
  hypothesis: string
}

interface PatternStat {
  id: string
  title: string
  /** times this precursor appeared before a move of given direction */
  pumpHits: number
  dumpHits: number
  /** times precursor appeared without subsequent impulse (control) */
  falseAlarms: number
  examples: string[]
}

interface EventRow {
  at: string
  symbol: string
  kind: string
  detail: string
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function mexcJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${MEXC}${path}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'EnterpriseMemeCausality/1.0',
      },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

function quoteVol(t: Ticker): number {
  const a = Number(t.amount24 ?? 0)
  if (a > 0) return a
  const p = Number(t.lastPrice ?? 0)
  const v = Number(t.volume24 ?? 0)
  return p > 0 && v > 0 ? p * v : 0
}

function parseLevels(raw: unknown, side: 'asks' | 'bids'): Array<[number, number]> {
  if (!Array.isArray(raw)) return []
  const out: Array<[number, number]> = []
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2) continue
    const p = Number(row[0])
    const v = Number(row[1])
    if (p > 0 && v > 0) out.push([p, v])
  }
  out.sort((a, b) => (side === 'asks' ? a[0] - b[0] : b[0] - a[0]))
  return out.slice(0, 20)
}

function depthNotional(levels: Array<[number, number]>, n = 10): number {
  return levels.slice(0, n).reduce((s, [p, v]) => s + p * v, 0)
}

function topWall(
  levels: Array<[number, number]>,
  mid: number
): { price: number; notional: number; multiple: number } | null {
  if (!levels.length || !(mid > 0)) return null
  const near = levels.filter(([p]) => Math.abs(p - mid) / mid < 0.015)
  const pool = near.length ? near : levels.slice(0, 8)
  const vols = pool.map(([, v]) => v).sort((a, b) => a - b)
  const median = vols[Math.floor(vols.length / 2)] || 1
  let best: { price: number; notional: number; multiple: number } | null = null
  for (const [p, v] of pool) {
    const notional = p * v
    const multiple = v / median
    if (!best || notional > best.notional) best = { price: p, notional, multiple }
  }
  if (!best || best.multiple < 2.2 || best.notional < 600) return null
  return best
}

function flowQuote(deals: MmDeal[], now: number) {
  let buy = 0
  let sell = 0
  for (const d of deals) {
    const ts = Number(d.t ?? d.ts ?? 0)
    if (ts > 0 && now - ts > 60_000) continue
    const p = Number(d.p ?? 0)
    const v = Number(d.v ?? 0)
    if (!(p > 0 && v > 0)) continue
    const q = p * v
    if (d.T === 1) buy += q
    else if (d.T === 2) sell += q
  }
  return { buy, sell, cvd: buy - sell }
}

function pickUniverse(tickers: Ticker[]) {
  const rows = tickers
    .filter((t) => {
      const s = String(t.symbol ?? '')
      if (!s.endsWith('_USDT') || s.includes('USDC')) return false
      if (BLUE.has(s)) return false
      const price = Number(t.lastPrice ?? 0)
      const vol = quoteVol(t)
      const chg = Number(t.riseFallRate ?? 0) * 100
      if (!(price > 0) || price > 80) return false
      if (vol < MIN_VOL || vol > MAX_VOL) return false
      if (Math.abs(chg) < MIN_ABS_CHG) return false
      return true
    })
    .map((t) => {
      const chg = Number(t.riseFallRate ?? 0) * 100
      const vol = quoteVol(t)
      return {
        symbol: String(t.symbol),
        displayName: String(t.symbol).replace('_USDT', '/USDT'),
        chg24hPct: chg,
        quoteVolUsd: Math.round(vol),
        dayBias: (chg >= 0 ? 'PUMP' : 'DUMP') as 'PUMP' | 'DUMP',
        score: Math.abs(chg) * Math.log10(Math.max(vol, 10_000)),
      }
    })
    .sort((a, b) => b.score - a.score)

  const pumps = rows
    .filter((r) => r.dayBias === 'PUMP')
    .slice(0, Math.ceil(COINS_PER_BATCH / 2))
  const dumps = rows
    .filter((r) => r.dayBias === 'DUMP')
    .slice(0, Math.floor(COINS_PER_BATCH / 2))
  const picked = [...pumps, ...dumps]
  for (const r of rows) {
    if (picked.length >= COINS_PER_BATCH) break
    if (!picked.some((p) => p.symbol === r.symbol)) picked.push(r)
  }
  return picked
}

function precursorsOf(s: Snap): string[] {
  const p: string[] = []
  if (s.askWallGone) p.push('ASK_WALL_GONE')
  if (s.bidWallGone) p.push('BID_WALL_GONE')
  if (s.thinBook) p.push('THIN_BOOK')
  if (s.sellDominates) p.push('SELL_TAPE_DOM')
  if (s.buyDominates) p.push('BUY_TAPE_DOM')
  if (s.obi <= -25) p.push('OBI_ASK_HEAVY')
  if (s.obi >= 25) p.push('OBI_BID_HEAVY')
  if (s.askWall && s.askWall.multiple >= 4) p.push('BIG_ASK_WALL')
  if (s.bidWall && s.bidWall.multiple >= 4) p.push('BIG_BID_WALL')
  if (s.wash) p.push('WASH')
  if (s.mmPattern) p.push(`MM_${s.mmPattern}`)
  if (s.spreadBps >= 25) p.push('WIDE_SPREAD')
  if (s.btcChg1hApprox != null && s.btcChg1hApprox <= -0.4) p.push('BTC_SOFT')
  if (s.btcChg1hApprox != null && s.btcChg1hApprox >= 0.4) p.push('BTC_FIRM')
  return p
}

function hypothesisFor(
  direction: 'PUMP' | 'DUMP',
  precursors: string[]
): string {
  const has = (x: string) => precursors.includes(x)
  if (direction === 'PUMP') {
    if (has('ASK_WALL_GONE') && has('BUY_TAPE_DOM'))
      return 'Сняли ask-стену + buy tape → классический запуск пампа (магнит убран)'
    if (has('ASK_WALL_GONE') && has('THIN_BOOK'))
      return 'Тонкий стакан + снятие ask → лёгкий вынос вверх'
    if (has('SELL_TAPE_DOM') && (has('OBI_BID_HEAVY') || has('BIG_BID_WALL')))
      return 'Памп при sell-tape и бидах → MM/поглощение, разгрузка в лонгистов'
    if (has('SELL_TAPE_DOM'))
      return 'Памп продолжается на sell-доминации → поздняя фаза / раздача'
    if (has('BUY_TAPE_DOM') && has('OBI_BID_HEAVY'))
      return 'Живой спрос + bid-heavy book → органичный (или имитация) pump'
    if (has('BTC_FIRM'))
      return 'Памп на фоне сильного BTC — бета/риск-он'
    return 'Импульс вверх без явного book-триггера (внешняя новость / OTC / задержка данных)'
  }
  // DUMP
  if (has('BID_WALL_GONE') && has('SELL_TAPE_DOM'))
    return 'Сняли bid-поддержку + sell tape → обвал (ложный спрос убран)'
  if (has('BID_WALL_GONE') && has('THIN_BOOK'))
    return 'Тонкий стакан + снятие bid → быстрый dump'
  if (has('BUY_TAPE_DOM') && has('OBI_ASK_HEAVY'))
    return 'Dump при buy-tape и ask-heavy → ловушка на отскок / раздача в «покупателей дна»'
  if (has('BUY_TAPE_DOM'))
    return 'Dump + buy-доминация → покрытие шортов / набор лонга в падении (ещё не разворот)'
  if (has('ASK_WALL_GONE') && has('SELL_TAPE_DOM'))
    return 'Ask убрали, но продают — продолжение дампа после ложного breakout вверх'
  if (has('BTC_SOFT'))
    return 'Dump на мягком BTC — рыночный риск-офф усиливает мемы'
  return 'Импульс вниз без явного book-триггера'
}

function bumpPattern(
  stats: Map<string, PatternStat>,
  id: string,
  title: string,
  dir: 'PUMP' | 'DUMP' | 'NONE',
  example: string
) {
  let s = stats.get(id)
  if (!s) {
    s = {
      id,
      title,
      pumpHits: 0,
      dumpHits: 0,
      falseAlarms: 0,
      examples: [],
    }
    stats.set(id, s)
  }
  if (dir === 'PUMP') s.pumpHits++
  else if (dir === 'DUMP') s.dumpHits++
  else s.falseAlarms++
  if (example && s.examples.length < 6 && !s.examples.includes(example)) {
    s.examples.push(example)
  }
}

async function sampleSnap(
  coin: { symbol: string; chg24hPct: number },
  batch: number,
  prevSnap: Snap | null,
  btcChg: number | null
): Promise<Snap> {
  let prevBook: MmBookSnap | null = null
  let prevAsk: Snap['askWall'] = null
  let prevBid: Snap['bidWall'] = null
  let askWallGone = false
  let bidWallGone = false
  let washHit = false
  let mmPattern: string | null = null
  let mmSide: string | null = null
  let buyQ = 0
  let sellQ = 0
  let mid = 0
  let spreadBps = 0
  let obi = 0
  let bidDepth = 0
  let askDepth = 0
  let askWall: Snap['askWall'] = null
  let bidWall: Snap['bidWall'] = null

  for (let i = 0; i < ROUNDS; i++) {
    const [depthJson, dealsJson] = await Promise.all([
      mexcJson<{ data?: { asks?: unknown; bids?: unknown } }>(
        `/api/v1/contract/depth/${coin.symbol}?limit=20`
      ),
      mexcJson<{ data?: MmDeal[] }>(
        `/api/v1/contract/deals/${coin.symbol}?limit=120`
      ),
    ])
    const asks = parseLevels(depthJson?.data?.asks, 'asks')
    const bids = parseLevels(depthJson?.data?.bids, 'bids')
    const deals = (dealsJson?.data ?? []) as MmDeal[]
    mid =
      asks[0] && bids[0]
        ? (asks[0][0] + bids[0][0]) / 2
        : Number(bids[0]?.[0] ?? asks[0]?.[0] ?? 0)
    const now = Date.now()
    const book: MmBookSnap = { at: now, mid, asks, bids }
    const flow = flowQuote(deals, now)
    buyQ += flow.buy
    sellQ += flow.sell
    bidDepth = depthNotional(bids, 10)
    askDepth = depthNotional(asks, 10)
    const tot = bidDepth + askDepth
    obi = tot > 0 ? ((bidDepth - askDepth) / tot) * 100 : 0
    spreadBps =
      asks[0] && bids[0] && mid > 0
        ? ((asks[0][0] - bids[0][0]) / mid) * 10_000
        : 999

    const wash = detectWashTrading(
      deals,
      mid,
      bids[0]?.[0] ?? mid * 0.999,
      asks[0]?.[0] ?? mid * 1.001,
      now
    )
    if (wash.wash) washHit = true

    if (prevBook) {
      const pack = detectMmSignal({
        previous: prevBook,
        current: book,
        deals,
        chg24hPct: coin.chg24hPct,
        dayBias: coin.chg24hPct >= 0 ? 'PUMP' : 'DUMP',
      })
      if (pack.signal?.ready) {
        mmPattern = pack.signal.pattern
        mmSide = pack.signal.side
      }
    }

    askWall = topWall(asks, mid)
    bidWall = topWall(bids, mid)
    if (prevAsk && prevAsk.multiple >= 2.5) {
      const gone =
        !askWall ||
        Math.abs(prevAsk.price - askWall.price) / Math.max(mid, 1e-12) > 0.0015
      if (gone) askWallGone = true
    }
    if (prevBid && prevBid.multiple >= 2.5) {
      const gone =
        !bidWall ||
        Math.abs(prevBid.price - bidWall.price) / Math.max(mid, 1e-12) > 0.0015
      if (gone) bidWallGone = true
    }

    // Also compare to previous BATCH wall if first round
    if (i === 0 && prevSnap) {
      if (prevSnap.askWall && prevSnap.askWall.multiple >= 2.5) {
        const gone =
          !askWall ||
          Math.abs(prevSnap.askWall.price - askWall.price) / Math.max(mid, 1e-12) >
            0.002
        if (gone) askWallGone = true
      }
      if (prevSnap.bidWall && prevSnap.bidWall.multiple >= 2.5) {
        const gone =
          !bidWall ||
          Math.abs(prevSnap.bidWall.price - bidWall.price) / Math.max(mid, 1e-12) >
            0.002
        if (gone) bidWallGone = true
      }
    }

    prevBook = book
    prevAsk = askWall
    prevBid = bidWall
    if (i < ROUNDS - 1) await sleep(ROUND_MS)
  }

  return {
    at: Date.now(),
    batch,
    chg24hPct: coin.chg24hPct,
    mid,
    spreadBps,
    obi,
    bidDepth,
    askDepth,
    buyQ,
    sellQ,
    cvd: buyQ - sellQ,
    askWall,
    bidWall,
    askWallGone,
    bidWallGone,
    wash: washHit,
    mmPattern,
    mmSide,
    thinBook: bidDepth + askDepth < 25_000,
    sellDominates: sellQ > buyQ * 1.2 && sellQ > 500,
    buyDominates: buyQ > sellQ * 1.2 && buyQ > 500,
    btcChg1hApprox: btcChg,
  }
}

async function btcSoftGauge(): Promise<number | null> {
  // approximate short-term BTC move via last deal vs ticker chg is weak;
  // use 1m-ish from deals mid change if available — fallback to 24h*fraction no.
  const depth = await mexcJson<{
    data?: { asks?: unknown; bids?: unknown }
  }>('/api/v1/contract/depth/BTC_USDT?limit=5')
  const ticker = await mexcJson<{
    data?: { riseFallRate?: number | string; lastPrice?: number | string }
  }>('/api/v1/contract/ticker/BTC_USDT')
  if (!ticker?.data) return null
  const chg = Number(ticker.data.riseFallRate ?? 0) * 100
  // Use 24h chg as soft regime proxy (not 1h, but directionally useful)
  void depth
  return chg
}

function analyzeImpulses(
  history: Map<string, Snap[]>,
  impulses: Impulse[],
  patterns: Map<string, PatternStat>,
  events: EventRow[]
) {
  for (const [symbol, snaps] of history) {
    if (snaps.length < 2) continue
    const prev = snaps[snaps.length - 2]!
    const cur = snaps[snaps.length - 1]!
    const chgDelta = cur.chg24hPct - prev.chg24hPct
    const midBps =
      prev.mid > 0 ? ((cur.mid - prev.mid) / prev.mid) * 10_000 : 0

    const pump =
      chgDelta >= IMPULSE_CHG_PCT || midBps >= IMPULSE_MID_BPS
    const dump =
      chgDelta <= -IMPULSE_CHG_PCT || midBps <= -IMPULSE_MID_BPS

    const prec = precursorsOf(prev)
    const ex = `${symbol.replace('_USDT', '')} Δchg ${chgDelta >= 0 ? '+' : ''}${chgDelta.toFixed(2)} mid ${midBps.toFixed(0)}bps ← ${prec.join('+') || 'none'}`

    // Control: precursors without impulse
    if (!pump && !dump) {
      for (const p of prec) {
        bumpPattern(
          patterns,
          `ctrl:${p}`,
          `Контроль: ${p} без импульса`,
          'NONE',
          ex
        )
      }
      continue
    }

    const direction: 'PUMP' | 'DUMP' = pump && !dump
      ? 'PUMP'
      : dump && !pump
        ? 'DUMP'
        : Math.abs(chgDelta) >= Math.abs(midBps) / 30
          ? chgDelta >= 0
            ? 'PUMP'
            : 'DUMP'
          : midBps >= 0
            ? 'PUMP'
            : 'DUMP'

    // Prefer previous snap precursors; also merge intra-batch wall gone on current
    const merged = [
      ...prec,
      ...(cur.askWallGone ? ['ASK_WALL_GONE_INTRA'] : []),
      ...(cur.bidWallGone ? ['BID_WALL_GONE_INTRA'] : []),
    ]
    const hyp = hypothesisFor(direction, merged)
    const impulse: Impulse = {
      at: new Date(cur.at).toISOString(),
      symbol,
      direction,
      chgDelta,
      midBps,
      fromChg: prev.chg24hPct,
      toChg: cur.chg24hPct,
      precursors: merged,
      hypothesis: hyp,
    }
    impulses.push(impulse)
    events.push({
      at: impulse.at,
      symbol,
      kind: `IMPULSE_${direction}`,
      detail: `${hyp} | prec: ${merged.join(', ') || '—'}`,
    })

    // Pattern counters for causality
    for (const p of merged) {
      bumpPattern(
        patterns,
        `prec:${p}→${direction}`,
        `До ${direction === 'PUMP' ? 'пампа' : 'дампа'}: ${p}`,
        direction,
        ex
      )
    }
    if (merged.includes('ASK_WALL_GONE') && direction === 'PUMP') {
      bumpPattern(
        patterns,
        'rule:ask_gone→pump',
        'Снятие ASK-стены → памп',
        'PUMP',
        ex
      )
    }
    if (merged.includes('BID_WALL_GONE') && direction === 'DUMP') {
      bumpPattern(
        patterns,
        'rule:bid_gone→dump',
        'Снятие BID-стены → дамп',
        'DUMP',
        ex
      )
    }
    if (
      merged.includes('SELL_TAPE_DOM') &&
      direction === 'PUMP'
    ) {
      bumpPattern(
        patterns,
        'rule:sell_dom→pump_unload',
        'Sell-tape при пампе → разгрузка MM',
        'PUMP',
        ex
      )
    }
    if (merged.includes('BUY_TAPE_DOM') && direction === 'DUMP') {
      bumpPattern(
        patterns,
        'rule:buy_dom→dump_cover',
        'Buy-tape при дампе → покрытие/набор в падении',
        'DUMP',
        ex
      )
    }
    if (merged.includes('THIN_BOOK') && (direction === 'PUMP' || direction === 'DUMP')) {
      bumpPattern(
        patterns,
        `rule:thin→${direction.toLowerCase()}`,
        `Тонкий стакан → резкий ${direction === 'PUMP' ? 'памп' : 'дамп'}`,
        direction,
        ex
      )
    }
  }
}

function scorePatterns(patterns: Map<string, PatternStat>) {
  return [...patterns.values()]
    .filter((p) => p.id.startsWith('rule:') || p.id.startsWith('prec:'))
    .map((p) => {
      const hits = p.pumpHits + p.dumpHits
      const ctrl = patterns.get(`ctrl:${p.id.replace(/^prec:/, '').replace(/→.*$/, '')}`)
      // For rule:* use related ctrl if exists
      const falseAlarms = p.falseAlarms + (ctrl?.falseAlarms ?? 0)
      const precision = hits + falseAlarms > 0 ? hits / (hits + falseAlarms) : 0
      return { ...p, hits, precision }
    })
    .filter((p) => p.hits >= 1)
    .sort((a, b) => b.hits * 2 + b.precision - (a.hits * 2 + a.precision))
}

function renderMd(opts: {
  startedAt: string
  elapsedMin: number
  totalMin: number
  batches: number
  impulses: Impulse[]
  patterns: ReturnType<typeof scorePatterns>
  events: EventRow[]
  historySize: number
}): string {
  const lines: string[] = []
  lines.push(`# Meme Causality Monitor`)
  lines.push('')
  lines.push(`Started: ${opts.startedAt}`)
  lines.push(
    `Elapsed: ${opts.elapsedMin.toFixed(1)} / ${opts.totalMin} min · batches ${opts.batches} · tracked snaps ${opts.historySize}`
  )
  lines.push('')
  lines.push('## Закономерности (почему памп / дамп)')
  if (!opts.patterns.length) {
    lines.push('_Пока мало импульсов — накопление…_')
  } else {
    for (const p of opts.patterns.slice(0, 12)) {
      const dir =
        p.pumpHits > p.dumpHits ? '↑PUMP' : p.dumpHits > p.pumpHits ? '↓DUMP' : 'mixed'
      lines.push(
        `- **${p.title}** · hits ${p.hits} (${dir}) · precision~${(p.precision * 100).toFixed(0)}%`
      )
      for (const ex of p.examples.slice(0, 2)) {
        lines.push(`  - ${ex}`)
      }
    }
  }
  lines.push('')
  lines.push('## Импульсы и гипотезы причин')
  const recent = [...opts.impulses].slice(-25).reverse()
  if (!recent.length) lines.push('_Импульсов выше порога ещё нет._')
  for (const i of recent) {
    lines.push(
      `- \`${i.at.slice(11, 19)}\` **${i.symbol.replace('_USDT', '')}** ${i.direction} Δchg ${i.chgDelta >= 0 ? '+' : ''}${i.chgDelta.toFixed(2)} mid ${i.midBps.toFixed(0)}bps`
    )
    lines.push(`  - Precursors: ${i.precursors.join(', ') || '—'}`)
    lines.push(`  - → ${i.hypothesis}`)
  }
  lines.push('')
  lines.push('## Сводка')
  const pumps = opts.impulses.filter((i) => i.direction === 'PUMP').length
  const dumps = opts.impulses.filter((i) => i.direction === 'DUMP').length
  const askPump = opts.impulses.filter(
    (i) => i.direction === 'PUMP' && i.precursors.some((p) => p.includes('ASK_WALL'))
  ).length
  const bidDump = opts.impulses.filter(
    (i) => i.direction === 'DUMP' && i.precursors.some((p) => p.includes('BID_WALL'))
  ).length
  const unload = opts.impulses.filter(
    (i) => i.direction === 'PUMP' && i.precursors.includes('SELL_TAPE_DOM')
  ).length
  lines.push(`- Импульсы: PUMP ${pumps} / DUMP ${dumps}`)
  lines.push(`- Памп после снятия ASK: ${askPump}/${Math.max(pumps, 1)}`)
  lines.push(`- Дамп после снятия BID: ${bidDump}/${Math.max(dumps, 1)}`)
  lines.push(`- Памп на sell-tape (разгрузка): ${unload}/${Math.max(pumps, 1)}`)
  lines.push('')
  lines.push('## Лента событий (last 30)')
  for (const e of opts.events.slice(-30).reverse()) {
    lines.push(
      `- \`${e.at.slice(11, 19)}\` **${e.symbol.replace('_USDT', '')}** ${e.kind} — ${e.detail.slice(0, 160)}`
    )
  }
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  const outDir = join(process.cwd(), 'workers', 'mexc-proxy', 'reports')
  mkdirSync(outDir, { recursive: true })
  const stamp = startedAt.replace(/[:.]/g, '-').slice(0, 19)
  const jsonPath = join(outDir, `meme-causality-${stamp}.json`)
  const mdPath = join(outDir, `meme-causality-${stamp}.md`)
  const logPath = join(outDir, `meme-causality-${stamp}.log`)

  const history = new Map<string, Snap[]>()
  const impulses: Impulse[] = []
  const patterns = new Map<string, PatternStat>()
  const events: EventRow[] = []
  let batches = 0

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`
    console.log(line)
    appendFileSync(logPath, line + '\n')
  }

  log(
    `START causality minutes=${TOTAL_MIN} batch=${COINS_PER_BATCH} impulse=Δchg≥${IMPULSE_CHG_PCT}%|mid≥${IMPULSE_MID_BPS}bps`
  )
  writeFileSync(
    mdPath,
    `# Meme Causality Monitor starting…\n\nИщем что в стакане/ленте **перед** пампом и дампом.\n`
  )

  while ((Date.now() - started) / 60_000 < TOTAL_MIN) {
    batches++
    const btcChg = await btcSoftGauge()
    const tickersJson = await mexcJson<{ data?: Ticker[] }>(
      '/api/v1/contract/ticker'
    )
    const tickers = tickersJson?.data ?? []
    if (!tickers.length) {
      log('tickers fail, sleep')
      await sleep(15_000)
      continue
    }
    const universe = pickUniverse(tickers)
    log(
      `batch #${batches} BTC24h=${btcChg?.toFixed(2) ?? '?'}% :: ${universe
        .map((u) => `${u.displayName}:${u.chg24hPct.toFixed(1)}%`)
        .join(', ')}`
    )

    for (const coin of universe) {
      const prevList = history.get(coin.symbol) ?? []
      const prev = prevList[prevList.length - 1] ?? null
      try {
        const snap = await sampleSnap(coin, batches, prev, btcChg)
        const list = history.get(coin.symbol) ?? []
        list.push(snap)
        if (list.length > 40) list.splice(0, list.length - 40)
        history.set(coin.symbol, list)

        if (snap.askWallGone) {
          events.push({
            at: new Date(snap.at).toISOString(),
            symbol: coin.symbol,
            kind: 'ASK_WALL_GONE',
            detail: `ask wall removed (batch ${batches})`,
          })
        }
        if (snap.bidWallGone) {
          events.push({
            at: new Date(snap.at).toISOString(),
            symbol: coin.symbol,
            kind: 'BID_WALL_GONE',
            detail: `bid wall removed (batch ${batches})`,
          })
        }
      } catch (err) {
        log(`fail ${coin.symbol}: ${String(err).slice(0, 100)}`)
      }
    }

    analyzeImpulses(history, impulses, patterns, events)
    if (events.length > 2500) events.splice(0, events.length - 2000)
    if (impulses.length > 500) impulses.splice(0, impulses.length - 400)

    const elapsedMin = (Date.now() - started) / 60_000
    const scored = scorePatterns(patterns)
    const historySize = [...history.values()].reduce((s, a) => s + a.length, 0)
    const payload = {
      startedAt,
      updatedAt: new Date().toISOString(),
      elapsedMin,
      totalMin: TOTAL_MIN,
      batches,
      goal: 'Find regularities explaining meme pumps/dumps from book+tape precursors',
      impulses: impulses.slice(-200),
      patterns: scored,
      events: events.slice(-400),
      history: Object.fromEntries(
        [...history.entries()].map(([k, v]) => [k, v.slice(-8)])
      ),
    }
    writeFileSync(jsonPath, JSON.stringify(payload, null, 2))
    writeFileSync(
      mdPath,
      renderMd({
        startedAt,
        elapsedMin,
        totalMin: TOTAL_MIN,
        batches,
        impulses,
        patterns: scored,
        events,
        historySize,
      })
    )
    log(
      `snapshot impulses=${impulses.length} patterns=${scored.length} elapsed=${elapsedMin.toFixed(1)}m`
    )

    if ((Date.now() - started) / 60_000 >= TOTAL_MIN) break
    await sleep(PAUSE_BETWEEN_BATCH_MS)
  }

  log(`DONE → ${mdPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
