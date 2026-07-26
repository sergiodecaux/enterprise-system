import { fetchTickers, quoteVol, type VaneTicker } from './mexc'

const MIN_QUOTE_VOL = 15_000_000
const MAX_SPREAD_PCT = 0.12
const TOP_N = 50
const MIN_OI = 4_000

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

/** TOP-50 liquid USDT-M perps for vane horizontal scaling */
export async function loadVaneUniverse(opts?: {
  pinSymbols?: string[]
}): Promise<VaneTicker[]> {
  const tickers = await fetchTickers()
  const liquid = tickers
    .filter((t) => {
      if (!t.symbol.endsWith('_USDT')) return false
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
    .sort((a, b) => quoteVol(b) - quoteVol(a))
    .slice(0, TOP_N)

  const bySym = new Map(liquid.map((t) => [t.symbol, t]))
  for (const pin of opts?.pinSymbols ?? []) {
    if (bySym.has(pin)) continue
    const row = tickers.find((t) => t.symbol === pin)
    if (row) {
      liquid.push(row)
      bySym.set(pin, row)
    }
  }

  // Prefer blue chips early in scan order for budget
  return liquid.sort((a, b) => {
    const ba = isBlueChip(a.symbol) ? 0 : 1
    const bb = isBlueChip(b.symbol) ? 0 : 1
    if (ba !== bb) return ba - bb
    return quoteVol(b) - quoteVol(a)
  })
}
