import {
  analyzeConfluence,
  detectAbsorption,
  detectLiquidityRaid,
} from '../confluence'
import {
  buildHtfLiquidityMap,
  findSmartZone,
} from '../liquidityZones'
import { detectMarketRegime } from '../regime'
import type { ScanAlert, TradePlanPayload } from '../scanner'
import { btcShieldAllows, loadBtcShield } from './btcShield'
import { findInternalZone } from './internalLiquidity'
import { fetchKlinesCached } from './htfCache'
import { atr, tfBias, type VaneTicker } from './mexc'
import { pickVaneBatch } from './roundRobin'
import {
  canOpenVanePosition,
  loadVaneRisk,
  registerVaneOpen,
  saveVaneRisk,
  vaneTradingPaused,
} from './portfolioRisk'
import {
  computeHtfTrendLite,
  computeVaneDirection,
  directionAligns,
  directionConflicts,
  rankZoneCandidate,
} from './richContext'
import { buildVaneRisk, riskPctForTier } from './riskMath'
import { buildVaneScoreCard, vaneRegimePolicy } from './scoreCard'
import { evaluateVaneSession } from './sessionFilter'
import {
  advanceVanePhase,
  flipSide,
  loadVaneState,
  saveVaneState,
} from './srFlip'
import { loadVaneUniverse } from './universe'
import { volSpikePause } from './volSpike'
import { assessZoneStrength } from './zoneStrength'
import {
  MIN_VANE_SCORE,
  TIER1_SCORE,
  WALL_PERSIST_MS,
  type Side,
  type VaneDecision,
  type VaneKv,
  type VanePath,
  type VaneZoneGeom,
} from './types'

function phaseOfGeom(
  price: number,
  low: number,
  high: number
): 'FAR' | 'APPROACH' | 'TOUCH' {
  if (price >= low * 0.997 && price <= high * 1.003) return 'TOUCH'
  const mid = (low + high) / 2
  const dist = Math.abs(price - mid) / price
  // Wider approach so we don't miss zones between cron ticks
  if (dist <= 0.02) return 'APPROACH'
  return 'FAR'
}

function smartToGeom(
  smart: NonNullable<ReturnType<typeof findSmartZone>>
): VaneZoneGeom {
  return {
    zoneLow: smart.zoneLow,
    zoneHigh: smart.zoneHigh,
    mid: smart.mid,
    limitEntry: smart.limitEntry,
    source: smart.source === 'SSL' || smart.source === 'BSL' ? smart.source : 'SSL',
    tf: smart.tf === '1H' ? '4H' : smart.tf,
    strength: smart.strength,
    touches: smart.touches,
  }
}

function decisionToAlert(d: VaneDecision): ScanAlert {
  const plan: TradePlanPayload = {
    side: d.side,
    symbol: d.symbol,
    setup: d.setup,
    signalPrice: d.entry,
    entryIdeal: d.entry,
    zoneLow: d.zone.zoneLow,
    zoneHigh: d.zone.zoneHigh,
    invalidate: d.invalidate,
    sl: d.sl,
    tp: d.tp,
    zoneSource:
      d.zone.source === 'SSL' || d.zone.source === 'BSL'
        ? d.zone.source
        : 'SWING',
    zoneStrength: d.zone.strength,
    zoneTouches: d.zone.touches,
    zonePhase: phaseOfGeom(d.entry, d.zone.zoneLow, d.zone.zoneHigh),
    targetLabel: `Vane TP ${((Math.abs(d.tp - d.entry) / d.entry) * 100).toFixed(2)}%`,
    vanePath: d.path,
    vaneTier: d.tier,
    vaneScore: d.score,
  }
  return {
    type: 'SNIPER',
    title: d.title,
    text: d.text,
    dedupeKey: d.dedupeKey,
    score: d.score,
    winPct: d.winPct,
    style: d.path === 'FLIP' ? 'INTRADAY' : 'SCALP',
    align: 'WITH_TREND',
    tradePlan: plan,
    needsPullbackWatch: false,
    watchOnly: false,
  }
}

