import type { MexcTicker } from '../../api/mexc'

/** Blue chips — не мемы, исключаем из сканера */
const BLUE_CHIP_BASES = new Set([
  'BTC',
  'ETH',
  'SOL',
  'XRP',
  'BNB',
  'ADA',
  'AVAX',
  'LINK',
  'DOT',
  'MATIC',
  'POL',
  'UNI',
  'ATOM',
  'LTC',
  'ETC',
  'FIL',
  'APT',
  'ARB',
  'OP',
  'SUI',
  'SEI',
  'INJ',
  'TIA',
  'NEAR',
  'ICP',
  'AAVE',
  'MKR',
  'CRV',
  'SNX',
  'COMP',
  'RUNE',
  'FTM',
  'ALGO',
  'VET',
  'HBAR',
  'XLM',
  'TRX',
  'TON',
  'BCH',
  'WLD',
  'STX',
  'IMX',
  'RENDER',
  'RNDR',
  'FET',
  'GRT',
  'ENS',
  'LDO',
  'RPL',
  'PENDLE',
  'JUP',
  'PYTH',
  'ONDO',
  'ENA',
  'W',
  'STRK',
  'ZK',
  'ZRO',
  'TAO',
  'HYPE',
  'KAS',
  'QNT',
  'EGLD',
  'SAND',
  'MANA',
  'AXS',
  'GALA',
  'FLOW',
  'XTZ',
  'EOS',
  'THETA',
  'KAVA',
  'ZEC',
  'DASH',
  'XMR',
  'CAKE',
  'CFX',
  'ORDI',
  'STG',
  'BLUR',
  'GMX',
  'DYDX',
  '1INCH',
  'BAT',
  'ZRX',
  'KSM',
  'MINA',
  'ROSE',
  'CELO',
  'ONE',
  'IOTA',
  'NEO',
  'WAVES',
  'ICX',
  'ZIL',
  'ENJ',
  'CHZ',
  'ANKR',
  'SKL',
  'STORJ',
  'OCEAN',
  'API3',
  'BAND',
  'LRC',
  'YFI',
  'SUSHI',
  'BAL',
  'UMA',
  'REN',
  'KNC',
  'OMG',
  'QTUM',
  'IOST',
  'RVN',
  'DGB',
  'SC',
  'XEM',
  'HOT',
  'WIN',
  'SUN',
  'JST',
  'NFT',
  'GMT',
  'APE',
  'LUNC',
  'LUNA',
  'USTC',
])

/**
 * Минимальный 24h quote volume (USDT).
 * Раньше было $1M — отсекало большую часть мем-вселенной MEXC.
 */
export const MIN_VOLUME_USD = 150_000

/** Макс. цена — выше порога почти всегда mid/large cap, не мем-игноришн */
export const MAX_MEME_PRICE = 50

/** Минимальный OI (контракты) — мягче, чтобы ловить свежие листинги */
export const MIN_OPEN_INTEREST = 500

export function getTickerBase(ticker: MexcTicker): string {
  return ticker.apiSymbol.replace(/_USDT$/, '')
}

export function isBlueChip(ticker: MexcTicker): boolean {
  return BLUE_CHIP_BASES.has(getTickerBase(ticker))
}

export type MemeRejectReason =
  | 'blue_chip'
  | 'bad_price'
  | 'low_volume'
  | 'low_oi'
  | 'not_usdt'
  | 'usdc'

/**
 * Почему тикер не прошёл мем-фильтр (для диагностики покрытия).
 */
export function memeRejectReason(ticker: MexcTicker): MemeRejectReason | null {
  if (!ticker.apiSymbol.endsWith('_USDT')) return 'not_usdt'
  if (ticker.apiSymbol.includes('USDC')) return 'usdc'
  if (isBlueChip(ticker)) return 'blue_chip'
  if (ticker.lastPrice <= 0 || ticker.lastPrice > MAX_MEME_PRICE) return 'bad_price'
  if (ticker.volume24h < MIN_VOLUME_USD) return 'low_volume'
  if ((ticker.openInterest ?? 0) < MIN_OPEN_INTEREST) return 'low_oi'
  return null
}

/**
 * Мем / шиткоин = всё, что не blue chip и имеет минимальную ликвидность.
 * fundingRate больше не обязателен: на тикере иногда null при живом perp.
 */
export function isMemeTicker(ticker: MexcTicker): boolean {
  return memeRejectReason(ticker) === null
}

/**
 * Все мем-коины с биржи, отсортированные по волатильности × объёму.
 */
export function filterMemeTickers(tickers: MexcTicker[]): MexcTicker[] {
  return tickers
    .filter(isMemeTicker)
    .sort((a, b) => {
      const scoreA = Math.abs(a.priceChangePercent) * Math.log10(a.volume24h + 1)
      const scoreB = Math.abs(b.priceChangePercent) * Math.log10(b.volume24h + 1)
      return scoreB - scoreA
    })
}

export interface MemeUniverseStats {
  totalTickers: number
  memeCount: number
  rejected: Record<MemeRejectReason, number>
}

export function summarizeMemeUniverse(tickers: MexcTicker[]): MemeUniverseStats {
  const rejected: Record<MemeRejectReason, number> = {
    blue_chip: 0,
    bad_price: 0,
    low_volume: 0,
    low_oi: 0,
    not_usdt: 0,
    usdc: 0,
  }
  let memeCount = 0
  for (const t of tickers) {
    const reason = memeRejectReason(t)
    if (reason == null) memeCount++
    else rejected[reason]++
  }
  return { totalTickers: tickers.length, memeCount, rejected }
}

/**
 * Round-robin батч по всей мем-вселенной (чтобы deep-scan не зацикливался на топ-12).
 */
export function prioritizeMemeBatch(
  tickers: MexcTicker[],
  offset: number,
  batchSize: number
): { batch: MexcTicker[]; nextOffset: number } {
  if (!tickers.length) {
    return { batch: [], nextOffset: 0 }
  }

  const batch: MexcTicker[] = []
  const len = tickers.length
  const size = Math.min(batchSize, len)

  for (let i = 0; i < size; i++) {
    batch.push(tickers[(offset + i) % len])
  }

  return {
    batch,
    nextOffset: (offset + size) % len,
  }
}
