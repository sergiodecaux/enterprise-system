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
  normalizeVanePause,
  registerVaneOpen,
  saveVaneRisk,
  syncVaneOpenFromPapers,
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
import {
  candle1mWithSide,
  MICRO_MIN_SCORE,
  MICRO_RISK_PCT,
  MICRO_TP1_PCT,
  qualifyMicro,
} from './microStrategy'
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
import { listPaperTrades } from '../paperTrades'
import {
  MIN_VANE_SCORE,
  WALL_PERSIST_MS,
  type Candle,
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
  // v4: wider approach so early scalp can arm before perfect touch
  if (dist <= 0.028) return 'APPROACH'
  return 'FAR'
}

/** Favorable 1m/3m move % for side — detects start of scalp impulse */
function earlyMoveFavorPct(candles1m: Candle[], side: Side): number {
  if (candles1m.length < 5) return 0
  const last = candles1m[candles1m.length - 1]![4]
  const ago3 = candles1m[candles1m.length - 4]![4]
  if (!(ago3 > 0) || !(last > 0)) return 0
  const pct = ((last - ago3) / ago3) * 100
  return side === 'LONG' ? pct : -pct
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
    target1: d.target1,
    zoneSource:
      d.zone.source === 'SSL' || d.zone.source === 'BSL'
        ? d.zone.source
        : 'SWING',
    zoneStrength: d.zone.strength,
    zoneTouches: d.zone.touches,
    zonePhase: phaseOfGeom(d.entry, d.zone.zoneLow, d.zone.zoneHigh),
    targetLabel: d.micro
      ? `MICRO TP ${((Math.abs(d.tp - d.entry) / d.entry) * 100).toFixed(2)}%`
      : `Vane TP ${((Math.abs(d.tp - d.entry) / d.entry) * 100).toFixed(2)}%`,
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
    style: 'SCALP',
    align: 'WITH_TREND',
    tradePlan: plan,
    needsPullbackWatch: Boolean(d.needsPullbackWatch),
    watchOnly: Boolean(d.watchOnly),
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

  // Phase 1: HTF only (mostly KV cache) — avoid 6× MEXC per symbol every minute
  const [c15m, c1h, c4h, c1d] = await Promise.all([
    fetchKlinesCached(opts.kv, symbol, 'Min15', 64),
    fetchKlinesCached(opts.kv, symbol, 'Min60', 48),
    fetchKlinesCached(opts.kv, symbol, 'Hour4', 90),
    fetchKlinesCached(opts.kv, symbol, 'Day1', 60),
  ])
  if (c4h.length < 30) return null

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

  // Phase 2: LTF + book only when zone is in radar (cuts empty-symbol HTTP)
  const [c1m, c5m] = await Promise.all([
    fetchKlinesCached(opts.kv, symbol, 'Min1', 120),
    fetchKlinesCached(opts.kv, symbol, 'Min5', 48),
  ])
  if (c1m.length < 30) return null

  const spike = volSpikePause(c1m)
  if (spike.pause) return null
  const atr1m = atr(c1m, 8) || price * 0.002

  // Skip expensive depth/deals unless near zone, FAR-in-radar, or flip armed
  const nearOrFlip = candidates.some((c) => {
    const ph = phaseOfGeom(price, c.zone.zoneLow, c.zone.zoneHigh)
    return (
      ph === 'TOUCH' ||
      ph === 'APPROACH' ||
      ph === 'FAR' ||
      c.pathHint === 'FLIP'
    )
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
    /** FAR wait: depth only — skip deals to save a subrequest */
    skipDeals: phaseGeom === 'FAR',
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
  const earlyFavor = earlyMoveFavorPct(c1m, originSide)
  const tickerChg = Math.abs(Number(opts.ticker.riseFallRate ?? 0) * 100)
  const candleWith = candle1mWithSide(c1m, originSide)

  // MICRO first — high-WR micro-scalp (maker, small %, size via risk%)
  const microQ = qualifyMicro({
    phase: phaseGeom,
    earlyFavorPct: earlyFavor,
    bookGrade: book.grade,
    absorption: book.absorption || absorption.detected,
    cvdConfirm: book.cvdConfirm,
    greenDeltaWeak: book.greenDeltaWeak,
    aligns,
    conflicts,
    zoneStrength: zone.strength,
    zoneTouches: zone.touches,
    candle1mWithUs: candleWith,
    directionConfidence: direction.confidence,
  })
  let microMode = false

  // Determine actionable path
  let path: VanePath | null = emitPath
  if (microQ.ok && path !== 'FLIP') {
    path = 'HOLD'
    microMode = true
  }
  // HOLD: TOUCH with STRONG, or APPROACH with STRONG+tape
  if (
    !path &&
    book.grade === 'STRONG' &&
    (phaseGeom === 'TOUCH' ||
      (phaseGeom === 'APPROACH' && (book.absorption || book.cvdConfirm)))
  ) {
    path = 'HOLD'
  }
  // Soft HOLD: TOUCH + NEUTRAL book but clear absorption/CVD
  if (
    !path &&
    phaseGeom === 'TOUCH' &&
    book.grade === 'NEUTRAL' &&
    (book.absorption || book.cvdConfirm) &&
    !book.greenDeltaWeak
  ) {
    path = 'HOLD'
  }
  // Bounce HOLD: multi-touch HTF
  if (
    !path &&
    phaseGeom === 'TOUCH' &&
    book.grade !== 'WEAK' &&
    zone.touches >= 2 &&
    !book.greenDeltaWeak
  ) {
    path = 'HOLD'
  }
  // Rich HOLD
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
  // Rich APPROACH — stricter book for non-MICRO (WR filter)
  if (
    !path &&
    phaseGeom === 'APPROACH' &&
    aligns &&
    zone.strength >= 5 &&
    !conflicts &&
    book.grade === 'STRONG' &&
    (book.absorption || book.cvdConfirm)
  ) {
    path = 'HOLD'
  }
  // Legacy early scalp only with STRONG book (diluted WR otherwise → MICRO owns this niche)
  if (
    !path &&
    phaseGeom === 'TOUCH' &&
    earlyFavor >= 0.4 &&
    earlyFavor <= 1.0 &&
    book.grade === 'STRONG' &&
    aligns &&
    !conflicts &&
    candleWith
  ) {
    path = 'HOLD'
  }
  if (
    !path &&
    zoneRank.preferPath === 'FLIP' &&
    book.grade === 'WEAK' &&
    phaseGeom === 'TOUCH'
  ) {
    // FSM handles FLIP later
  }

  // WAIT ZONE only when not MICRO
  let waitOnly = false
  if (
    !microMode &&
    !path &&
    (phaseGeom === 'FAR' || phaseGeom === 'APPROACH') &&
    aligns &&
    !conflicts &&
    zone.strength >= 5 &&
    book.grade !== 'WEAK' &&
    direction.confidence >= 45
  ) {
    path = 'HOLD'
    waitOnly = true
  }

  if (!path) {
    await saveVaneState(opts.kv, {
      ...state,
      score: 0,
      reason: `no path · phase=${phaseGeom} book=${book.grade} dir=${direction.bias} early=${earlyFavor.toFixed(2)} micro=${microQ.reason} rank=${zoneRank.score}`,
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
    atr1m,
    oppositeLiq: pick.oppositeLiq,
    micro: microMode,
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
    holdHintClear:
      zoneRank.holdHint.includes('крепление') ||
      zoneRank.holdHint.includes('цель'),
  })

  const minScore = microMode ? MICRO_MIN_SCORE : MIN_VANE_SCORE
  if (!card.ready || !card.tier || card.score < minScore) {
    if (!(waitOnly && !microMode && card.score >= 40)) {
      await saveVaneState(opts.kv, {
        ...state,
        score: card.score,
        reason: `score ${card.score} < ${minScore} · ${direction.summary}`,
      })
      return null
    }
  }

  if (microMode && waitOnly) {
    await saveVaneState(opts.kv, {
      ...state,
      score: card.score,
      reason: 'micro_rejected_wait',
    })
    return null
  }

  const emitTier = card.tier ?? 'TIER2'
  const invalidate =
    tradeSide === 'LONG' ? risk.sl * 0.999 : risk.sl * 1.001
  const sizeMult = regimePol.sizeMult
  const riskPct = microMode
    ? MICRO_RISK_PCT * sizeMult
    : riskPctForTier(emitTier) * sizeMult
  const winPct = microMode
    ? Math.min(88, Math.max(68, Math.round(62 + card.score * 0.28)))
    : Math.min(
        90,
        Math.max(55, Math.round(48 + card.score * 0.4 + (tradeAligns ? 3 : 0)))
      )

  const target1 =
    tradeSide === 'LONG'
      ? entry * (1 + MICRO_TP1_PCT / 100)
      : entry * (1 - MICRO_TP1_PCT / 100)

  const mode: 'WAIT' | 'MICRO' | 'SCALP' | 'HOLD' | 'FLIP' = microMode
    ? 'MICRO'
    : waitOnly
      ? 'WAIT'
      : path === 'FLIP'
        ? 'FLIP'
        : earlyFavor >= 0.35
          ? 'SCALP'
          : 'HOLD'

  const setup =
    path === 'FLIP'
      ? `VANE_SR_FLIP_${tradeSide}`
      : microMode
        ? `VANE_MICRO_${tradeSide}`
        : waitOnly
          ? `VANE_WAIT_${tradeSide}`
          : pick.isInternal
            ? `VANE_INTERNAL_${tradeSide}`
            : mode === 'SCALP'
              ? `VANE_SCALP_${tradeSide}`
              : `VANE_HOLD_${tradeSide}`

  const coin = symbol.replace('_USDT', '')
  const title =
    mode === 'MICRO'
      ? `💎 MICRO · ${tradeSide} ${coin}`
      : mode === 'WAIT'
        ? `👁 WAIT ЗОНА · ${tradeSide} ${coin}`
        : mode === 'SCALP'
          ? `⚡ SCALP · ${tradeSide} ${coin}`
          : mode === 'FLIP'
            ? `🔁 FLIP · ${tradeSide} ${coin}`
            : `${emitTier === 'TIER1' ? '🎯' : '📌'} HOLD · ${tradeSide} ${coin}`

  const text = [
    mode === 'MICRO'
      ? `Режим: MICRO high-WR · ${emitTier} · score ${card.score}/100 · risk ${riskPct.toFixed(2)}%`
      : mode === 'WAIT'
        ? `Режим: WAIT · ${emitTier} · score ${card.score}/100`
        : `Режим: ${mode} · ${emitTier} · score ${card.score}/100`,
    mode === 'MICRO'
      ? `Стратегия: TP ${risk.tpPct.toFixed(2)}% · SL ${risk.slPct.toFixed(2)}% · maker · импульс уже пошёл · цель WR≥65%`
      : mode === 'WAIT'
        ? 'Не догоняю — жду касание/reclaim зоны.'
        : 'Зона + confirm · Post-Only.',
    `Карта: ${direction.summary}`,
    earlyFavor >= 0.15
      ? `Импульс ~${earlyFavor.toFixed(2)}% /3м · 24h ${(Number(opts.ticker.riseFallRate ?? 0) * 100).toFixed(1)}%`
      : null,
    microMode ? `Теги: ${microQ.tags.join(' · ')}` : null,
    `Зона ${zone.tf} ${zone.source} ${zone.zoneLow.toFixed(6)}–${zone.zoneHigh.toFixed(6)} · ${zoneRank.holdHint}`,
    `Лимит ${entry.toFixed(6)} · SL ${risk.sl.toFixed(6)} (−${risk.slPct.toFixed(2)}%) · TP1 ${target1.toFixed(6)} · TP ${risk.tp.toFixed(6)} (+${risk.tpPct.toFixed(2)}%)`,
    `R:R 1:${risk.rr.toFixed(2)} · size×${sizeMult}`,
    `Стакан: ${book.grade} density×${book.bidAskRatio.toFixed(1)}`,
    ...book.notes.slice(0, 2),
    ...card.factors.slice(0, 3),
    mode === 'MICRO'
      ? 'BE @ +0.28% · TP1 0.4% · trail тугой · не усреднять · риск 0.35% equity.'
      : mode === 'WAIT'
        ? 'TTL wait до 4ч · без market chase.'
        : 'Post-Only · не догонять.',
  ]
    .filter(Boolean)
    .join('\n')

  await saveVaneState(opts.kv, {
    ...state,
    phase: path === 'HOLD' ? 'LONG_LIMIT' : 'SHORT_LIMIT',
    path,
    tier: emitTier,
    score: card.score,
    reason: microMode ? 'micro_emit' : waitOnly ? 'wait_zone' : 'emit',
  })

  return {
    symbol,
    side: tradeSide,
    path,
    tier: emitTier,
    score: card.score,
    setup,
    zone,
    entry,
    sl: risk.sl,
    tp: risk.tp,
    target1: microMode || mode === 'SCALP' ? target1 : undefined,
    invalidate,
    winPct,
    riskPct,
    sizeMult,
    reasons: [
      direction.summary,
      zoneRank.holdHint,
      ...(microMode ? microQ.tags : []),
      ...card.factors,
      ...book.notes,
    ],
    title,
    text,
    dedupeKey: `vane:${mode.toLowerCase()}:${symbol}:${tradeSide}:${Math.floor(Date.now() / 600_000)}`,
    needsPullbackWatch:
      !microMode &&
      (waitOnly || phaseGeom === 'APPROACH' || phaseGeom === 'FAR'),
    watchOnly: false,
    micro: microMode,
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
  let risk = await loadVaneRisk(kv)
  risk = normalizeVanePause(risk)

  // Rebuild open book from live paper — unsticks WAIT timeouts that never freed slots
  try {
    const papers = await listPaperTrades(
      kv ? { SUBSCRIBERS: kv as unknown as KVNamespace } : {}
    )
    const synced = syncVaneOpenFromPapers(risk, papers)
    if (
      synced.openSymbols.join() !== risk.openSymbols.join() ||
      JSON.stringify(synced.openSides) !== JSON.stringify(risk.openSides)
    ) {
      risk = synced
      await saveVaneRisk(kv, risk)
      console.log(
        '[vane] synced open slots:',
        risk.openSymbols.join(',') || 'none'
      )
    }
  } catch (err) {
    console.error('[vane] paper sync failed', err)
  }

  const paused = vaneTradingPaused(risk)
  if (paused.paused) {
    console.log('[vane] paused:', paused.reason)
    return []
  }
  if (!session.ok) {
    console.log('[vane] session blackout:', session.reason)
    return []
  }

  const btc = await loadBtcShield()
  const universe = await loadVaneUniverse({ pinSymbols: opts?.pinSymbols })
  // v4.2: honor cron batchSize (was forcing ≥10 → Too many subrequests)
  const scanN = Math.min(universe.length, Math.max(3, opts?.batchSize ?? 5))
  const { batch: queue, cursor, nextCursor } = await pickVaneBatch({
    kv,
    universe,
    pinSymbols: opts?.pinSymbols,
    batchSize: scanN,
    hotSlots: Math.min(3, Math.max(2, scanN - 1)),
  })
  console.log(
    `[vane] scalp-start cursor ${cursor}→${nextCursor} n=${queue.length}/${universe.length}:`,
    queue.map((t) => t.symbol).join(',')
  )

  const decisions: VaneDecision[] = []
  // Sequential (not pairs) — lower peak concurrent subrequests under CF cap
  for (const t of queue) {
    try {
      const d = await analyzeSymbol({
        ticker: t,
        kv,
        btc,
        sessionOk: true,
        sessionReason: session.reason,
      })
      if (d) decisions.push(d)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[vane] symbol failed', t.symbol, msg)
      if (/subrequest/i.test(msg)) break
    }
  }

  // MICRO first (high-WR), then TIER1, then score
  decisions.sort((a, b) => {
    const ma = a.micro ? 0 : 1
    const mb = b.micro ? 0 : 1
    if (ma !== mb) return ma - mb
    const ta = a.tier === 'TIER1' ? 0 : 1
    const tb = b.tier === 'TIER1' ? 0 : 1
    if (ta !== tb) return ta - tb
    return b.score - a.score
  })

  const alerts: ScanAlert[] = []
  let openRisk = risk
  let tier2Slots = 3
  let microSlots = 1

  for (const d of decisions) {
    if (d.micro) {
      if (microSlots <= 0) continue
      microSlots--
    } else if (d.tier === 'TIER2') {
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
    if (alerts.length >= 4) break
  }

  if (openRisk !== risk) await saveVaneRisk(kv, openRisk)
  return alerts
}
