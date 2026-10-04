import { toBaseTicker, toFlatSymbol } from '../../api/mexc'
import type { Radar141Row } from '../radar141/types'
import type {
  CoinSignal,
  LiquidityMap,
  MmIntentSnapshot,
  SurgicalEntrySnapshot,
  WhaleWatcherState,
} from '../types'
import { inferWhaleAccumulation } from '../orderbook/whaleSitLevels'

export type HuntSide = 'LONG' | 'SHORT'

export interface DualHuntCard {
  symbol: string
  internalSymbol: string
  displayName: string
  ticker: string
  side: HuntSide
  reason: string
  score: number
  probability: number
  settingUp: boolean
  price: number
  priceChange24h: number
}

export interface DualHuntInput {
  signals: CoinSignal[]
  radarRows: Radar141Row[]
  liquidityMaps?: Record<string, LiquidityMap>
  mmIntent?: Record<string, MmIntentSnapshot>
  surgicalEntries?: Record<string, SurgicalEntrySnapshot>
  whaleWatcher?: Record<string, WhaleWatcherState>
}

export interface DualHuntResult {
  longs: DualHuntCard[]
  shorts: DualHuntCard[]
}

const LIST_CAP = 12
const MIN_SCORE = 22

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function overlaySignal(
  signal: CoinSignal,
  mm: Record<string, MmIntentSnapshot> | undefined,
  surgical: Record<string, SurgicalEntrySnapshot> | undefined
): CoinSignal {
  const key = signal.internalSymbol
  return {
    ...signal,
    mmIntent: signal.mmIntent ?? mm?.[key] ?? null,
    surgicalEntry: signal.surgicalEntry ?? surgical?.[key] ?? null,
  }
}

function dailyToSide(bias: string | null | undefined): HuntSide | null {
  if (bias === 'BULLISH') return 'LONG'
  if (bias === 'BEARISH') return 'SHORT'
  return null
}

function htfToSide(
  bias: string | null | undefined
): HuntSide | null {
  if (bias === 'BULLISH' || bias === 'LONG') return 'LONG'
  if (bias === 'BEARISH' || bias === 'SHORT') return 'SHORT'
  return null
}

function voteSide(
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  liq: LiquidityMap | undefined,
  whale?: WhaleWatcherState | null
): { side: HuntSide | null; long: number; short: number } {
  let long = 0
  let short = 0
  const add = (side: HuntSide | null | undefined, w: number) => {
    if (side === 'LONG') long += w
    else if (side === 'SHORT') short += w
  }

  if (signal) {
    add(signal.direction, 3)
    add(signal.scoreCard?.direction, 3)
    const mm = signal.mmIntent
    if (mm?.preferredSide && mm.confidence >= 40) add(mm.preferredSide, 2)
    const surg = signal.surgicalEntry
    if (
      surg &&
      (surg.status === 'WAITING_SWEEP' ||
        surg.status === 'WAITING_CONFIRM' ||
        surg.status === 'READY')
    ) {
      add(surg.side, 3)
    }
    add(dailyToSide(signal.dailyBias), 2)
    if (signal.mss?.detected) add(htfToSide(signal.mss.direction), 2)
    if (signal.raid?.type === 'BULL_SWEEP') add('LONG', 2)
    if (signal.raid?.type === 'BEAR_SWEEP') add('SHORT', 2)
    add(htfToSide(signal.htfTrend?.bias), 1)
    add(signal.globalFib?.entryBias ?? null, 1)
    add(signal.ote?.direction ?? null, 1)
    const sq = signal.memePulse?.squeeze
    if (sq?.setup || sq?.inProgress) add('LONG', 2)
    if (signal.memePulse?.backside?.detected) add('SHORT', 2)
  }

  if (radar) {
    add(radar.preferredSide, 2)
    add(radar.htfBias === 'FLAT' ? null : radar.htfBias, 1)
    if (radar.rsLabel === 'STRONG') add('LONG', 1)
    if (radar.rsLabel === 'WEAK') add('SHORT', 1)
  }

  const bsl = liq?.nearestBSL
  const ssl = liq?.nearestSSL
  if (bsl?.isActive && ssl?.isActive) {
    if (ssl.distancePct < bsl.distancePct) add('LONG', 1)
    else if (bsl.distancePct < ssl.distancePct) add('SHORT', 1)
  }   else if (ssl?.isActive) add('LONG', 1)
  else if (bsl?.isActive) add('SHORT', 1)

  const whaleAcc = inferWhaleAccumulation(whale)
  if (whaleAcc) add(whaleAcc.side, 2)

  if (long === 0 && short === 0) return { side: null, long, short }
  if (long === short) {
    const fallback =
      signal?.direction ??
      signal?.scoreCard?.direction ??
      radar?.preferredSide ??
      null
    return { side: fallback, long, short }
  }
  return { side: long > short ? 'LONG' : 'SHORT', long, short }
}