async function analyzeSymbol(opts: {
  ticker: VaneTicker
  kv?: VaneKv
  btc: Awaited<ReturnType<typeof loadBtcShield>>
  sessionOk: boolean
  sessionReason?: string
}): Promise<VaneDecision | null> {
  const symbol = opts.ticker.symbol
  const price = Number(opts.ticker.lastPrice)
  if (!(price > 0)) return null

  if (!opts.sessionOk) return null

  // LTF live; HTF from KV cache to cut subrequests
  const [c1m, c5m, c15m, c1h, c4h, c1d] = await Promise.all([
    fetchKlinesCached(opts.kv, symbol, 'Min1', 120),
    fetchKlinesCached(opts.kv, symbol, 'Min5', 48),
    fetchKlinesCached(opts.kv, symbol, 'Min15', 64),
    fetchKlinesCached(opts.kv, symbol, 'Min60', 48),
    fetchKlinesCached(opts.kv, symbol, 'Hour4', 90),
    fetchKlinesCached(opts.kv, symbol, 'Day1', 60),
  ])
  if (c4h.length < 30 || c1m.length < 30) return null

  const spike = volSpikePause(c1m)
  if (spike.pause) return null

  const regime = detectMarketRegime(c1h)
  const bias4h = tfBias(c4h)
  const bias1d = tfBias(c1d)
  const atr15 = atr(c15m, 14) || price * 0.008
  const htf = computeHtfTrendLite(c1h, c4h)
  const map = buildHtfLiquidityMap({
    candles4h: c4h,
    candles1d: c1d,
    candles1h: c1h,
    price,
  })

  // Candidate sides: prefer SSL long / BSL short near price
  const candidates: Array<{
    side: Side
    zone: VaneZoneGeom
    pathHint: VanePath
    isInternal: boolean
    oppositeLiq: number | null
  }> = []

  for (const side of ['LONG', 'SHORT'] as Side[]) {
    const smart = findSmartZone(side, price, map, atr15, {
      // TOP-5 majors: same relaxed distance/touches as blue chips
      relaxed: true,
    })
    if (!smart) continue
    const ph = smart.phase
    // Include FAR within ~3.5% so we arm early like mini-app zone list
    const inRadar =
      ph === 'TOUCH' ||
      ph === 'APPROACH' ||
      (ph === 'FAR' && smart.distancePct <= 3.5 && smart.strength >= 5)
    if (inRadar) {
      candidates.push({
        side,
        zone: smartToGeom(smart),
        pathHint: 'HOLD',
        isInternal: false,
        oppositeLiq: smart.target,
      })
    }
  }

  // Tier-2 internals along 4H trend
  for (const side of ['LONG', 'SHORT'] as Side[]) {
    const iz = findInternalZone({
      side,
      price,
      candles15m: c15m,
      bias4h,
    })
    if (iz) {
      const ph = phaseOfGeom(price, iz.zoneLow, iz.zoneHigh)
      if (ph === 'TOUCH' || ph === 'APPROACH') {
        candidates.push({
          side,
          zone: iz,
          pathHint: 'HOLD',
          isInternal: true,
          oppositeLiq: null,
        })
      }
    }
  }

  if (!candidates.length) {
    // Still advance flip state if we have prior armed break
    const prev = await loadVaneState(opts.kv, symbol)
    if (prev && (prev.phase === 'RETEST_WAIT' || prev.phase === 'BREAK_ARMED' || prev.phase === 'WEAK_BREAK')) {
      candidates.push({
        side: prev.originSide,
        zone: prev.zone,
        pathHint: 'FLIP',
        isInternal: prev.zone.tf === '15m',
        oppositeLiq: null,
      })
    } else {
      return null
    }
  }

  // Skip expensive depth/deals unless near zone or flip armed
  const nearOrFlip = candidates.some((c) => {
    const ph = phaseOfGeom(price, c.zone.zoneLow, c.zone.zoneHigh)
    return ph === 'TOUCH' || ph === 'APPROACH' || c.pathHint === 'FLIP'
  })
  if (!nearOrFlip) return null

  // Pre-rank by structure (before book) — prefer strong aligned zones, not only nearest
  const nearestLongDist =
    candidates
      .filter((c) => c.side === 'LONG')
      .map((c) => (Math.abs(c.zone.mid - price) / price) * 100)
      .sort((a, b) => a - b)[0] ?? null
  const nearestShortDist =
    candidates
      .filter((c) => c.side === 'SHORT')
      .map((c) => (Math.abs(c.zone.mid - price) / price) * 100)
      .sort((a, b) => a - b)[0] ?? null

  // Tentative direction without book (updated after assess)
  let direction = computeVaneDirection({
    htf,
    bias4h,
    bias1d,
    regime,
    bookGrade: 'NEUTRAL',
    bookSide: candidates[0]!.side,
    nearestLongDist,
    nearestShortDist,
  })

  candidates.sort((a, b) => {
    const ra = rankZoneCandidate({
      side: a.side,
      zone: a.zone,
      price,
      isInternal: a.isInternal,
      oppositeLiq: a.oppositeLiq,
      direction,
      bookGrade: 'NEUTRAL',
      phase: phaseOfGeom(price, a.zone.zoneLow, a.zone.zoneHigh),
    }).score
    const rb = rankZoneCandidate({
      side: b.side,
      zone: b.zone,
      price,
      isInternal: b.isInternal,
      oppositeLiq: b.oppositeLiq,
      direction,
      bookGrade: 'NEUTRAL',
      phase: phaseOfGeom(price, b.zone.zoneLow, b.zone.zoneHigh),
    }).score
    if (rb !== ra) return rb - ra
    return Math.abs(a.zone.mid - price) - Math.abs(b.zone.mid - price)
  })
  const pick = candidates[0]!
  const originSide = pick.side
  const zone = pick.zone
  const phaseGeom = phaseOfGeom(price, zone.zoneLow, zone.zoneHigh)

  const book = await assessZoneStrength({
    symbol,
    side: originSide,
    mid: zone.mid,
    candles1m: c1m,
    kv: opts.kv,
  })

  direction = computeVaneDirection({
    htf,
    bias4h,
    bias1d,
    regime,
    bookGrade: book.grade,
    bookSide: originSide,
    nearestLongDist,
    nearestShortDist,
  })

  const zoneRank = rankZoneCandidate({
    side: originSide,
    zone,
    price,
    isInternal: pick.isInternal,
    oppositeLiq: pick.oppositeLiq,
    direction,
    bookGrade: book.grade,
    phase: phaseGeom,
  })

  const conf = analyzeConfluence({
    side: originSide,
    price,
    candles4h: c4h,
    candles1m: c1m,
  })
  const raid = detectLiquidityRaid(c5m.length ? c5m : c1m, originSide)
  const absorption = detectAbsorption(c1m)
  const sweepReclaim =
    raid.detected &&
    ((originSide === 'LONG' && raid.type === 'BULL_SWEEP') ||
      (originSide === 'SHORT' && raid.type === 'BEAR_SWEEP')) &&
    phaseGeom === 'TOUCH'

  const prev = await loadVaneState(opts.kv, symbol)
  const { state, emitPath } = advanceVanePhase({
    prev,
    symbol,
    originSide,
    zone,
    grade: book.grade,
    phaseGeom,
    candles5m: c5m,
    price,
    score: 0,
    tier: null,
  })

  const aligns = directionAligns(direction.bias, originSide)
  const conflicts = directionConflicts(direction.bias, originSide)

  // Determine actionable path
  let path: VanePath | null = emitPath
  // HOLD: TOUCH with STRONG, or APPROACH with STRONG+tape (don't require perfect touch)
  if (
    !path &&
    book.grade === 'STRONG' &&
    (phaseGeom === 'TOUCH' ||
      (phaseGeom === 'APPROACH' && (book.absorption || book.cvdConfirm)))
  ) {
    path = 'HOLD'
  }
  // Soft HOLD: TOUCH + NEUTRAL book but clear absorption/CVD (weekend/thin books)
  if (
    !path &&
    phaseGeom === 'TOUCH' &&
    book.grade === 'NEUTRAL' &&
    (book.absorption || book.cvdConfirm) &&
    !book.greenDeltaWeak
  ) {
    path = 'HOLD'
  }
  // Bounce HOLD: price in zone with multi-touch HTF level
  if (
    !path &&
    phaseGeom === 'TOUCH' &&
    book.grade !== 'WEAK' &&
    zone.touches >= 2 &&
    !book.greenDeltaWeak
  ) {
    path = 'HOLD'
  }
  // Rich HOLD (mini-app parity): TOUCH + direction with zone + structural strength
  if (
    !path &&
    phaseGeom === 'TOUCH' &&
    book.grade !== 'WEAK' &&
    aligns &&
    zone.strength >= 5 &&
    !book.greenDeltaWeak
  ) {
    path = 'HOLD'
  }
  // Rich APPROACH: strong structure + direction + some tape
  if (
    !path &&
    phaseGeom === 'APPROACH' &&
    aligns &&
    zone.strength >= 6 &&
    !conflicts &&
    (book.grade === 'STRONG' ||
      book.absorption ||
      book.cvdConfirm ||
      (zone.touches >= 3 && book.grade !== 'WEAK'))
  ) {
    path = 'HOLD'
  }
  // Rank prefers FLIP and book WEAK — let FSM handle; if still no path but prefer FLIP
  if (
    !path &&
    zoneRank.preferPath === 'FLIP' &&
    book.grade === 'WEAK' &&
    phaseGeom === 'TOUCH'
  ) {
    // Stay silent until break confirm — FSM will emit FLIP later
  }
  if (!path) {
    await saveVaneState(opts.kv, {
      ...state,
      score: 0,
      reason: `no path · phase=${phaseGeom} book=${book.grade} dir=${direction.bias} rank=${zoneRank.score}`,
    })
    return null
  }

  // Flat forbids flip
  const regimePol = vaneRegimePolicy({
    regime,
    path,
    directionAlign: aligns && direction.confidence >= 50,
  })
  if (!regimePol.ok) {
    await saveVaneState(opts.kv, {
      ...state,
      phase: path === 'FLIP' ? 'ABORT' : state.phase,
      reason: regimePol.reason ?? 'regime block',
    })
    return null
  }

  const tradeSide: Side = path === 'FLIP' ? flipSide(originSide) : originSide
  const shield = btcShieldAllows({
    symbol,
    side: tradeSide,
    btc: opts.btc,
  })
  if (!shield.ok) {
    await saveVaneState(opts.kv, {
      ...state,
      reason: shield.reason ?? 'btc shield',
    })
    return null
  }

  // Flip entries use broken zone as resistance/support — entry at zone edge
  const entry =
    path === 'FLIP'
      ? originSide === 'LONG'
        ? zone.zoneLow
        : zone.zoneHigh
      : zone.limitEntry

  const structureExtreme =
    tradeSide === 'LONG'
      ? Math.min(zone.zoneLow, price) * 0.998
      : Math.max(zone.zoneHigh, price) * 1.002

  const risk = buildVaneRisk({
    side: tradeSide,
    entry,
    structureExtreme,
    atr15m: atr15,
    oppositeLiq: pick.oppositeLiq,
  })
  if (!risk.ok) {
    await saveVaneState(opts.kv, {
      ...state,
      reason: risk.rejectReason ?? 'rr reject',
    })
    return null
  }

  const dailyAlign =
    (tradeSide === 'LONG' && bias1d !== 'BEAR') ||
    (tradeSide === 'SHORT' && bias1d !== 'BULL')

  const tradeAligns = directionAligns(direction.bias, tradeSide)

  const card = buildVaneScoreCard({
    side: tradeSide,
    path,
    hasHtfZone: !pick.isInternal,
    zoneStrength: zone.strength,
    zoneTf: zone.tf,
    confluence: conf.inOrderBlock || conf.inFvg || zone.touches >= 2,
    sweepReclaim,
    absorptionOrCvd:
      book.absorption ||
      book.cvdConfirm ||
      (absorption.detected && absorption.sideHint === tradeSide),
    wallPersistOk: book.wallPersistMs >= WALL_PERSIST_MS,
    zoneGrade: book.grade,
    btcAlignScore: shield.alignScore,
    dailyAlign,
    regime,
    toxicBook: book.grade === 'WEAK' && path === 'HOLD',
    directionAlign: tradeAligns && direction.bias !== 'FLAT',
    directionConfidence: direction.confidence,
    htfStrength: htf.strength,
    zoneRankScore: zoneRank.score,
    holdHintClear: zoneRank.holdHint.includes('крепление') || zoneRank.holdHint.includes('цель'),
  })

  if (!card.ready || !card.tier || card.score < MIN_VANE_SCORE) {
    await saveVaneState(opts.kv, {
      ...state,
      score: card.score,
      reason: `score ${card.score} < ${MIN_VANE_SCORE} · ${direction.summary}`,
    })
    return null
  }

  // Tier-1 LONG hold prefers sweep reclaim
  if (
    card.tier === 'TIER1' &&
    path === 'HOLD' &&
    tradeSide === 'LONG' &&
    !sweepReclaim &&
    !book.absorption
  ) {
    // Downgrade to tier2 or skip if score was only barely tier1 without sweep
    if (card.score < TIER1_SCORE + 5 && !book.cvdConfirm) {
      /* allow tier2 below */
    }
  }

  const invalidate =
    tradeSide === 'LONG' ? risk.sl * 0.999 : risk.sl * 1.001
  const sizeMult = regimePol.sizeMult
  const riskPct = riskPctForTier(card.tier) * sizeMult
  const winPct = Math.min(
    90,
    Math.max(58, Math.round(50 + card.score * 0.38 + (tradeAligns ? 3 : 0)))
  )

  const setup =
    path === 'FLIP'
      ? `VANE_SR_FLIP_${tradeSide}`
      : pick.isInternal
        ? `VANE_INTERNAL_${tradeSide}`
        : `VANE_HOLD_${tradeSide}`

  const title = `${card.tier === 'TIER1' ? '🎯' : '📌'} ${tradeSide} ${symbol.replace('_USDT', '')} · ${path}`
  const text = [
    `Vane ${path} · ${card.tier} · score ${card.score}/100`,
    `Карта: ${direction.summary}`,
    `Зона ${zone.tf} ${zone.source} ${zone.zoneLow.toFixed(6)}–${zone.zoneHigh.toFixed(6)} · ${zoneRank.holdHint}`,
    `Лимит ${entry.toFixed(6)} · SL ${risk.sl.toFixed(6)} (−${risk.slPct.toFixed(2)}%) · TP ${risk.tp.toFixed(6)} (+${risk.tpPct.toFixed(2)}%)`,
    `R:R 1:${risk.rr.toFixed(2)} · риск ~${riskPct.toFixed(2)}% · size×${sizeMult}`,
    `Стакан: ${book.grade} density×${book.bidAskRatio.toFixed(1)} wall ${Math.round(book.wallPersistMs / 1000)}с`,
    ...book.notes.slice(0, 2),
    ...card.factors.slice(0, 5),
    state.reason ? `FSM: ${state.reason}` : '',
    'Post-Only paper · не догонять.',
  ]
    .filter(Boolean)
    .join('\n')

  await saveVaneState(opts.kv, {
    ...state,
    phase: path === 'HOLD' ? 'LONG_LIMIT' : 'SHORT_LIMIT',
    path,
    tier: card.tier,
    score: card.score,
    reason: 'emit',
  })

  return {
    symbol,
    side: tradeSide,
    path,
    tier: card.tier,
    score: card.score,
    setup,
    zone,
    entry,
    sl: risk.sl,
    tp: risk.tp,
    invalidate,
    winPct,
    riskPct,
    sizeMult,
    reasons: [
      direction.summary,
      zoneRank.holdHint,
      ...card.factors,
      ...book.notes,
    ],
    title,
    text,
    dedupeKey: `vane:${path}:${symbol}:${tradeSide}:${Math.floor(Date.now() / 900_000)}`,
  }
}

