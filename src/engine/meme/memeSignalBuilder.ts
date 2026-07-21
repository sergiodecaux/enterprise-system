import type { CoinSignal, MarketContext, MemeSignal } from '../types'
import type { TradeSide } from '../smc'

function resolveMemeDirection(meme: MemeSignal): TradeSide | null {
  if (meme.meanReversion.detected && meme.meanReversion.recommendedDirection) {
    return meme.meanReversion.recommendedDirection
  }

  if (meme.liquidityGap.detected && meme.liquidityGap.direction !== 'NEUTRAL') {
    return meme.liquidityGap.direction === 'UP' ? 'LONG' : 'SHORT'
  }

  if (meme.spreadPressure.pressure === 'BUYERS') return 'LONG'
  if (meme.spreadPressure.pressure === 'SELLERS') return 'SHORT'

  if (meme.volumeSpike.detected) {
    return meme.volumeSpike.priceChangePct > 0 ? 'LONG' : 'SHORT'
  }

  return null
}

function buildMemeZones(meme: MemeSignal): string[] {
  const zones: string[] = []
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

  const slPct = meme.meanReversion.detected ? 2 : 3
  const tpPct = meme.meanReversion.detected
    ? Math.max(meme.meanReversion.expectedRetracePct, 2)
    : meme.liquidityGap.detected
      ? 5
      : 4

  if (direction === 'LONG') {
    return {
      sl: price * (1 - slPct / 100),
      tp1: price * (1 + tpPct / 100),
      tp2: price * (1 + (tpPct * 1.5) / 100),
    }
  }

  return {
    sl: price * (1 + slPct / 100),
    tp1: price * (1 - tpPct / 100),
    tp2: price * (1 - (tpPct * 1.5) / 100),
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
    meme.heatScore >= 40 ? memeDirection ?? smc?.direction ?? null : smc?.direction ?? memeDirection
  const levels = calcMemeLevels(meme.price, direction, meme)
  const memeZones = buildMemeZones(meme)
  const hasActiveSetup =
    (meme.heatScore >= 50 && direction !== null) || (smc?.hasActiveSetup ?? false)

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
  }
}
