/**
 * Map Enterprise / MEXC symbols → Binance USDT-M futures stream symbol.
 */

import { toApiSymbol } from '../mexc'

/** Bases that almost always exist on Binance USDT-M — prefer these for lead. */
const CORE_BASES = new Set([
  'BTC',
  'ETH',
  'BNB',
  'SOL',
  'XRP',
  'ADA',
  'AVAX',
  'LINK',
  'DOT',
  'LTC',
  'BCH',
  'NEAR',
  'ATOM',
  'UNI',
  'APT',
  'SUI',
  'TRX',
  'TON',
  'DOGE',
  'PEPE',
  'WIF',
  'BONK',
  'ORDI',
  '1000PEPE',
  '1000BONK',
  'ARB',
  'OP',
  'INJ',
  'FIL',
  'AAVE',
  'CRV',
  'LDO',
  'SEI',
  'TIA',
  'JUP',
  'WLD',
  'PYTH',
  'ENA',
  'PENDLE',
  'ONDO',
  'STRK',
  'MANTA',
  'DYM',
  'SAGA',
  'TAO',
  'FET',
  'RENDER',
])

export function toBinanceFuturesSymbol(symbol: string): string | null {
  if (!symbol) return null
  const api = toApiSymbol(symbol).toUpperCase()
  if (!api.endsWith('_USDT')) return null
  return api.replace('_', '')
}

export function binanceStreamSymbol(symbol: string): string | null {
  const fut = toBinanceFuturesSymbol(symbol)
  return fut ? fut.toLowerCase() : null
}

/** Open Binance lead for liquid majors; try mid-caps; skip obvious junk. */
export function shouldAttachBinanceLead(symbol: string): boolean {
  const api = toApiSymbol(symbol).toUpperCase()
  const base = api.replace(/_USDT$/, '')
  if (CORE_BASES.has(base) || CORE_BASES.has(`1000${base}`)) return true
  if (/^[A-Z0-9]{2,12}$/.test(base)) return true
  return false
}