export async function runVaneScan(opts?: {
  kv?: VaneKv
  pinSymbols?: string[]
  /** Symbols deep-scanned per cron tick (round-robin shard) */
  batchSize?: number
}): Promise<ScanAlert[]> {
  const session = evaluateVaneSession()
  const kv = opts?.kv
  const risk = await loadVaneRisk(kv)
  const paused = vaneTradingPaused(risk)
  if (paused.paused) {
    console.log('[vane] paused:', paused.reason)
    return []
  }

  const btc = await loadBtcShield()
  const universe = await loadVaneUniverse({ pinSymbols: opts?.pinSymbols })
  // Scan the whole TOP-5 every minute (was 5-of-50 round-robin → missed bounces)
  const scanN = Math.max(universe.length, opts?.batchSize ?? 5)
  const { batch: queue, cursor, nextCursor } = await pickVaneBatch({
    kv,
    universe,
    pinSymbols: opts?.pinSymbols,
    batchSize: scanN,
    hotSlots: Math.min(3, Math.max(1, scanN - 1)),
  })
  console.log(
    `[vane] auto-search cursor ${cursor}→${nextCursor} n=${queue.length}:`,
    queue.map((t) => t.symbol).join(',')
  )

  const decisions: VaneDecision[] = []
  // Sequential pairs max 2 — respects 6 concurrent connection limit
  for (let i = 0; i < queue.length; i += 2) {
    const slice = queue.slice(i, i + 2)
    const parts = await Promise.all(
      slice.map((t) =>
        analyzeSymbol({
          ticker: t,
          kv,
          btc,
          sessionOk: session.ok,
          sessionReason: session.reason,
        })
      )
    )
    for (const d of parts) {
      if (d) decisions.push(d)
    }
  }

  decisions.sort((a, b) => {
    const ta = a.tier === 'TIER1' ? 0 : 1
    const tb = b.tier === 'TIER1' ? 0 : 1
    if (ta !== tb) return ta - tb
    return b.score - a.score
  })

  const alerts: ScanAlert[] = []
  let openRisk = risk
  let tier2Slots = 1

  for (const d of decisions) {
    if (d.tier === 'TIER2') {
      if (tier2Slots <= 0) continue
      tier2Slots--
    }
    const gate = canOpenVanePosition({
      risk: openRisk,
      symbol: d.symbol,
      side: d.side,
      tier: d.tier,
    })
    if (!gate.ok) continue
    openRisk = registerVaneOpen(openRisk, d.symbol, d.side)
    alerts.push(decisionToAlert(d))
    // Cap TG emissions per vane tick
    if (alerts.length >= 2) break
  }

  if (openRisk !== risk) await saveVaneRisk(kv, openRisk)
  return alerts
}
