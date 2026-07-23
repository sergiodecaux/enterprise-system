import type { CoinSignal, MarketContext, MemeSignal } from '../types'
import type { TradeSide } from '../smc'
import { enforceMemeTp1Floor } from '../mm'

function resolveMemeDirection(meme: MemeSignal): TradeSide | null {
  // Elite setups first
  if (meme.backside?.detected && !meme.shortBlocked) return 'SHORT'
  if (
    (meme.squeeze?.inProgress || meme.squeeze?.setup || meme.cvdTrap?.detected) &&
    !meme.longBlocked
  ) {
    return 'LONG'
  }
  if (meme.flatline?.detected && !meme.longBlocked) return 'LONG'

  if (meme.toxic?.entryBlocked) return null
  if (meme.absorptionAlert?.type === 'DISTRIBUTION') return null

  if (meme.meanReversion.detected && meme.meanReversion.recommendedDirection) {
    const d = meme.meanReversion.recommendedDirection
    if (d === 'LONG' && meme.longBlocked) return null
    if (d === 'SHORT' && meme.shortBlocked) return null
    return d
  }

  if (meme.liquidityGap.detected && meme.liquidityGap.direction !== 'NEUTRAL') {
    const d = meme.liquidityGap.direction === 'UP' ? 'LONG' : 'SHORT'
    if (d === 'LONG' && meme.longBlocked) return null
    if (d === 'SHORT' && meme.shortBlocked) return null
    return d
  }

  if (meme.spreadPressure.pressure === 'BUYERS' && !meme.longBlocked) return 'LONG'
  if (meme.spreadPressure.pressure === 'SELLERS' && !meme.shortBlocked) {
    return 'SHORT'
  }

  if (meme.volumeSpike.detected) {
    const d = meme.volumeSpike.priceChangePct > 0 ? 'LONG' : 'SHORT'
    if (d === 'LONG' && meme.longBlocked) return null
    if (d === 'SHORT' && meme.shortBlocked) return null
    return d
  }

  return null
}

function buildMemeZones(meme: MemeSignal): string[] {
  const zones: string[] = []
  if (meme.setupTag) zones.push(meme.setupTag)
  if (meme.squeeze?.detected) zones.push(meme.squeeze.label)
  if (meme.flatline?.detected) zones.push(meme.flatline.label)
  if (meme.backside?.detected) zones.push(meme.backside.label)
  if (meme.cvdTrap?.detected) zones.push(meme.cvdTrap.label)
  if (meme.absorptionAlert?.detected) zones.push(meme.absorptionAlert.label)
  if (meme.toxic?.detected) zones.push(meme.toxic.label)
  if (meme.bidVoid?.detected) zones.push(meme.bidVoid.label)
  if (meme.lifecycle) zones.push(meme.lifecycle.badge)
  if (meme.volumeSpike.detected) zones.push(meme.volumeSpike.label)
  if (meme.liquidityGap.detected) zones.push(meme.liquidityGap.label)
  if (meme.meanReversion.detected) zones.push(meme.meanReversion.label)
  if (meme.spreadPressure.pressure !== 'NEUTRAL') {
    zones.push(meme.spreadPressure.label)
  }
  return zones
}

