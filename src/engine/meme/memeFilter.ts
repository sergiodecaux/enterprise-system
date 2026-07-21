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

/** Минимальный 24h объём (USD) — отсекаем мёртвые пары */
const MIN_VOLUME_USD = 5_000

/** Макс. цена — мемы редко дороже */
const MAX_MEME_PRICE = 15

export function getTickerBase(ticker: MexcTicker): string {
  return ticker.apiSymbol.replace(/_USDT$/, '')
}

export function isBlueChip(ticker: MexcTicker): boolean {
  return BLUE_CHIP_BASES.has(getTickerBase(ticker))
}

/**
 * Мем / шиткоин = всё, что не blue chip и имеет ликвидность.
 * DOGE, PEPE, SHIB, WIF и прочий «мусор» попадают сюда.
 */
export function isMemeTicker(ticker: MexcTicker): boolean {
  if (isBlueChip(ticker)) return false
  if (ticker.lastPrice <= 0 || ticker.lastPrice > MAX_MEME_PRICE) return false
  if (ticker.volume24h < MIN_VOLUME_USD) return false
  return true
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
