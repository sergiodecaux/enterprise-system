import type { WorkerMarketContext } from '../../api/marketContext'
import type { MarketBrief, TfNarrative } from '../brief/marketBrief'
import type { JournalAnalytics } from '../journal/types'
import type { Radar141Row } from '../radar141/types'
import type { StructureRead, TfStructure } from '../smc/structureRead'
import type { ActiveTrade, CoinSignal, MarketContext } from '../types'
import {
  buildChartContext,
  buildCompositeContext,
  buildFlowContext,
  buildSessionContext,
  buildSmcExtra,
  type AdvisorDeskInput,
} from './buildDeskContext'
import { clip, compact, num, px } from './format'
import type {
  AdvisorChartInput,
  AdvisorFocus,
  AdvisorJournal,
  AdvisorMarket,
  AdvisorRadarRow,
  AdvisorSnapshot,
  AdvisorSnapshotResult,
  AdvisorTfStructure,
  AdvisorTrade,
} from './types'

export interface AdvisorSnapshotInput {
  now: number
  /** Flat symbol (BTCUSDT) or internal (BTC/USDT:USDT) of the coin in focus */
  focusSymbol: string | null
  focusTradeId?: string | null
  signals: CoinSignal[]
  marketContext: MarketContext | null
  worker: WorkerMarketContext | null
  radarRows: Radar141Row[]
  activeTrades: ActiveTrade[]
  journal: JournalAnalytics | null
  structure: StructureRead | null
  brief: MarketBrief | null
  /** State of the open chart for the focus coin (LiveChart) */
  chart?: AdvisorChartInput | null
  /** Live order-flow / session state of the focus coin (tactical screen) */
  desk?: AdvisorDeskInput | null
  /** Token budget for the whole JSON (default 3000) */
  maxTokens?: number
}

const RADAR_ROWS = 8
const MAX_TRADES = 5

/** Rough token estimate: Latin/JSON ≈ 3.6 chars per token, Cyrillic ≈ 2.3. */
export function estimateTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 3.6 + other / 2.3)
}

function sameCoin(a: string, b: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT/g, '')
  return norm(a) === norm(b)
}

function buildMarket(input: AdvisorSnapshotInput): AdvisorMarket {
  const { marketContext: mc, worker, signals } = input
  const btc = signals.find((s) => s.symbol === 'BTCUSDT')
  return {
    fearGreed: worker?.fearGreed ?? null,
    fearGreedLabel: worker?.fearGreedLabel || undefined,
    btcTrend: btc?.coinTrend ?? mc?.btcTrend ?? null,
    btcPrice: px(btc?.price) ?? undefined,
    btc24h: num(btc?.priceChange24h) ?? undefined,
    btcDom: num(worker?.btcDominance),
    btcDomD24h: num(worker?.btcDomDelta24h, 2),
    total3D24h: num(worker?.total3Delta24h ?? worker?.totalMcapDelta24h),
    altRegime: worker?.altRegime ?? null,
    altBias: worker?.altBias ?? null,
    daily: mc
      ? {
          bias: mc.dailyBias,
          confidence: Math.round(mc.dailyConfidence),
          pattern: clip(mc.dailyPattern, 60),
        }
      : undefined,
    news: worker
      ? {
          label: worker.newsLabel,
          score: num(worker.newsScore) ?? 0,
          top: worker.newsHeadlines.slice(0, 2).map((h) => clip(h, 90) ?? ''),
        }
      : undefined,
  }
}

function tfStructure(tf: TfStructure | null): AdvisorTfStructure | undefined {
  if (!tf) return undefined
  const lo = px(tf.dealingLow)
  const hi = px(tf.dealingHigh)
  return {
    trend: tf.trend,
    bos: clip(tf.lastChoch?.label ?? tf.lastBos?.label, 40),
    bsl: px(tf.nextBsl),
    ssl: px(tf.nextSsl),
    range: lo != null && hi != null ? [lo, hi] : undefined,
    zone: tf.inPremium ? 'premium' : tf.inDiscount ? 'discount' : 'mid',
  }
}

function tfLine(n: TfNarrative): string {
  return `${n.look} ${n.bias} ${Math.round(n.strength)}`
}

function radarRow(r: Radar141Row): AdvisorRadarRow {
  return {
    s: r.symbol,
    px: px(r.price) ?? 0,
    trig: r.trigger,
    d141: num(r.dist141Pct),
    side: r.preferredSide,
    score: Math.round(r.opportunityScore),
    gap: num(r.gapPct) ?? 0,
    rs: r.rsLabel,
    liq: r.liquidityGrade,
    test: r.testKind,
    bias: r.htfBias,
    news: r.newsRisk || undefined,
  }
}