function isSettingUp(
  side: HuntSide,
  signal: CoinSignal | null,
  radar: Radar141Row | undefined
): boolean {
  const surg = signal?.surgicalEntry
  if (
    surg &&
    surg.side === side &&
    (surg.status === 'WAITING_SWEEP' || surg.status === 'WAITING_CONFIRM')
  ) {
    return true
  }
  if (signal?.ote?.priceInZone && (signal.ote.direction ?? side) === side) {
    return true
  }
  if (
    signal?.raid?.isFresh &&
    ((side === 'LONG' && signal.raid.type === 'BULL_SWEEP') ||
      (side === 'SHORT' && signal.raid.type === 'BEAR_SWEEP'))
  ) {
    return true
  }
  if (signal?.globalFib?.near141 || signal?.globalFib?.inReactionZone) return true
  if (radar?.trigger === 'APPROACH_141' || radar?.trigger === 'INSIDE_141') {
    return true
  }
  const sq = signal?.memePulse?.squeeze
  if (sq?.setup && !sq.inProgress) return true
  if (radar?.volRegime === 'THIN' && radar.trigger !== 'IN_GAP') return true
  return false
}

function isExtended(side: HuntSide, signal: CoinSignal | null, radar: Radar141Row | undefined): boolean {
  const chg = signal?.priceChange24h ?? radar?.change24h ?? 0
  if (side === 'LONG' && chg >= 12) return true
  if (side === 'SHORT' && chg <= -12) return true
  const rsi = signal?.currentRSI
  if (rsi != null) {
    if (side === 'LONG' && rsi >= 74) return true
    if (side === 'SHORT' && rsi <= 26) return true
  }
  if (radar?.trigger === 'IN_GAP' || radar?.trigger === 'EXIT_141') return true
  if (radar?.testKind === 'EXHAUSTED') return true
  if (signal?.surgicalEntry?.status === 'MISSED') return true
  return false
}

function pickReason(
  side: HuntSide,
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  liq: LiquidityMap | undefined,
  whale?: WhaleWatcherState | null
): string {
  const raid = signal?.raid
  if (
    raid?.isFresh &&
    ((side === 'LONG' && raid.type === 'BULL_SWEEP') ||
      (side === 'SHORT' && raid.type === 'BEAR_SWEEP'))
  ) {
    return side === 'LONG' ? 'свип лоёв' : 'свип хаёв'
  }

  const surg = signal?.surgicalEntry
  if (surg && surg.side === side && surg.status === 'WAITING_SWEEP') {
    return side === 'LONG' ? 'свип снизу близко' : 'свип сверху близко'
  }

  const whaleAcc = inferWhaleAccumulation(whale)
  if (whaleAcc && whaleAcc.side === side) {
    return whaleAcc.side === 'LONG' ? 'киты набирают лонг' : 'киты набирают шорт'
  }

  const sq = signal?.memePulse?.squeeze
  if (sq?.setup || (radar?.volRegime === 'THIN' && radar.trigger !== 'IN_GAP')) {
    return 'топливо / сжатие'
  }

  if (signal?.mss?.detected && htfToSide(signal.mss.direction) === side) {
    return side === 'LONG' ? 'MSS вверх' : 'MSS вниз'
  }

  if (signal?.ltfChoCH?.detected) {
    return side === 'LONG' ? 'смещение вверх' : 'смещение вниз'
  }

  const bsl = liq?.nearestBSL
  const ssl = liq?.nearestSSL
  if (side === 'SHORT' && bsl?.isActive && bsl.distancePct <= 1.6) {
    return 'ликвидность сверху'
  }
  if (side === 'LONG' && ssl?.isActive && ssl.distancePct <= 1.6) {
    return 'ликвидность снизу'
  }
  if (bsl?.isActive && ssl?.isActive) {
    if (side === 'SHORT' && bsl.distancePct <= ssl.distancePct) return 'ликвидность сверху'
    if (side === 'LONG' && ssl.distancePct <= bsl.distancePct) return 'ликвидность снизу'
  }

  const mm = signal?.mmIntent
  if (mm?.preferredSide === side && mm.hunt.microIsStopHunt) {
    return side === 'LONG' ? 'ликвидность снизу' : 'ликвидность сверху'
  }

  if (radar?.trigger === 'APPROACH_141' || radar?.trigger === 'INSIDE_141') {
    return radar.triggerLabel || 'подход к 141'
  }
  if (signal?.globalFib?.near141 || signal?.globalFib?.inReactionZone) {
    return 'подход к 141'
  }
  if (surg && surg.side === side && surg.status === 'WAITING_CONFIRM') {
    return 'ждём подтверждение'
  }
  if (signal?.scoreCard?.ready && signal.scoreCard.direction === side) {
    return 'сетап готов'
  }
  if (signal?.hasActiveSetup && signal.direction === side) {
    return 'активный сетап'
  }
  if (mm?.preferredSide === side) {
    return side === 'LONG' ? 'ММ гонит вверх' : 'ММ гонит вниз'
  }
  if (radar?.preferredSide === side) {
    return radar.scoreWhy.split(':')[0] || (side === 'LONG' ? 'лонг-набор' : 'шорт-набор')
  }
  return side === 'LONG' ? 'готовятся расти' : 'готовятся падать'
}

