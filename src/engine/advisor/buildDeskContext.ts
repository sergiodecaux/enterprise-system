import type { EnhancedCvdSnapshot } from '../orderflow/enhancedCvd'
import type { CompositeAnalysis } from '../composite'
import type {
  BuyerAggressionResult,
  CoinSignal,
  IcebergAlertSnapshot,
  LiquidityMap,
  MmIntentSnapshot,
  ObDeltaStoreSnapshot,
  OrderBookMetrics,
  PO3Analysis,
  SessionDNA,
  SpoofAlertSnapshot,
  SurgicalEntrySnapshot,
  TapeMomentumState,
  WhaleOrder,
  WhaleWatcherState,
} from '../types'
import { clip, num, px, texts } from './format'
import type {
  AdvisorBar,
  AdvisorChart,
  AdvisorChartInput,
  AdvisorComposite,
  AdvisorFlow,
  AdvisorSession,
  AdvisorSetup,
  AdvisorSmcExtra,
} from './types'

const CHART_BARS = 24
/** Chart state older than this is from a previous visit and is not sent */
const CHART_MAX_AGE_MS = 15 * 60_000

/** Per-coin live state the tactical screen shows (all keyed by internal symbol in the app store). */
export interface AdvisorDeskInput {
  book: OrderBookMetrics | null
  obDelta: ObDeltaStoreSnapshot | null
  spoofs: SpoofAlertSnapshot[]
  icebergs: IcebergAlertSnapshot[]
  cvd: EnhancedCvdSnapshot | null
  tape: TapeMomentumState | null
  aggression: BuyerAggressionResult | null
  whales: WhaleWatcherState | null
  liquidityMap: LiquidityMap | null
  dna: SessionDNA | null
  po3: PO3Analysis | null
  mmIntent: MmIntentSnapshot | null
  surgical: SurgicalEntrySnapshot | null
  composite: CompositeAnalysis | null
}

function pct(from: number, to: number): number | null {
  return from > 0 ? num(((to - from) / from) * 100, 2) : null
}

function levelNote(price: number | null | undefined, label: string | null | undefined): string | undefined {
  const p = px(price)
  if (p == null && !label) return undefined
  return clip([label, p != null ? `@${p}` : ''].filter(Boolean).join(' '), 70)
}

function buildBars(input: AdvisorChartInput): Pick<AdvisorChart, 'stats' | 'bars'> {
  const all = input.candles
  if (all.length < 5) return {}
  const tail = all.slice(-CHART_BARS)
  const volWindow = all.slice(-20)
  const avgVol = volWindow.reduce((s, c) => s + c[5], 0) / volWindow.length
  const bars: AdvisorBar[] = tail.map((c) => [
    px(c[2]) ?? 0,
    px(c[3]) ?? 0,
    px(c[4]) ?? 0,
    avgVol > 0 ? (num(c[5] / avgVol, 1) ?? 0) : 0,
  ])

  const atrWindow = all.slice(-15)
  let trSum = 0
  for (let i = 1; i < atrWindow.length; i++) {
    const [, , h, l] = atrWindow[i]
    const prevClose = atrWindow[i - 1][4]
    trSum += Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose))
  }
  const last = tail[tail.length - 1]
  const atr = atrWindow.length > 1 ? trSum / (atrWindow.length - 1) : 0
  return {
    bars,
    stats: {
      bars: tail.length,
      chgPct: pct(tail[0][1], last[4]),
      hi: px(Math.max(...tail.map((c) => c[2]))),
      lo: px(Math.min(...tail.map((c) => c[3]))),
      atrPct: last[4] > 0 ? num((atr / last[4]) * 100, 2) : null,
      volX: avgVol > 0 ? num(last[5] / avgVol, 1) : null,
    },
  }
}

function setupRow(s: AdvisorChartInput['setups'][number]): AdvisorSetup {
  const l = s.targetsLadder
  return {
    side: s.side,
    title: clip(s.title, 60) ?? s.kind,
    prob: Math.round(s.probability),
    status: s.status,
    zone: [px(s.entryZone.bottom) ?? 0, px(s.entryZone.top) ?? 0],
    entry: px(s.limitEntry),
    target: px(s.target),
    inv: px(s.invalidation),
    ladder: l ? [px(l.r1) ?? 0, px(l.r2) ?? 0, px(l.r3) ?? 0] : undefined,
    pReach: l ? [Math.round(l.pReach1), Math.round(l.pReach2), Math.round(l.pReach3)] : undefined,
    trigger: clip(s.triggerSummary, 100),
    pending: s.preconditions
      .filter((p) => p.status !== 'MET')
      .slice(0, 3)
      .map((p) => clip(`${p.status === 'FAILED' ? '✗' : '…'} ${p.label}`, 60) ?? ''),
  }
}

