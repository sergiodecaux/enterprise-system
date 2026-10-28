import { atr, fetchKlines } from './mexc'
import { BTC_SHIELD_MS, BTC_SHIELD_PCT, type Side } from './types'

export interface BtcShieldSnapshot {
  last: number
  move3mPct: number
  bias: 'UP' | 'DOWN' | 'FLAT'
  atr1m: number
  at: number
}

export interface BtcShieldResult {
  ok: boolean
  reason?: string
  /** 10 = aligned, 0..6 = neutral/weak, negative = real penalty. */
  alignScore: number
  /** False for metals/commodities: BTC is not their driver. */
  applicable: boolean
}

const COMMODITY_SYMBOLS = new Set([
  'XAU_USDT',
  'SILVER_USDT',
  'USOIL_USDT',
])

/** Metals/oil are driven by DXY, yields and session flows, not BTC beta. */
export function isVaneCommodity(symbol: string): boolean {
  return COMMODITY_SYMBOLS.has(symbol)
}

let cached: BtcShieldSnapshot | null = null

export async function loadBtcShield(): Promise<BtcShieldSnapshot> {
  if (cached && Date.now() - cached.at < 45_000) return cached
  const candles = await fetchKlines('BTC_USDT', 'Min1', 12)
  if (candles.length < 4) {
    cached = {
      last: 0,
      move3mPct: 0,
      bias: 'FLAT',
      atr1m: 0,
      at: Date.now(),
    }
    return cached
  }
  const last = candles[candles.length - 1]![4]
  const ago = candles[Math.max(0, candles.length - 4)]![4]
  const move3mPct = ago > 0 ? ((last - ago) / ago) * 100 : 0
  const bias =
    move3mPct > 0.12 ? 'UP' : move3mPct < -0.12 ? 'DOWN' : 'FLAT'
  cached = {
    last,
    move3mPct,
    bias,
    atr1m: atr(candles, 8),
    at: Date.now(),
  }
  return cached
}

/**
 * Block alt entries when BTC impulsively moves against the trade within 3m.
 * BTC itself is never blocked by this shield. The impulse threshold is
 * ATR-normalized so it adapts to current volatility instead of a fixed 0.85%.
 */
export function btcShieldAllows(opts: {
  symbol: string
  side: Side
  btc: BtcShieldSnapshot
}): BtcShieldResult {
  if (isVaneCommodity(opts.symbol)) {
    return {
      ok: true,
      alignScore: 0,
      applicable: false,
      reason: 'commodity: BTC shield off',
    }
  }
  if (opts.symbol === 'BTC_USDT') {
    return { ok: true, alignScore: 10, applicable: true }
  }

  const atrPct =
    opts.btc.last > 0 ? (opts.btc.atr1m / opts.btc.last) * 100 : 0
  const shieldPct =
    atrPct > 0
      ? Math.max(0.35, Math.min(1.2, atrPct * 2.2))
      : BTC_SHIELD_PCT
  const adverse =
    (opts.side === 'LONG' && opts.btc.move3mPct <= -shieldPct) ||
    (opts.side === 'SHORT' && opts.btc.move3mPct >= shieldPct)
  if (adverse) {
    return {
      ok: false,
      reason: `BTC shield: BTC ${opts.btc.move3mPct >= 0 ? '+' : ''}${opts.btc.move3mPct.toFixed(2)}% /3m против ${opts.side} (порог ${shieldPct.toFixed(2)}%)`,
      alignScore: -10,
      applicable: true,
    }
  }

  const aligned =
    (opts.side === 'LONG' && opts.btc.bias === 'UP') ||
    (opts.side === 'SHORT' && opts.btc.bias === 'DOWN')
  const against =
    (opts.side === 'LONG' && opts.btc.bias === 'DOWN') ||
    (opts.side === 'SHORT' && opts.btc.bias === 'UP')

  if (aligned) return { ok: true, alignScore: 10, applicable: true }
  if (against) {
    return {
      ok: true,
      alignScore: -6,
      applicable: true,
      reason: 'BTC 3m/bias против — штраф к score',
    }
  }
  return { ok: true, alignScore: 6, applicable: true }
}

export function btcShieldStale(btc: BtcShieldSnapshot): boolean {
  return Date.now() - btc.at > BTC_SHIELD_MS * 2
}