function calcMemeLevels(
  price: number,
  direction: TradeSide | null,
  meme: MemeSignal
): { sl: number | null; tp1: number | null; tp2: number | null } {
  if (!direction) {
    return { sl: null, tp1: null, tp2: null }
  }

  // Squeeze: TP за локальный хай (приблизительно + funding fuel move)
  if (meme.squeeze?.setup || meme.squeeze?.inProgress) {
    const tpPct = meme.squeeze.inProgress ? 8 : 5
    const tp1 = enforceMemeTp1Floor(price, 'LONG', price * (1 + tpPct / 100), 5)
    return {
      sl: price * 0.985,
      tp1,
      tp2: price * (1 + (tpPct * 1.8) / 100),
    }
  }

  // Flatline ignition: микро-стоп за свечу, широкий потенциал
  if (meme.flatline?.detected) {
    return {
      sl: price * 0.99,
      tp1: enforceMemeTp1Floor(price, 'LONG', price * 1.08, 5),
      tp2: price * 1.2,
    }
  }

  // Backside short
  if (meme.backside?.detected && direction === 'SHORT') {
    return {
      sl: price * 1.015,
      tp1: enforceMemeTp1Floor(price, 'SHORT', price * 0.94, 5),
      tp2: price * 0.88,
    }
  }

  const slPct = meme.meanReversion.detected ? 2 : 3
  // Мемы: TP1 минимум +5% (шум 2–4% не должен считаться «целью»)
  const tpPct = meme.meanReversion.detected
    ? Math.max(meme.meanReversion.expectedRetracePct, 5)
    : meme.liquidityGap.detected
      ? Math.max(5, 5)
      : 6

  if (direction === 'LONG') {
    const raw = {
      sl: price * (1 - slPct / 100),
      tp1: price * (1 + tpPct / 100),
      tp2: price * (1 + (tpPct * 1.5) / 100),
    }
    return {
      ...raw,
      tp1: enforceMemeTp1Floor(price, 'LONG', raw.tp1, 5),
    }
  }

  const rawShort = {
    sl: price * (1 + slPct / 100),
    tp1: price * (1 - tpPct / 100),
    tp2: price * (1 - (tpPct * 1.5) / 100),
  }
  return {
    ...rawShort,
    tp1: enforceMemeTp1Floor(price, 'SHORT', rawShort.tp1, 5),
  }
}

/**
 * Конвертирует MemeSignal в CoinSignal для Tactical Drawer и торговых сигналов.
 */
export function buildMemeCoinSignal(
  meme: MemeSignal,
  marketContext: MarketContext | null,
  smc?: CoinSignal | null
): CoinSignal {
  const memeDirection = resolveMemeDirection(meme)
  const direction =
    meme.heatScore >= 40
      ? memeDirection ?? smc?.direction ?? null
      : smc?.direction ?? memeDirection
  const levels = calcMemeLevels(meme.price, direction, meme)
  const memeZones = buildMemeZones(meme)
  const hasActiveSetup =
    ((meme.heatScore >= 50 && direction !== null) ||
      !!meme.squeeze?.inProgress ||
      !!meme.backside?.detected ||
      !!meme.flatline?.detected) &&
    !meme.toxic?.entryBlocked

  const probabilityPct = Math.max(meme.heatScore, smc?.probabilityPct ?? 0)
  const score = Math.max(Math.round(meme.heatScore / 10), smc?.score ?? 0)

  return {
    ...(smc ?? {}),
    symbol: meme.symbol,
    internalSymbol: meme.internalSymbol,
    displayName: meme.displayName,
    price: meme.price,
    priceChange24h: meme.priceChange24h,
    currentRSI: meme.meanReversion.rsi ?? smc?.currentRSI ?? null,
    probabilityPct,
    score: Math.min(score, 10),
    direction,
    zones: memeZones.length ? memeZones : (smc?.zones ?? []),
    sl: levels.sl ?? smc?.sl ?? null,
    tp1: levels.tp1 ?? smc?.tp1 ?? null,
    tp2: levels.tp2 ?? smc?.tp2 ?? null,
    tpDaily: smc?.tpDaily ?? null,
    coinTrend:
      direction === 'LONG'
        ? 'BULLISH'
        : direction === 'SHORT'
          ? 'BEARISH'
          : (smc?.coinTrend ?? null),
    btcTrend: smc?.btcTrend ?? marketContext?.btcTrend ?? null,
    dailyBias: smc?.dailyBias ?? marketContext?.dailyBias ?? null,
    dailyConfidence:
      smc?.dailyConfidence ?? marketContext?.dailyConfidence ?? null,
    dailyPattern: smc?.dailyPattern ?? marketContext?.dailyPattern ?? null,
    isLocked: false,
    hasActiveSetup,
    activeSignal: smc?.activeSignal ?? null,
    activeSignalKey: 'MEME_PULSE',
    btcDivergence: smc?.btcDivergence ?? null,
    mss: smc?.mss,
    raid: smc?.raid,
    ote: smc?.ote,
    absorption: smc?.absorption,
    ltfChoCH: smc?.ltfChoCH,
    buyerAggression: smc?.buyerAggression,
    memePulse: meme,
    tradeStyle: 'SCALP',
  }
}
