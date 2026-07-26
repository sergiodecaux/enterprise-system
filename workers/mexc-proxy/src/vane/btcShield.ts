import { atr, fetchKlines } from './mexc'
import { BTC_SHIELD_MS, BTC_SHIELD_PCT, type Side } from './types'

export interface BtcShieldSnapshot {
  last: number
  move3mPct: number
  bias: 'UP' | 'DOWN' | 'FLAT'
  atr1m: number
  at: number
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
 * BTC itself is never blocked by this shield.
 */
export function btcShieldAllows(opts: {
  symbol: string
  side: Side
  btc: BtcShieldSnapshot
}): { ok: boolean; reason?: string; alignScore: number } {
  if (opts.symbol === 'BTC_USDT') {
    return { ok: true, alignScore: 10 }
  }
  const adverse =
    (opts.side === 'LONG' && opts.btc.move3mPct <= -BTC_SHIELD_PCT) ||
    (opts.side === 'SHORT' && opts.btc.move3mPct >= BTC_SHIELD_PCT)
  if (adverse) {
    return {
      ok: false,
      reason: `BTC shield: BTC ${opts.btc.move3mPct >= 0 ? '+' : ''}${opts.btc.move3mPct.toFixed(2)}% /3m против ${opts.side}`,
      alignScore: 0,
    }
  }
  const aligned =
    (opts.side === 'LONG' && opts.btc.bias !== 'DOWN') ||
    (opts.side === 'SHORT' && opts.btc.bias !== 'UP')
  return {
    ok: true,
    alignScore: aligned ? (opts.btc.bias === 'FLAT' ? 10 : 8) : 4,
    reason: aligned ? undefined : 'BTC нейтрально/слабо против — сниженный вес',
  }
}

export function btcShieldStale(btc: BtcShieldSnapshot): boolean {
  return Date.now() - btc.at > BTC_SHIELD_MS * 2
}