function huntScore(
  side: HuntSide,
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  liq: LiquidityMap | undefined,
  whale?: WhaleWatcherState | null
): number {
  let score = 0
  if (signal) {
    score += signal.probabilityPct * 0.42
    score += (signal.score ?? 0) * 4
    if (signal.scoreCard) score += signal.scoreCard.percent * 0.22
  } else if (radar) {
    score += radar.opportunityScore * 0.45
    if (radar.gap) score += radar.gap.flyProb * 0.2
  }

  const settingUp = isSettingUp(side, signal, radar)
  if (settingUp) score += 16

  if (radar?.trigger === 'APPROACH_141') score += 26
  if (radar?.trigger === 'INSIDE_141') score += 22
  if (signal?.ote?.priceInZone) score += 16
  if (signal?.globalFib?.near141) score += 12
  if (signal?.globalFib?.inReactionZone) score += 10

  const surg = signal?.surgicalEntry
  if (surg && surg.side === side) {
    if (surg.status === 'WAITING_SWEEP') score += 26
    else if (surg.status === 'WAITING_CONFIRM') score += 22
    else if (surg.status === 'READY') score += 14
    else if (surg.status === 'MISSED' || surg.status === 'INVALIDATED') score -= 14
  }

  const raid = signal?.raid
  if (
    raid?.isFresh &&
    ((side === 'LONG' && raid.type === 'BULL_SWEEP') ||
      (side === 'SHORT' && raid.type === 'BEAR_SWEEP'))
  ) {
    score += 20
  }

  const sq = signal?.memePulse?.squeeze
  if (sq?.setup && !sq.inProgress) score += 16
  else if (sq?.inProgress) score += 4

  if (radar?.volRegime === 'THIN' && radar.trigger !== 'IN_GAP') score += 8
  if (signal?.scoreCard?.ready && signal.scoreCard.direction === side) score += 18
  if (signal?.hasActiveSetup && signal.direction === side) score += 14

  const mm = signal?.mmIntent
  if (mm?.preferredSide === side && mm.confidence >= 50) score += 10
  else if (mm?.preferredSide && mm.preferredSide !== side) score -= 8

  const daily = dailyToSide(signal?.dailyBias)
  if (daily === side) score += 12
  else if (daily && daily !== side) score -= 16

  if (signal?.mss?.detected && htfToSide(signal.mss.direction) === side) score += 12
  else if (signal?.mss?.detected && htfToSide(signal.mss.direction) && htfToSide(signal.mss.direction) !== side) {
    score -= 8
  }

  const magnet =
    side === 'LONG' ? liq?.nearestSSL : liq?.nearestBSL
  if (magnet?.isActive && magnet.distancePct <= 1.2) score += 12
  else if (magnet?.isActive && magnet.distancePct <= 2.2) score += 6

  const whaleAcc = inferWhaleAccumulation(whale)
  if (whaleAcc?.side === side) score += 8
  else if (whaleAcc && whaleAcc.side !== side) score -= 4

  if (radar?.testKind === 'FIRST') score += 8
  else if (radar?.testKind === 'RETEST') score += 3
  else if (radar?.testKind === 'EXHAUSTED') score -= 18

  if (radar?.preferredSide === side) score += 6
  if (radar?.trendAlign && radar.htfBias === side) score += 6

  const chg = signal?.priceChange24h ?? radar?.change24h ?? 0
  if (side === 'LONG' && chg >= 8) score -= 12
  if (side === 'LONG' && chg >= 15) score -= 16
  if (side === 'SHORT' && chg <= -8) score -= 12
  if (side === 'SHORT' && chg <= -15) score -= 16

  const rsi = signal?.currentRSI
  if (rsi != null) {
    if (side === 'LONG' && rsi >= 72) score -= 18
    if (side === 'LONG' && rsi >= 80) score -= 10
    if (side === 'SHORT' && rsi <= 28) score -= 18
    if (side === 'SHORT' && rsi <= 20) score -= 10
  }

  if (radar?.trigger === 'IN_GAP') score -= 24
  if (radar?.trigger === 'EXIT_141') score -= 20
  if (radar?.newsRisk) score -= 8

  if (isExtended(side, signal, radar) && !settingUp) score -= 18

  return clamp(Math.round(score), 0, 100)
}