export function buildChartContext(
  input: AdvisorChartInput | null,
  now: number
): AdvisorChart | undefined {
  if (!input || now - input.updatedAt > CHART_MAX_AGE_MS) return undefined
  const f = input.forecast
  const a = f?.mtfAlignment
  const tfNote = (s: NonNullable<typeof a>['daily']) =>
    `${s.bias} ${s.direction} rsi${Math.round(s.rsi)}${s.aboveEma200 ? ' >ema200' : ' <ema200'}`
  const live = input.liveSignal
  const lm = live?.liveMarket
  const liq = input.liq

  return {
    tf: input.timeframe,
    horizon: input.horizon,
    ageSec: Math.max(0, Math.round((now - input.updatedAt) / 1000)),
    ...buildBars(input),
    mtf: a
      ? {
          d: tfNote(a.daily),
          h4: tfNote(a.h4),
          h1: tfNote(a.h1),
          strength: `${a.strength} ${Math.round(a.score)}${a.agreement ? ' agree' : ''}`,
          target: levelNote(a.primaryLiqTarget?.price, a.primaryLiqTarget?.label),
        }
      : undefined,
    forecast: f?.scenarios.length
      ? {
          dominant: f.dominantScenario,
          macro: clip(f.macroSummary, 140),
          scenarios: f.scenarios.map((s) => ({
            id: s.id,
            type: s.type,
            prob: Math.round(s.probability),
            entry: px(s.entry),
            target: px(s.target),
            inv: px(s.invalidation),
            rr: num(s.riskReward, 1),
            trigger: clip(s.triggerCondition, 90),
            why: texts(s.reasoning, 2, 80),
          })),
        }
      : undefined,
    consensus: input.consensus
      ? {
          bias: input.consensus.bias,
          conf: Math.round(input.consensus.confidence),
          summary: clip(input.consensus.summary, 120),
          votes: [...input.consensus.votes]
            .sort((x, y) => y.weight - x.weight)
            .slice(0, 6)
            .map((v) => clip(`${v.label} ${v.side} ×${num(v.weight, 1)}: ${v.reason}`, 90) ?? ''),
        }
      : undefined,
    live: live
      ? {
          phase: clip(live.phaseLabel, 90) ?? live.phase,
          primary: clip(`${live.primary.side} ${live.primary.title} ~${Math.round(live.primary.winPct)}%`, 90) ?? '',
          summary: clip(live.primary.summary, 160),
          inv: clip(live.primary.invalidation, 90),
          alts: live.scenarios
            .filter((s) => s.id !== live.primary.id)
            .slice(0, 3)
            .map((s) => clip(`${s.side} ${s.title} ~${Math.round(s.winPct)}%`, 80) ?? ''),
          drive: clip(live.driveNarrative, 140),
          smc: texts(live.smcLines, 3, 90),
          now: clip(lm ? `${lm.whatNow} ${lm.reactionNote}` : null, 180),
        }
      : undefined,
    view: input.globalView
      ? {
          bias: input.globalView.bias,
          summary: clip(input.globalView.summary, 140),
          magnet: levelNote(input.magnet?.price, input.magnet?.label),
        }
      : undefined,
    setups: input.setups.slice(0, 4).map(setupRow),
    liq: liq
      ? {
          label: clip(liq.label, 100),
          longLiqBelow: px(liq.nearestLongLiq),
          shortLiqAbove: px(liq.nearestShortLiq),
          longClusters: liq.longClusters.slice(0, 2).map((c) => px(c.price) ?? 0),
          shortClusters: liq.shortClusters.slice(0, 2).map((c) => px(c.price) ?? 0),
          tapeBuy: num(liq.buyTape, 0),
          tapeSell: num(liq.sellTape, 0),
        }
      : undefined,
    macro: clip(input.macro?.summary, 160),
  }
}

function whaleNote(o: WhaleOrder | null): string | undefined {
  if (!o) return undefined
  return `${px(o.price)} $${Math.round(o.volumeUsd / 1000)}k ${num(o.distancePct, 1)}%`
}