function buildFocus(input: AdvisorSnapshotInput): AdvisorFocus | undefined {
  const sym = input.focusSymbol
  if (!sym) return undefined
  const signal = input.signals.find((s) => s.symbol === sym || s.internalSymbol === sym)
  const row = input.radarRows.find((r) => r.symbol === sym || r.internalSymbol === sym)
  if (!signal && !row) return undefined

  const st = input.structure
  const brief = input.brief && sameCoin(input.brief.symbol, sym) ? input.brief : null
  const fib = st?.fib141 ?? null

  return {
    symbol: signal?.symbol ?? row?.symbol ?? sym,
    price: px(signal?.price ?? row?.price) ?? 0,
    ch24h: num(signal?.priceChange24h ?? row?.change24h) ?? 0,
    signal: signal
      ? {
          dir: signal.direction,
          prob: Math.round(signal.probabilityPct),
          score: num(signal.score) ?? 0,
          style: signal.tradeStyle ?? null,
          rsi: num(signal.currentRSI, 0),
          sl: px(signal.sl),
          tp1: px(signal.tp1),
          tp2: px(signal.tp2),
          trend: signal.coinTrend,
          zones: signal.zones.slice(0, 3).map((z) => clip(z, 50) ?? ''),
          grade: signal.scoreCard?.grade,
          ready: signal.scoreCard?.ready,
          missing: signal.scoreCard?.missingFactors.slice(0, 3),
        }
      : undefined,
    structure: st
      ? {
          bias: st.bias,
          confidence: Math.round(st.confidence),
          side: st.preferredSide,
          held: st.structureHeld,
          summary: clip(st.summary, 220) ?? '',
          factors: st.factors.slice(0, 4).map((f) => clip(f, 80) ?? ''),
          magnet: px(st.magnet?.price),
          invalidation: px(st.invalidation),
          fuel: px(st.fuel?.price),
          tf: {
            h1: tfStructure(st.h1),
            h4: tfStructure(st.h4),
            d1: tfStructure(st.d1),
            w1: tfStructure(st.w1),
          },
          intra: clip(st.intra?.line, 140),
          zones: clip(st.zones?.line, 140),
          scenario: clip(st.scenarios ? `${st.scenarios.leadTitle}: ${st.scenarios.now}` : null, 160),
          trap: clip(st.trap?.summary, 140),
        }
      : undefined,
    zone141: fib
      ? {
          state: fib.state,
          bias: fib.bias,
          top: px(fib.zoneTop) ?? 0,
          bottom: px(fib.zoneBottom) ?? 0,
          touches: fib.touches,
          stop: px(fib.stopPrice) ?? undefined,
          note: clip(fib.narrative, 140),
        }
      : undefined,
    brief: brief
      ? {
          now: clip(brief.nowHeadline, 120) ?? '',
          tf: {
            w: tfLine(brief.week),
            d: tfLine(brief.day),
            h4: tfLine(brief.h4),
            h1: tfLine(brief.h1),
          },
          plans: brief.styles
            .filter((p) => p.side !== 'WAIT')
            .slice(0, 3)
            .map((p) => ({
              style: p.style,
              side: p.side,
              prob: Math.round(p.probability),
              zone: [px(p.zoneFrom) ?? 0, px(p.zoneTo) ?? 0] as [number, number],
              target: px(p.target) ?? 0,
              invalidation: px(p.invalidation) ?? 0,
            })),
        }
      : undefined,
    radar: row ? radarRow(row) : undefined,
    chart: buildChartContext(input.chart ?? null, input.now),
    flow: input.desk ? buildFlowContext(input.desk, input.now) : undefined,
    smc: input.desk ? buildSmcExtra(signal, input.desk) : undefined,
    session: input.desk ? buildSessionContext(signal, input.desk) : undefined,
    composite: buildCompositeContext(input.desk?.composite ?? null),
  }
}

function buildTrades(input: AdvisorSnapshotInput): AdvisorTrade[] {
  const open = input.activeTrades.filter(
    (t) => t.status === 'ACTIVE' || t.status === 'BREAKEVEN' || t.status === 'PARTIAL_CLOSE'
  )
  const ordered = input.focusTradeId
    ? [...open].sort((a, b) => Number(b.id === input.focusTradeId) - Number(a.id === input.focusTradeId))
    : open
  return ordered.slice(0, MAX_TRADES).map((t) => {
    const last = t.events[t.events.length - 1]
    return {
      id: t.id,
      s: t.symbol,
      dir: t.direction,
      status: t.status,
      entry: px(t.entryPrice) ?? 0,
      px: px(t.currentPrice) ?? 0,
      sl: px(t.sl) ?? 0,
      tp1: px(t.tp1) ?? 0,
      tp2: px(t.tp2),
      pnl: num(t.pnlPercent, 2) ?? 0,
      conf: Math.round(t.confidenceScore),
      style: t.tradeStyle ?? null,
      inv: px(t.invalidationPrice),
      ageMin: Math.max(0, Math.round((input.now - t.entryTime) / 60_000)),
      last: last ? clip(`${last.type}: ${last.message}`, 100) : undefined,
    }
  })
}

