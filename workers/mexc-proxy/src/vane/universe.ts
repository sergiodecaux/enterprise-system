import { fetchTickers, quoteVol, type VaneTicker } from './mexc'

const MIN_QUOTE_VOL = 8_000_000
const MAX_SPREAD_PCT = 0.15
/** Elite missed bounces on TOP-50 (5/min RR). Focus = top liquid alts only. */
const TOP_ALTS = 5
const MIN_OI = 2_000

const BLUE_CHIPS = new Set([
  'BTC_USDT',
  'ETH_USDT',
  'BNB_USDT',
  'SOL_USDT',
  'XRP_USDT',
  'ADA_USDT',
  'AVAX_USDT',
  'LINK_USDT',
  'LTC_USDT',
  'DOT_USDT',
  'BCH_USDT',
  'NEAR_USDT',
  'ATOM_USDT',
  'UNI_USDT',
  'APT_USDT',
  'SUI_USDT',
  'TRX_USDT',
  'TON_USDT',
])

/** Preferred majors if volume ranking is noisy */
const PREFERRED_ALTS = [
  'ETH_USDT',
  'SOL_USDT',
  'BNB_USDT',
  'XRP_USDT',
  'AVAX_USDT',
] as const

export function isBlueChip(symbol: string): boolean {
  return BLUE_CHIPS.has(symbol)
}

export function spreadPct(t: VaneTicker): number {
  const bid = Number(t.bid1 ?? 0)
  const ask = Number(t.ask1 ?? 0)
  const mid = (bid + ask) / 2
  if (!(mid > 0) || !(bid > 0) || !(ask > 0)) return 99
  return ((ask - bid) / mid) * 100
}

/**
 * TOP-5 liquid alt USDT-M perps (BTC excluded — shield loads BTC separately).
 * Full list fits in one cron batch → zone touches are not missed.
 */
export async function loadVaneUniverse(opts?: {
  pinSymbols?: string[]
}): Promise<VaneTicker[]> {
  const tickers = await fetchTickers()
  const byAll = new Map(tickers.map((t) => [t.symbol, t]))

  const liquidAlts = tickers
    .filter((t) => {
      if (!t.symbol.endsWith('_USDT')) return false
      if (t.symbol === 'BTC_USDT') return false
      if (t.symbol.includes('USDC')) return false
      const price = Number(t.lastPrice)
      const oi = Number(t.holdVol ?? 0)
      if (!(price > 0)) return false
      if (oi < MIN_OI) return false
      if (t.fundingRate == null) return false
      if (quoteVol(t) < MIN_QUOTE_VOL) return false
      if (spreadPct(t) > MAX_SPREAD_PCT) return false
      return true
    })
    .sort((a, b) => {
      const pa = PREFERRED_ALTS.includes(
        a.symbol as (typeof PREFERRED_ALTS)[number]
      )
        ? 0
        : 1
      const pb = PREFERRED_ALTS.includes(
        b.symbol as (typeof PREFERRED_ALTS)[number]
      )
        ? 0
        : 1
      if (pa !== pb) return pa - pb
      const ba = isBlueChip(a.symbol) ? 0 : 1
      const bb = isBlueChip(b.symbol) ? 0 : 1
      if (ba !== bb) return ba - bb
      return quoteVol(b) - quoteVol(a)
    })
    .slice(0, TOP_ALTS)

  const bySym = new Map(liquidAlts.map((t) => [t.symbol, t]))

  for (const sym of PREFERRED_ALTS) {
    if (bySym.size >= TOP_ALTS) break
    if (bySym.has(sym)) continue
    const row = byAll.get(sym)
    if (!row) continue
    if (quoteVol(row) < MIN_QUOTE_VOL * 0.5) continue
    liquidAlts.push(row)
    bySym.set(sym, row)
  }
  while (liquidAlts.length > TOP_ALTS) liquidAlts.pop()

  for (const pin of opts?.pinSymbols ?? []) {
    if (pin === 'BTC_USDT') continue
    if (bySym.has(pin)) continue
    const row = byAll.get(pin)
    if (row) {
      liquidAlts.push(row)
      bySym.set(pin, row)
    }
  }

  return liquidAlts
}