export function buildFlowContext(d: AdvisorDeskInput, now: number): AdvisorFlow {
  const fresh = <T extends { updatedAt: number }>(x: T) => now - x.updatedAt < 10 * 60_000
  const b = d.book
  return {
    book: b
      ? {
          obi: num(b.imbalance, 0),
          pressure: b.pressure,
          spreadPct: num(b.spreadPercent, 3),
          walls: [...b.walls]
            .sort((x, y) => y.ratio - x.ratio)
            .slice(0, 3)
            .map((w) => `${w.side} ${px(w.price)} ×${num(w.ratio, 1)}`),
          shift: d.obDelta?.volumeShift !== 'NEUTRAL' ? d.obDelta?.volumeShift : undefined,
        }
      : undefined,
    cvd: d.cvd
      ? {
          src: d.cvd.source,
          trend: d.cvd.trend,
          buyPct: Math.round(d.cvd.aggression),
          div: d.cvd.divergence ? d.cvd.divergenceType : undefined,
        }
      : undefined,
    tape:
      d.tape && d.tape.signal !== 'NEUTRAL'
        ? {
            signal: d.tape.signal,
            pressure: d.tape.pressure,
            burst: d.tape.isBurst,
            ticks: d.tape.consecutiveTicks,
          }
        : undefined,
    aggression: d.aggression?.detected
      ? {
          label: clip(d.aggression.label, 60) ?? '',
          ratio: num(d.aggression.buyToSellRatio, 2) ?? 0,
          largeBuys: d.aggression.largeBuyCount,
        }
      : undefined,
    whales: d.whales
      ? {
          support: whaleNote(d.whales.strongestSupport),
          resistance: whaleNote(d.whales.strongestResistance),
          alerts: texts(
            d.whales.alerts.filter((x) => x.isActive && !x.isExpired).map((x) => x.message),
            2,
            80
          ),
        }
      : undefined,
    alerts: texts(
      [
        ...d.spoofs.filter((s) => s.detected && fresh(s)).map((s) => `spoof ${s.side} ${px(s.price)} ${s.label}`),
        ...d.icebergs
          .filter((s) => s.detected && fresh(s))
          .map((s) => `iceberg ${s.side} ${px(s.price)} bounce ${Math.round(s.bounceProbPct)}%`),
      ],
      3,
      80
    ),
  }
}

function eqLevel(l: LiquidityMap['equalHighs'][number]): string {
  return `${l.type === 'HIGH' ? 'BSL' : 'SSL'} ${px(l.price)} ×${l.touches} ${num(l.distancePct, 1)}%${l.isActive ? '' : ' taken'}`
}