function probabilityOf(
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  hunt: number
): number {
  if (signal && signal.probabilityPct > 0) return Math.round(signal.probabilityPct)
  if (signal?.scoreCard?.percent) return Math.round(signal.scoreCard.percent)
  if (radar?.gap?.flyProb) return Math.round(radar.gap.flyProb)
  if (radar) return Math.round(radar.opportunityScore)
  return hunt
}

function toCard(
  side: HuntSide,
  signal: CoinSignal | null,
  radar: Radar141Row | undefined,
  liq: LiquidityMap | undefined,
  whale?: WhaleWatcherState | null
): DualHuntCard | null {
  const internal = signal?.internalSymbol ?? radar?.internalSymbol
  if (!internal) return null
  const score = huntScore(side, signal, radar, liq, whale)
  if (score < MIN_SCORE) return null
  const settingUp = isSettingUp(side, signal, radar)
  if (isExtended(side, signal, radar) && !settingUp && score < 40) return null

  return {
    symbol: signal?.symbol ?? toFlatSymbol(internal),
    internalSymbol: internal,
    displayName: signal?.displayName ?? radar?.displayName ?? internal,
    ticker: toBaseTicker(internal),
    side,
    reason: pickReason(side, signal, radar, liq, whale),
    score,
    probability: probabilityOf(signal, radar, score),
    settingUp,
    price: signal?.price ?? radar?.price ?? 0,
    priceChange24h: signal?.priceChange24h ?? radar?.change24h ?? 0,
  }
}

/**
 * Split the scanned universe into two ranked hunts:
 * longs preparing to rise vs shorts preparing to drop.
 * A coin enters only one list — the stronger side.
 */
export function buildDualHunt(input: DualHuntInput): DualHuntResult {
  const radarByKey = new Map<string, Radar141Row>()
  for (const row of input.radarRows) {
    radarByKey.set(row.internalSymbol, row)
    radarByKey.set(row.symbol, row)
    radarByKey.set(toFlatSymbol(row.internalSymbol), row)
  }

  const seen = new Set<string>()
  const longs: DualHuntCard[] = []
  const shorts: DualHuntCard[] = []

  const consider = (signal: CoinSignal | null, radarHint?: Radar141Row) => {
    const radar =
      radarHint ??
      (signal
        ? radarByKey.get(signal.internalSymbol) ??
          radarByKey.get(signal.symbol)
        : undefined)
    const key = signal?.internalSymbol ?? radar?.internalSymbol
    if (!key || seen.has(key)) return
    seen.add(key)

    const liq = input.liquidityMaps?.[key]
    const whale = input.whaleWatcher?.[key] ?? null
    const voted = voteSide(signal, radar, liq, whale)
    if (!voted.side) return
    const card = toCard(voted.side, signal, radar, liq, whale)
    if (!card) return
    if (card.side === 'LONG') longs.push(card)
    else shorts.push(card)
  }

  for (const raw of input.signals) {
    consider(overlaySignal(raw, input.mmIntent, input.surgicalEntries))
  }
  for (const row of input.radarRows) {
    consider(null, row)
  }

  const rank = (a: DualHuntCard, b: DualHuntCard) => {
    if (a.settingUp !== b.settingUp) return a.settingUp ? -1 : 1
    if (b.score !== a.score) return b.score - a.score
    return b.probability - a.probability
  }

  longs.sort(rank)
  shorts.sort(rank)

  return {
    longs: longs.slice(0, LIST_CAP),
    shorts: shorts.slice(0, LIST_CAP),
  }
}
