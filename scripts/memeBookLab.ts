/**
 * Local meme pump/dump lab — sample MEXC books + tape, find MM patterns.
 *
 *   npx tsx scripts/memeBookLab.ts
 *
 * Writes:
 *   workers/mexc-proxy/reports/meme-book-lab-<ts>.json
 *   workers/mexc-proxy/reports/meme-book-lab-<ts>.md
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  detectMmSignal,
  detectWashTrading,
  type MmBookSnap,
  type MmDeal,
  type MmSignal,
  type WashResult,
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

const ROUNDS = 8
const ROUND_MS = 3500
const TOP_N = 10
const MIN_VOL = 200_000
const MAX_VOL = 25_000_000
const MIN_ABS_CHG = 4

interface Ticker {
  symbol: string
  lastPrice?: number | string
  riseFallRate?: number | string
  amount24?: number | string
  volume24?: number | string
  holdVol?: number | string
  bid1?: number | string
  ask1?: number | string
}

interface WallHit {
  side: 'BID' | 'ASK'
  price: number
  notional: number
  multiple: number
}

interface CoinRound {
  at: number
  mid: number
  spreadBps: number
  bidDepth10: number
  askDepth10: number
  obi: number
  buyQuote45s: number
  sellQuote45s: number
  cvd: number
  dealCount: number
  topBidWall: WallHit | null
  topAskWall: WallHit | null
  wash: WashResult
  mm: MmSignal | null
  oiBlock: string | null
}

interface CoinReport {
  symbol: string
  displayName: string
  dayBias: 'PUMP' | 'DUMP'
  chg24hPct: number
  quoteVolUsd: number
  rounds: CoinRound[]
  findings: string[]
  patternHits: Record<string, number>
  spoofSuspects: string[]
  wallChurn: {
    askWallGone: number
    bidWallGone: number
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function mexcJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${MEXC}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'EnterpriseMemeLab/1.0' },
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

function depthNotional(levels: Array<[number, number]>, n = 10): number {
  return levels.slice(0, n).reduce((s, [p, v]) => s + p * v, 0)
}

function imbalance(bids: Array<[number, number]>, asks: Array<[number, number]>): number {
  const b = depthNotional(bids, 10)
  const a = depthNotional(asks, 10)
  const t = b + a
  if (!(t > 0)) return 0
  return ((b - a) / t) * 100
}

function parseLevels(
  raw: unknown,
  side: 'asks' | 'bids'
): Array<[number, number]> {
  if (!Array.isArray(raw)) return []
  const out: Array<[number, number]> = []
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2) continue
    const p = Number(row[0])
    const v = Number(row[1])
    if (p > 0 && v > 0) out.push([p, v])
  }
  // MEXC asks ascending, bids descending usually
  out.sort((a, b) => (side === 'asks' ? a[0] - b[0] : b[0] - a[0]))
  return out.slice(0, 20)
}

function topWall(
  levels: Array<[number, number]>,
  side: 'BID' | 'ASK',
  mid: number
): WallHit | null {
  if (!levels.length || !(mid > 0)) return null
  let best: WallHit | null = null
  const near = levels.filter(([p]) => Math.abs(p - mid) / mid < 0.012)
  const pool = near.length ? near : levels.slice(0, 8)
  const median =
    [...pool.map(([, v]) => v)].sort((a, b) => a - b)[Math.floor(pool.length / 2)] ||
    1
  for (const [p, v] of pool) {
    const notional = p * v
    const multiple = v / median
    if (!best || notional > best.notional) {
      best = { side, price: p, notional, multiple }
    }
  }
  if (!best || best.multiple < 2.5 || best.notional < 800) return null
  return best
}

function flowQuote(deals: MmDeal[], now: number, windowMs = 45_000) {
  let buy = 0
  let sell = 0
  let n = 0
  for (const d of deals) {
    const ts = Number(d.t ?? d.ts ?? 0)
    if (ts > 0 && now - ts > windowMs) continue
    const p = Number(d.p ?? 0)
    const v = Number(d.v ?? 0)
    if (!(p > 0 && v > 0)) continue
    n++
    const q = p * v
    if (d.T === 1) buy += q
    else if (d.T === 2) sell += q
  }
  return { buy, sell, cvd: buy - sell, n }
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

  const pumps = rows.filter((r) => r.dayBias === 'PUMP').slice(0, TOP_N / 2)
  const dumps = rows.filter((r) => r.dayBias === 'DUMP').slice(0, TOP_N / 2)
  const picked = [...pumps, ...dumps]
  // fill if one side thin
  if (picked.length < TOP_N) {
    for (const r of rows) {
      if (picked.some((p) => p.symbol === r.symbol)) continue
      picked.push(r)
      if (picked.length >= TOP_N) break
    }
  }
  return picked
}

async function sampleCoin(
  coin: ReturnType<typeof pickUniverse>[number]
): Promise<CoinReport> {
  const rounds: CoinRound[] = []
  let prevSnap: MmBookSnap | null = null
  const patternHits: Record<string, number> = {}
  const spoofSuspects: string[] = []
  let askWallGone = 0
  let bidWallGone = 0
  let prevAskWall: WallHit | null = null
  let prevBidWall: WallHit | null = null

  for (let i = 0; i < ROUNDS; i++) {
    const [depthJson, dealsJson] = await Promise.all([
      mexcJson<{
        data?: {
          asks?: unknown
          bids?: unknown
          timestamp?: number
        }
      }>(`/api/v1/contract/depth/${coin.symbol}?limit=20`),
      mexcJson<{ data?: MmDeal[] }>(
        `/api/v1/contract/deals/${coin.symbol}?limit=100`
      ),
    ])

    const asks = parseLevels(depthJson?.data?.asks, 'asks')
    const bids = parseLevels(depthJson?.data?.bids, 'bids')
    const deals = (dealsJson?.data ?? []) as MmDeal[]
    const mid =
      asks[0] && bids[0]
        ? (asks[0][0] + bids[0][0]) / 2
        : Number(bids[0]?.[0] ?? asks[0]?.[0] ?? 0)
    const now = Date.now()
    const snap: MmBookSnap = { at: now, mid, asks, bids }
    const spreadBps =
      asks[0] && bids[0]
        ? ((asks[0][0] - bids[0][0]) / mid) * 10_000
        : 999
    const flow = flowQuote(deals, now)
    const wash = detectWashTrading(
      deals,
      mid,
      bids[0]?.[0] ?? mid * 0.999,
      asks[0]?.[0] ?? mid * 1.001,
      now
    )
    const mmPack = prevSnap
      ? detectMmSignal({
          previous: prevSnap,
          current: snap,
          deals,
          chg24hPct: coin.chg24hPct,
          dayBias: coin.dayBias,
        })
      : null
    const mm = mmPack?.signal ?? null
    const oiBlock = mmPack?.oiBlock ?? null
    // Prefer dedicated wash from detector when available
    const washFinal = mmPack?.wash ?? wash

    const askWall = topWall(asks, 'ASK', mid)
    const bidWall = topWall(bids, 'BID', mid)

    if (prevAskWall && askWall) {
      const sameBand =
        Math.abs(prevAskWall.price - askWall.price) / mid < 0.0015
      if (!sameBand && prevAskWall.multiple >= 3) {
        askWallGone++
        spoofSuspects.push(
          `ASK wall $${(prevAskWall.notional / 1000).toFixed(1)}k @ ${prevAskWall.price} исчезла (r${i})`
        )
      }
    } else if (prevAskWall && !askWall && prevAskWall.multiple >= 3) {
      askWallGone++
      spoofSuspects.push(
        `ASK wall $${(prevAskWall.notional / 1000).toFixed(1)}k снята полностью (r${i})`
      )
    }
    if (prevBidWall && bidWall) {
      const sameBand =
        Math.abs(prevBidWall.price - bidWall.price) / mid < 0.0015
      if (!sameBand && prevBidWall.multiple >= 3) {
        bidWallGone++
        spoofSuspects.push(
          `BID wall $${(prevBidWall.notional / 1000).toFixed(1)}k исчезла (r${i})`
        )
      }
    } else if (prevBidWall && !bidWall && prevBidWall.multiple >= 3) {
      bidWallGone++
      spoofSuspects.push(
        `BID wall $${(prevBidWall.notional / 1000).toFixed(1)}k снята полностью (r${i})`
      )
    }

    if (mm?.ready) {
      patternHits[mm.pattern] = (patternHits[mm.pattern] ?? 0) + 1
    }

    rounds.push({
      at: now,
      mid,
      spreadBps: Number(spreadBps.toFixed(1)),
      bidDepth10: Math.round(depthNotional(bids, 10)),
      askDepth10: Math.round(depthNotional(asks, 10)),
      obi: Number(imbalance(bids, asks).toFixed(1)),
      buyQuote45s: Math.round(flow.buy),
      sellQuote45s: Math.round(flow.sell),
      cvd: Math.round(flow.cvd),
      dealCount: flow.n,
      topBidWall: bidWall,
      topAskWall: askWall,
      wash: washFinal,
      mm,
      oiBlock,
    })

    prevSnap = snap
    prevAskWall = askWall
    prevBidWall = bidWall
    if (i < ROUNDS - 1) await sleep(ROUND_MS)
  }

  const findings = synthesizeFindings(coin, rounds, {
    askWallGone,
    bidWallGone,
    spoofSuspects,
    patternHits,
  })

  return {
    symbol: coin.symbol,
    displayName: coin.displayName,
    dayBias: coin.dayBias,
    chg24hPct: Number(coin.chg24hPct.toFixed(2)),
    quoteVolUsd: coin.quoteVolUsd,
    rounds,
    findings,
    patternHits,
    spoofSuspects: [...new Set(spoofSuspects)].slice(0, 8),
    wallChurn: { askWallGone, bidWallGone },
  }
}

function synthesizeFindings(
  coin: { dayBias: string; chg24hPct: number; displayName: string },
  rounds: CoinRound[],
  meta: {
    askWallGone: number
    bidWallGone: number
    spoofSuspects: string[]
    patternHits: Record<string, number>
  }
): string[] {
  const findings: string[] = []
  if (!rounds.length) return ['нет данных']

  const first = rounds[0]!
  const last = rounds[rounds.length - 1]!
  const midMoveBps =
    ((last.mid - first.mid) / Math.max(first.mid, 1e-12)) * 10_000
  const avgObi =
    rounds.reduce((s, r) => s + r.obi, 0) / Math.max(rounds.length, 1)
  const avgSpread =
    rounds.reduce((s, r) => s + r.spreadBps, 0) / Math.max(rounds.length, 1)
  const washHits = rounds.filter((r) => r.wash.wash).length
  const buyTot = rounds.reduce((s, r) => s + r.buyQuote45s, 0)
  const sellTot = rounds.reduce((s, r) => s + r.sellQuote45s, 0)
  const thinBook =
    rounds.reduce((s, r) => s + r.bidDepth10 + r.askDepth10, 0) /
      rounds.length <
    25_000

  findings.push(
    `За окно ~${((ROUNDS * ROUND_MS) / 1000).toFixed(0)}с mid ${midMoveBps >= 0 ? '+' : ''}${midMoveBps.toFixed(0)} bps · avg OBI ${avgObi.toFixed(0)} · spread ${avgSpread.toFixed(0)} bps`
  )
  findings.push(
    `Агрессивный поток: buy $${(buyTot / 1000).toFixed(1)}k / sell $${(sellTot / 1000).toFixed(1)}k (сумма по раундам)`
  )

  if (coin.dayBias === 'PUMP' && sellTot > buyTot * 1.15 && midMoveBps > -15) {
    findings.push(
      '⚠ PUMP + доминирует sell-tape, цена держится → классическое поглощение / разгрузка MM в покупателя'
    )
  }
  if (coin.dayBias === 'DUMP' && buyTot > sellTot * 1.15 && midMoveBps < 15) {
    findings.push(
      '⚠ DUMP + доминирует buy-tape при слабом отскоке → шорт-покрытие / набор лонга в панике'
    )
  }
  if (meta.askWallGone >= 2) {
    findings.push(
      `Манипуляция: ASK-стены снимаются часто (${meta.askWallGone}×) — spoof resistance / магнит на лонгистов`
    )
  }
  if (meta.bidWallGone >= 2) {
    findings.push(
      `Манипуляция: BID-стены снимаются часто (${meta.bidWallGone}×) — ложный спрос, затем dump`
    )
  }
  if (washHits >= 2) {
    findings.push(
      `Wash/крутилка в ${washHits}/${rounds.length} раундах — объём не доверять`
    )
  }
  if (thinBook) {
    findings.push(
      'Тонкий стакан (<$25k top-10) — одна стена двигает цену, идеально для spoof-sweep'
    )
  }
  if (avgSpread > 40) {
    findings.push(
      `Широкий спред ${avgSpread.toFixed(0)} bps — maker-only / не догонять market`
    )
  }

  const ready = rounds.filter((r) => r.mm?.ready)
  for (const [pat, n] of Object.entries(meta.patternHits)) {
    findings.push(`Паттерн ${pat}: ${n} hit(s)`)
  }
  if (ready.length) {
    const best = ready.sort(
      (a, b) => (b.mm?.confidence ?? 0) - (a.mm?.confidence ?? 0)
    )[0]!
    findings.push(
      `Лучший live-сигнал: ${best.mm!.side} ${best.mm!.pattern} conf ${best.mm!.confidence} @ ${best.mm!.limitPrice}`
    )
  } else {
    findings.push('Готового MM-сигнала в окне не было — рынок «шум» или пауза кукловода')
  }

  return findings
}

function renderMarkdown(report: {
  at: string
  universeSize: number
  coins: CoinReport[]
  summary: string[]
}): string {
  const lines: string[] = []
  lines.push(`# Meme Book Lab · ${report.at}`)
  lines.push('')
  lines.push('Локальный прогон: топ pump/dump мемы → стакан + лента, поиск манипуляций.')
  lines.push('')
  lines.push('## Выводы')
  for (const s of report.summary) lines.push(`- ${s}`)
  lines.push('')
  for (const c of report.coins) {
    lines.push(`## ${c.displayName} · ${c.dayBias} ${c.chg24hPct >= 0 ? '+' : ''}${c.chg24hPct}% · vol $${(c.quoteVolUsd / 1e6).toFixed(2)}M`)
    lines.push('')
    for (const f of c.findings) lines.push(`- ${f}`)
    if (c.spoofSuspects.length) {
      lines.push('- Spoof suspects:')
      for (const s of c.spoofSuspects) lines.push(`  - ${s}`)
    }
    const last = c.rounds[c.rounds.length - 1]
    if (last) {
      lines.push(
        `- Last snap: OBI ${last.obi} · bidDepth $${(last.bidDepth10 / 1000).toFixed(1)}k · askDepth $${(last.askDepth10 / 1000).toFixed(1)}k · CVD ${last.cvd}`
      )
    }
    lines.push('')
  }
  lines.push('## Что это значит для бота')
  lines.push(
    '- Liquidation Echo на мемах редко срабатывает — кукловод работает стенами и tape, не liq-каскадами.'
  )
  lines.push(
    '- Рабочие edge: ABSORPTION / SPOOF_SWEEP / BID·ASK wall churn + wash-фильтр.'
  )
  lines.push(
    '- Вход только limit-chase (maker); широкий спред и wash → skip.'
  )
  lines.push('')
  return lines.join('\n')
}

async function main() {
  console.log('[meme-lab] fetching tickers…')
  const tickersJson = await mexcJson<{ data?: Ticker[] }>(
    '/api/v1/contract/ticker'
  )
  const tickers = tickersJson?.data ?? []
  if (!tickers.length) {
    console.error('No tickers from MEXC')
    process.exit(1)
  }

  const universe = pickUniverse(tickers)
  console.log(
    `[meme-lab] universe ${universe.length}:`,
    universe.map((u) => `${u.displayName} ${u.chg24hPct.toFixed(1)}%`).join(', ')
  )

  const coins: CoinReport[] = []
  for (const coin of universe) {
    console.log(`[meme-lab] sampling ${coin.displayName} (${ROUNDS}×${ROUND_MS}ms)…`)
    try {
      coins.push(await sampleCoin(coin))
    } catch (err) {
      console.error(`[meme-lab] ${coin.symbol} failed`, err)
    }
  }

  const washCoins = coins.filter((c) =>
    c.rounds.some((r) => r.wash.wash)
  ).length
  const spoofCoins = coins.filter(
    (c) => c.wallChurn.askWallGone + c.wallChurn.bidWallGone >= 2
  ).length
  const patternReady = coins.filter((c) =>
    Object.values(c.patternHits).some((n) => n > 0)
  )
  const pumpAbs = coins.filter((c) =>
    c.findings.some((f) => f.includes('поглощение'))
  ).length

  const summary = [
    `Просканировано ${coins.length} мемов (из ${tickers.length} тикеров), окно ~${((ROUNDS * ROUND_MS) / 1000).toFixed(0)}с × монета.`,
    `Wash/крутилка: ${washCoins}/${coins.length} монет.`,
    `Частый съём стен (spoof churn ≥2): ${spoofCoins}/${coins.length}.`,
    `MM-паттерны с ready: ${patternReady.length}/${coins.length} (${patternReady.map((c) => c.displayName).join(', ') || '—'}).`,
    `Подозрение на разгрузку в пампе (sell tape / price hold): ${pumpAbs}.`,
    'Рекомендация: вернуть meme-бот на order-flow (absorption/spoof/wall-release), а не ждать liquidation echo.',
  ]

  const at = new Date().toISOString()
  const payload = {
    at,
    rounds: ROUNDS,
    roundMs: ROUND_MS,
    universeSize: universe.length,
    summary,
    coins,
  }

  const outDir = join(
    process.cwd(),
    'workers',
    'mexc-proxy',
    'reports'
  )
  mkdirSync(outDir, { recursive: true })
  const stamp = at.replace(/[:.]/g, '-').slice(0, 19)
  const jsonPath = join(outDir, `meme-book-lab-${stamp}.json`)
  const mdPath = join(outDir, `meme-book-lab-${stamp}.md`)
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2))
  const md = renderMarkdown(payload)
  writeFileSync(mdPath, md)

  console.log('\n========== REPORT ==========\n')
  console.log(md)
  console.log(`\n[meme-lab] wrote ${jsonPath}`)
  console.log(`[meme-lab] wrote ${mdPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