export function buildSmcExtra(signal: CoinSignal | undefined, d: AdvisorDeskInput): AdvisorSmcExtra {
  const mm = signal?.mmIntent ?? d.mmIntent
  const sur = signal?.surgicalEntry ?? d.surgical
  const card = signal?.scoreCard
  const htf = signal?.htfTrend
  const gf = signal?.globalFib
  const vp = signal?.volumeProfile
  const lc = signal?.liquidationContext
  const lm = d.liquidityMap

  const ltf = texts(
    [
      signal?.mss?.detected ? `MSS ${signal.mss.timeframe}: ${signal.mss.label}` : null,
      signal?.raid && signal.raid.type !== 'NONE'
        ? `${signal.raid.label}${signal.raid.isFresh ? ' (свежий)' : ''}`
        : null,
      signal?.ote?.isActive
        ? `OTE ${signal.ote.direction ?? ''} ${px(signal.ote.zoneBottom)}–${px(signal.ote.zoneTop)}${signal.ote.priceInZone ? ' цена в зоне' : ''}`
        : null,
      signal?.absorption?.detected ? signal.absorption.label : null,
      signal?.ltfChoCH?.detected ? signal.ltfChoCH.label : null,
      signal?.cvdDivergence?.detected ? `CVD div: ${signal.cvdDivergence.label}` : null,
    ],
    6,
    90
  )

  return {
    mm: mm
      ? {
          drive: mm.drive,
          conf: Math.round(mm.confidence),
          side: mm.preferredSide,
          micro: levelNote(mm.hunt.microTarget, mm.hunt.microLabel),
          macro: levelNote(mm.hunt.macroTarget, mm.hunt.macroLabel),
          stopHunt: mm.hunt.microIsStopHunt || undefined,
          why: texts(mm.reasons, 3, 80),
        }
      : undefined,
    surgical:
      sur && sur.status !== 'IDLE'
        ? {
            status: sur.status,
            side: sur.side,
            limit: px(sur.limitEntry),
            zone:
              sur.zoneBottom != null && sur.zoneTop != null
                ? [px(sur.zoneBottom) ?? 0, px(sur.zoneTop) ?? 0]
                : undefined,
            inv: px(sur.invalidation),
            reason: clip(sur.reason, 120),
            confirms: texts(sur.confirmations, 4, 40),
          }
        : undefined,
    ltf,
    eqLevels: lm
      ? [...lm.equalHighs.slice(0, 3), ...lm.equalLows.slice(0, 3)].map(eqLevel)
      : undefined,
    btcDiv:
      signal?.btcDivergence && signal.btcDivergence.type !== 'NONE'
        ? clip(
            `${signal.btcDivergence.type} RS ${num(signal.btcDivergence.relativeStrength, 2)}% за ${signal.btcDivergence.lookbackCandles}ч: ${signal.btcDivergence.label}`,
            130
          )
        : undefined,
    htf: htf
      ? clip(
          `${htf.bias} ${htf.label} ${Math.round(htf.strength)} (1h ${htf.bias1h} ${Math.round(htf.strength1h)}, 4h ${htf.bias4h} ${Math.round(htf.strength4h)}) откат ~${num(htf.avgPullbackPct, 1)}%`,
          140
        )
      : undefined,
    regime: [
      signal?.marketRegime,
      signal?.sessionQuality
        ? `сессия ${signal.sessionQuality.session} ${Math.round(signal.sessionQuality.score)}${signal.sessionQuality.avoid ? ' избегать' : ''}`
        : null,
      signal?.tradeStyle ? `стиль ${signal.tradeStyle}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || undefined,
    vp: vp
      ? { poc: px(vp.poc), vah: px(vp.vah), val: px(vp.val), note: clip(vp.confluenceLabel, 70) }
      : undefined,
    liqGate: lc
      ? clip(
          `${lc.label}${lc.gateOpen ? ' · gate open' : ' · gate closed'}${lc.blockingPrice ? ` блок ${px(lc.blockingPrice)}` : ''}`,
          120
        )
      : undefined,
    globalFib: gf
      ? clip(
          `импульс ${gf.impulse} ${px(gf.swingLow)}–${px(gf.swingHigh)} · ${gf.activeLabel ?? '—'}${gf.in141 ? ' · в зоне 141' : gf.near141 ? ' · у зоны 141' : ''}${gf.price141 ? ` @${px(gf.price141)}` : ''}${gf.mode ? ` (${gf.mode})` : ''}`,
          140
        )
      : undefined,
    score: card
      ? Object.entries(card.factors).map(
          ([k, f]) => clip(`${k} ${f.score}/${f.max}${f.passed ? '✓' : '✗'} ${f.reason}`, 80) ?? k
        )
      : undefined,
    dataQuality: card?.dataQuality
      ? clip(
          `${card.dataQuality.overall} (cvd ${card.dataQuality.cvdSource}) ${[...card.dataQuality.penalties, ...card.dataQuality.warnings].slice(0, 2).join('; ')}`,
          140
        )
      : undefined,
    invalidation: signal?.invalidationPrice
      ? clip(`${px(signal.invalidationPrice)} ${signal.invalidationMessage ?? ''}`, 110)
      : undefined,
    warnings: texts(
      [signal?.ghostPathWarning, signal?.unrealisticTp ? 'TP нереалистичен по ATR' : null],
      2,
      100
    ),
  }
}

export function buildSessionContext(signal: CoinSignal | undefined, d: AdvisorDeskInput): AdvisorSession {
  const po3 = d.po3
  const box = po3?.asiaBox
  return {
    dna: d.dna
      ? clip(`${d.dna.personalityLabel} · ${d.dna.keyInsight}${d.dna.dominantSession ? ` · сильнейшая ${d.dna.dominantSession}` : ''}`, 160)
      : undefined,
    po3: po3
      ? clip(
          `${po3.currentPhase} ${po3.phaseLabel}${po3.manipulationDetected ? ` · манипуляция ${po3.manipulationDirection}` : ''}${box ? ` · Азия ${px(box.low)}–${px(box.high)}` : ''} · ${po3.tradingAdvice}`,
          200
        )
      : undefined,
    flip: clip(signal?.sessionFlipReason, 120),
  }
}

export function buildCompositeContext(c: CompositeAnalysis | null): AdvisorComposite | undefined {
  if (!c) return undefined
  return {
    score: Math.round(c.overallScore),
    phase: c.marketPhase,
    force: c.dominantForce,
    vol: c.volatilityLevel,
    advice: clip(c.tacticalAdvice.primary, 140),
    warnings: texts(c.tacticalAdvice.warnings, 2, 90),
  }
}