function buildJournal(j: JournalAnalytics | null): AdvisorJournal | undefined {
  if (!j || j.total === 0) return undefined
  return {
    total: j.total,
    resolved: j.resolved,
    wr: num(j.winRate, 2) ?? 0,
    avgR: num(j.avgR, 2) ?? 0,
    expR: num(j.expectancyR, 2) ?? 0,
    pf: num(j.profitFactor, 2) ?? 0,
    setups: [...j.bySetup]
      .filter((s) => s.total - s.open >= 3)
      .sort((a, b) => b.total - a.total)
      .slice(0, 4)
      .map((s) => ({
        setup: s.setupType,
        n: s.total,
        wr: num(s.winRate, 2) ?? 0,
        avgR: num(s.avgR, 2) ?? 0,
      })),
    insights: j.insights.slice(0, 2).map((i) => clip(i.title, 90) ?? ''),
  }
}

type TrimStep = [label: string, apply: (s: AdvisorSnapshot) => void]

const TRIM_STEPS: TrimStep[] = [
  ['news.top', (s) => { if (s.market.news) delete s.market.news.top }],
  ['radar→5', (s) => { if (s.radar) s.radar.rows = s.radar.rows.slice(0, 5) }],
  ['chart.bars→12', (s) => { if (s.focus?.chart?.bars) s.focus.chart.bars = s.focus.chart.bars.slice(-12) }],
  ['desk.minor', (s) => {
    const f = s.focus
    if (!f) return
    delete f.composite
    if (f.smc) {
      delete f.smc.score
      delete f.smc.dataQuality
    }
    if (f.flow) delete f.flow.alerts
    if (f.chart?.consensus) delete f.chart.consensus.votes
  }],
  ['chart.setups→2', (s) => { if (s.focus?.chart?.setups) s.focus.chart.setups = s.focus.chart.setups.slice(0, 2) }],
  ['chart.bars', (s) => { if (s.focus?.chart) delete s.focus.chart.bars }],
  ['desk.detail', (s) => {
    const f = s.focus
    if (!f) return
    delete f.session
    if (f.smc) {
      delete f.smc.eqLevels
      delete f.smc.mm?.why
      delete f.smc.surgical?.confirms
    }
    if (f.chart?.forecast) f.chart.forecast.scenarios.forEach((sc) => delete sc.why)
    if (f.chart?.live) {
      delete f.chart.live.smc
      delete f.chart.live.alts
    }
  }],
  ['structure.factors', (s) => { if (s.focus?.structure) delete s.focus.structure.factors }],
  ['journal.insights', (s) => { if (s.journal) delete s.journal.insights }],
  ['trades→3', (s) => { if (s.trades) s.trades = s.trades.slice(0, 3) }],
  ['brief.plans', (s) => { if (s.focus?.brief) delete s.focus.brief.plans }],
  ['structure.text', (s) => {
    const st = s.focus?.structure
    if (!st) return
    delete st.intra
    delete st.zones
    delete st.trap
    st.summary = clip(st.summary, 120) ?? ''
  }],
  ['journal.setups', (s) => { if (s.journal) delete s.journal.setups }],
  ['structure.tf.h1', (s) => { if (s.focus?.structure?.tf) delete s.focus.structure.tf.h1 }],
  ['radar→3', (s) => { if (s.radar) s.radar.rows = s.radar.rows.slice(0, 3) }],
  ['brief', (s) => { if (s.focus) delete s.focus.brief }],
  ['desk', (s) => {
    if (!s.focus) return
    delete s.focus.flow
    delete s.focus.smc
  }],
  ['chart', (s) => { if (s.focus) delete s.focus.chart }],
]

export function buildAdvisorSnapshot(input: AdvisorSnapshotInput): AdvisorSnapshotResult {
  const budget = input.maxTokens ?? 3000
  const radarRows = [...input.radarRows]
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
    .slice(0, RADAR_ROWS)

  const lastScan = input.radarRows.reduce((m, r) => Math.max(m, r.updatedAt || 0), 0)

  const snapshot: AdvisorSnapshot = compact({
    t: new Date(input.now).toISOString().slice(0, 16) + 'Z',
    focusTradeId: input.focusTradeId ?? undefined,
    market: buildMarket(input),
    focus: buildFocus(input),
    radar: radarRows.length
      ? {
          scannedAt: lastScan ? new Date(lastScan).toISOString().slice(11, 16) + 'Z' : undefined,
          rows: radarRows.map(radarRow),
        }
      : undefined,
    trades: buildTrades(input),
    journal: buildJournal(input.journal),
  })

  const trimmed: string[] = []
  let json = JSON.stringify(snapshot)
  for (const [label, apply] of TRIM_STEPS) {
    if (estimateTokens(json) <= budget) break
    apply(snapshot)
    trimmed.push(label)
    json = JSON.stringify(compact(snapshot))
  }

  return {
    snapshot: compact(snapshot),
    json,
    chars: json.length,
    approxTokens: estimateTokens(json),
    trimmed,
  }
}
