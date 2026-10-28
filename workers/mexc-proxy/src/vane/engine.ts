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
  computeSessionMomentum,
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
import {
  MACRO_DIR_CONF_MIN,
  MACRO_MIN_SCORE,
  MACRO_RISK_PCT,
  MACRO_TP1_PCT,
  detectLocalRange,
  moveFavorPct,
  qualifyMacro,
  rangePosition,
} from './macroStrategy'
import {
  loadMacroMemory,
  memoryAllowsTrade,
  memorySummary,
  rememberMacroAnalysis,
} from './macroMemory'
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
  MIN_VANE_SCORE_ACTION,
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
  high: number,
  atrPct = 0.6
): 'FAR' | 'APPROACH' | 'TOUCH' {
  if (!(price > 0) || !(low > 0) || !(high > 0)) return 'FAR'
  // TOUCH/APPROACH bands scale with ATR instead of fixed 0.3%/2.8%.
  const touchBand = Math.max(0.12, Math.min(1.2, atrPct * 0.35)) / 100
  if (
    price >= low * (1 - touchBand) &&
    price <= high * (1 + touchBand)
  ) {
    return 'TOUCH'
  }
  const mid = (low + high) / 2
  const dist = Math.abs(price - mid) / price
  const approachBand = Math.max(0.8, Math.min(3.5, atrPct * 2)) / 100
  if (dist <= approachBand) return 'APPROACH'
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
    targetLabel: d.macro
      ? `MACRO TP ${((Math.abs(d.tp - d.entry) / d.entry) * 100).toFixed(2)}%`
      : d.micro
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
  const atrPct = price > 0 ? (atr15 / price) * 100 : 0.6
  const sessionMom = computeSessionMomentum(c1h)
  const sessionHeat =
    Math.abs(sessionMom.returnPct) >= 1.2 ||
    Math.abs(sessionMom.emaSpreadPct) >= 0.35
  const htf = computeHtfTrendLite(c1h, c4h)
  const map = buildHtfLiquidityMap({
    candles4h: c4h,
    candles1d: c1d,
    candles1h: c1h,
    price,
  })

  // Candidates: real HTF zones + 15m internal zones only. No synthetic
  // range/momentum zones: if there is no structural zone, VANE stands aside.
  const candidates: Array<{
    side: Side
    zone: VaneZoneGeom
    pathHint: VanePath
    isInternal: boolean
    oppositeLiq: number | null
    origin: 'HTF' | 'INTERNAL' | 'FLIP'
  }> = []

  const localRange = detectLocalRange(c15m, 24)

  for (const side of ['LONG', 'SHORT'] as Side[]) {
    const smart = findSmartZone(side, price, map, atr15, {
      relaxed: true,
    })
    if (!smart) continue
    const ph = smart.phase
    // Zone TOUCH/APPROACH + FAR within 2.5% only when session/EMA has heat.
    const inRadar =
      ph === 'TOUCH' ||
      ph === 'APPROACH' ||
      (ph === 'FAR' && smart.distancePct <= 2.5 && sessionHeat)
    if (inRadar) {
      candidates.push({
        side,
        zone: smartToGeom(smart),
        pathHint: 'HOLD',
        isInternal: false,
        oppositeLiq: smart.target,
        origin: 'HTF',
      })
    }
  }

  for (const side of ['LONG', 'SHORT'] as Side[]) {
    const iz = findInternalZone({
      side,
      price,
      candles15m: c15m,
      bias4h,
    })
    if (iz) {
      const ph = phaseOfGeom(price, iz.zoneLow, iz.zoneHigh, atrPct)
      if (ph === 'TOUCH' || ph === 'APPROACH') {
        candidates.push({
          side,
          zone: iz,
          pathHint: 'HOLD',
          isInternal: true,
          oppositeLiq: null,
          origin: 'INTERNAL',
        })
      }
    }
  }

  if (!candidates.length) {
    const prev = await loadVaneState(opts.kv, symbol)
    if (
      prev &&
      (prev.phase === 'RETEST_WAIT' ||
        prev.phase === 'BREAK_ARMED' ||
        prev.phase === 'WEAK_BREAK')
    ) {
      candidates.push({
        side: prev.originSide,
        zone: prev.zone,
        pathHint: 'FLIP',
        isInternal: prev.zone.tf === '15m',
        oppositeLiq: null,
        origin: 'FLIP',
      })
    } else {
      // No real zone — stand aside. Momentum without structure is not a setup.
      return null
    }
  }

  // Soft HTF abort — allow FLAT/RANGING only with a real zone + session heat
  const htfQuick = computeVaneDirection({
    htf,
    bias4h,
    bias1d,
    regime,
    bookGrade: 'NEUTRAL',
    bookSide: candidates[0]!.side,
    nearestLongDist: null,
    nearestShortDist: null,
  })
  if (
    htfQuick.bias === 'FLAT' &&
    htfQuick.confidence < 35 &&
    !sessionHeat &&
    !localRange?.compressed &&
    !candidates.some((c) => c.origin === 'HTF')
  ) {
    return null
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

  // Depth is only worth loading when a real zone is in the radar.
  const nearOrFlip = candidates.some((c) => {
    if (c.pathHint === 'FLIP') return true
    const ph = phaseOfGeom(price, c.zone.zoneLow, c.zone.zoneHigh, atrPct)
    return ph === 'TOUCH' || ph === 'APPROACH' || ph === 'FAR'
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
      phase: phaseOfGeom(price, a.zone.zoneLow, a.zone.zoneHigh, atrPct),
    }).score
    const rb = rankZoneCandidate({
      side: b.side,
      zone: b.zone,
      price,
      isInternal: b.isInternal,
      oppositeLiq: b.oppositeLiq,
      direction,
      bookGrade: 'NEUTRAL',
      phase: phaseOfGeom(price, b.zone.zoneLow, b.zone.zoneHigh, atrPct),
    }).score
    if (rb !== ra) return rb - ra
    return Math.abs(a.zone.mid - price) - Math.abs(b.zone.mid - price)
  })
  const pick = candidates[0]!
  const originSide = pick.side
  const zone = pick.zone
  const phaseGeom = phaseOfGeom(price, zone.zoneLow, zone.zoneHigh, atrPct)

  // Depth + KV state/memory are independent → one parallel burst.
  const [book, prev, macroMem] = await Promise.all([
    assessZoneStrength({
      symbol,
      side: originSide,
      mid: zone.mid,
      candles1m: c1m,
      kv: opts.kv,
      /** FAR wait: depth only — skip deals to save a subrequest */
      skipDeals: phaseGeom === 'FAR',
    }),
    loadVaneState(opts.kv, symbol),
    loadMacroMemory(opts.kv, symbol),
  ])

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
  const sessionFavor =
    originSide === 'LONG' ? sessionMom.returnPct : -sessionMom.returnPct
  const emaAligned = directionAligns(sessionMom.bias, originSide)
  const candleWith = candle1mWithSide(c1m, originSide)
  const move5m = moveFavorPct(c5m.length ? c5m : c1m, originSide, 3)
  const rangePos = localRange ? rangePosition(price, localRange) : null

  // MACRO — ZONE / RANGE_BREAK / MOMENTUM + history memory
  const macroQ = qualifyMacro({
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
    isInternal: pick.isInternal,
    sessionFavorPct: sessionFavor,
    emaAligned,
    emaStrengthPct: Math.abs(sessionMom.emaSpreadPct),
    regime,
    range: localRange,
    rangePos,
    memory: macroMem,
    side: originSide,
    move5mFavor: move5m,
  })
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

  let macroMode = false
  let microMode = false
  let path: VanePath | null = emitPath

  if (macroQ.ok && path !== 'FLIP') {
    path = 'HOLD'
    macroMode = true
  } else if (microQ.ok && path !== 'FLIP') {
    path = 'HOLD'
    microMode = true
  }

  // Soft HOLD fallback (actionable only — no WAIT/FAR arms)
  if (
    !path &&
    book.grade === 'STRONG' &&
    aligns &&
    !conflicts &&
    candleWith &&
    earlyFavor >= 0.45 &&
    earlyFavor <= 2.0 &&
    zone.strength >= 4 &&
    (phaseGeom === 'TOUCH' || phaseGeom === 'APPROACH') &&
    (emaAligned || sessionFavor >= 0.35) &&
    (book.absorption || book.cvdConfirm)
  ) {
    path = 'HOLD'
    if (
      earlyFavor >= 0.55 &&
      earlyFavor <= 2.4 &&
      direction.confidence >= MACRO_DIR_CONF_MIN - 5
    ) {
      macroMode = true
    }
  }

  if (!path) {
    await Promise.all([
      rememberMacroAnalysis(opts.kv, {
        symbol,
        side: 'FLAT',
        context: 'SKIP',
        reason: macroQ.reason,
        note: `skip ${phaseGeom}/${book.grade}/e${earlyFavor.toFixed(2)}/${macroQ.reason}`,
      }),
      saveVaneState(opts.kv, {
        ...state,
        score: 0,
        reason: `skip · ${macroQ.reason} · ${memorySummary(macroMem)}`,
      }),
    ])
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
  if (macroMode) {
    const memGate = memoryAllowsTrade(macroMem, tradeSide)
    if (!memGate.ok) {
      await saveVaneState(opts.kv, {
        ...state,
        reason: memGate.reason,
      })
      return null
    }
  }
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
    macro: macroMode,
    micro: microMode && !macroMode,
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
    btcApplicable: shield.applicable,
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

  const minScore = macroMode
    ? MACRO_MIN_SCORE
    : microMode
      ? MICRO_MIN_SCORE
      : MIN_VANE_SCORE_ACTION
  if (!card.ready || !card.tier || card.score < minScore) {
    await saveVaneState(opts.kv, {
      ...state,
      score: card.score,
      reason: `score ${card.score} < ${minScore} · ${direction.summary}`,
    })
    return null
  }

  const emitTier = card.tier
  const invalidate =
    tradeSide === 'LONG' ? risk.sl * 0.999 : risk.sl * 1.001
  const sizeMult = regimePol.sizeMult
  const riskPct = macroMode
    ? MACRO_RISK_PCT * sizeMult
    : microMode
      ? MICRO_RISK_PCT * sizeMult
      : riskPctForTier(emitTier) * sizeMult
  const winPct = macroMode
    ? Math.min(88, Math.max(62, Math.round(55 + card.score * 0.32 + (tradeAligns ? 4 : 0))))
    : microMode
      ? Math.min(88, Math.max(68, Math.round(62 + card.score * 0.28)))
      : Math.min(
          90,
          Math.max(55, Math.round(48 + card.score * 0.4 + (tradeAligns ? 3 : 0)))
        )

  const tp1Pct = macroMode ? MACRO_TP1_PCT : MICRO_TP1_PCT
  const target1 =
    tradeSide === 'LONG'
      ? entry * (1 + tp1Pct / 100)
      : entry * (1 - tp1Pct / 100)

  const mode: 'MACRO' | 'MICRO' | 'HOLD' | 'FLIP' = macroMode
    ? 'MACRO'
    : microMode
      ? 'MICRO'
      : path === 'FLIP'
        ? 'FLIP'
        : 'HOLD'

  const setup =
    path === 'FLIP'
      ? `VANE_SR_FLIP_${tradeSide}`
      : macroMode
        ? `VANE_MACRO_${tradeSide}`
        : microMode
          ? `VANE_MICRO_${tradeSide}`
          : pick.isInternal
            ? `VANE_INTERNAL_${tradeSide}`
            : `VANE_HOLD_${tradeSide}`

  const macroCtx = macroQ.context ?? 'ZONE'
  const coin = symbol.replace('_USDT', '')
  const title =
    mode === 'MACRO'
      ? `🚀 MACRO ${macroCtx === 'RANGE_BREAK' ? 'RANGE' : macroCtx === 'MOMENTUM' ? 'MOM' : 'ZONE'} · ${tradeSide} ${coin}`
      : mode === 'MICRO'
        ? `💎 MICRO · ${tradeSide} ${coin}`
        : mode === 'FLIP'
          ? `🔁 FLIP · ${tradeSide} ${coin}`
          : `${emitTier === 'TIER1' ? '🎯' : '📌'} HOLD · ${tradeSide} ${coin}`

  const text = [
    mode === 'MACRO'
      ? `Режим: MACRO ${macroCtx} · ${emitTier} · score ${card.score}/100 · risk ${riskPct.toFixed(2)}% · ${regime}`
      : mode === 'MICRO'
        ? `Режим: MICRO high-WR · ${emitTier} · score ${card.score}/100 · risk ${riskPct.toFixed(2)}%`
        : `Режим: ${mode} · ${emitTier} · score ${card.score}/100`,
    mode === 'MACRO'
      ? `Стратегия: ловим макро-ход (зона / боковик / импульс) · TP ${risk.tpPct.toFixed(2)}% · SL ${risk.slPct.toFixed(2)}%`
      : mode === 'MICRO'
        ? `Стратегия: TP ${risk.tpPct.toFixed(2)}% · SL ${risk.slPct.toFixed(2)}% · maker chip`
        : 'Зона + confirm · Post-Only.',
    `Карта: ${direction.summary}`,
    memorySummary(macroMem),
    earlyFavor >= 0.15
      ? `Импульс ~${earlyFavor.toFixed(2)}% /3м · 5м ${move5m.toFixed(2)}% · ${sessionMom.summary}`
      : null,
    macroMode
      ? `Теги: ${macroQ.tags.join(' · ')}`
      : microMode
        ? `Теги: ${microQ.tags.join(' · ')}`
        : null,
    localRange
      ? `Range 15м ${localRange.low.toFixed(6)}–${localRange.high.toFixed(6)} (${localRange.widthPct.toFixed(1)}%)${rangePos ? ` · ${rangePos}` : ''}`
      : null,
    `Зона ${zone.tf} ${zone.source} ${zone.zoneLow.toFixed(6)}–${zone.zoneHigh.toFixed(6)} · ${zoneRank.holdHint}`,
    `Лимит ${entry.toFixed(6)} · SL ${risk.sl.toFixed(6)} (−${risk.slPct.toFixed(2)}%) · TP1 ${target1.toFixed(6)} · TP ${risk.tp.toFixed(6)} (+${risk.tpPct.toFixed(2)}%)`,
    `R:R 1:${risk.rr.toFixed(2)} · size×${sizeMult}`,
    `Стакан: ${book.grade} density×${book.bidAskRatio.toFixed(1)}`,
    ...book.notes.slice(0, 2),
    ...card.factors.slice(0, 3),
    mode === 'MACRO'
      ? 'BE @ +0.55% · TP1 0.9% · память блокирует повторные LOSS · не усреднять.'
      : mode === 'MICRO'
        ? 'BE @ +0.28% · TP1 0.4% · trail тугой.'
        : 'Post-Only · не догонять.',
  ]
    .filter(Boolean)
    .join('\n')

  if (macroMode) {
    await rememberMacroAnalysis(opts.kv, {
      symbol,
      side: tradeSide,
      context: macroCtx,
      reason: macroQ.reason,
      note: `${tradeSide} ${macroCtx} score${card.score} e${earlyFavor.toFixed(2)}`,
    })
  }

  await saveVaneState(opts.kv, {
    ...state,
    phase: path === 'HOLD' ? 'LONG_LIMIT' : 'SHORT_LIMIT',
    path,
    tier: emitTier,
    score: card.score,
    reason: macroMode
      ? `macro_${macroCtx}`
      : microMode
        ? 'micro_emit'
        : 'emit',
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
    target1: macroMode || microMode ? target1 : undefined,
    invalidate,
    winPct,
    riskPct,
    sizeMult,
    reasons: [
      direction.summary,
      zoneRank.holdHint,
      ...(macroMode ? macroQ.tags : microMode ? microQ.tags : []),
      ...card.factors,
      ...book.notes,
    ],
    title,
    text,
    dedupeKey: `vane:${mode.toLowerCase()}:${symbol}:${tradeSide}:${Math.floor(Date.now() / 600_000)}`,
    needsPullbackWatch: false,
    watchOnly: false,
    macro: macroMode,
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

  const [btc, universe] = await Promise.all([
    loadBtcShield(),
    loadVaneUniverse({ pinSymbols: opts?.pinSymbols }),
  ])
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
    `[vane] macro-v6 cursor ${cursor}→${nextCursor} n=${queue.length}/${universe.length}:`,
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

  // MACRO first, then MICRO, then TIER1, then score
  decisions.sort((a, b) => {
    const ma = a.macro ? 0 : a.micro ? 1 : 2
    const mb = b.macro ? 0 : b.micro ? 1 : 2
    if (ma !== mb) return ma - mb
    const ta = a.tier === 'TIER1' ? 0 : 1
    const tb = b.tier === 'TIER1' ? 0 : 1
    if (ta !== tb) return ta - tb
    return b.score - a.score
  })

  const alerts: ScanAlert[] = []
  let openRisk = risk
  let macroSlots = 2
  let microSlots = 1
  let tier2Slots = 2

  for (const d of decisions) {
    if (d.macro) {
      if (macroSlots <= 0) continue
      macroSlots--
    } else if (d.micro) {
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
    if (alerts.length >= 3) break
  }

  if (openRisk !== risk) await saveVaneRisk(kv, openRisk)
  return alerts
}
