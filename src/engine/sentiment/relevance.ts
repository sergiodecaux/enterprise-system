const COIN_KEYWORDS: Record<string, string[]> = {
  BTC: ['bitcoin', 'btc', 'satoshi', 'биткоин'],
  ETH: ['ethereum', 'eth', 'ether', 'эфириум'],
  SOL: ['solana', 'sol', 'солана'],
  XRP: ['ripple', 'xrp', 'рипл'],
  BNB: ['binance', 'bnb', 'бинанс'],
  ADA: ['cardano', 'ada', 'кардано'],
  DOGE: ['dogecoin', 'doge', 'догекоин'],
  AVAX: ['avalanche', 'avax', 'аваланч'],
  LINK: ['chainlink', 'link', 'чейнлинк'],
  LTC: ['litecoin', 'ltc', 'лайткоин'],
  MATIC: ['polygon', 'matic', 'полигон'],
  DOT: ['polkadot', 'dot', 'полкадот'],
  UNI: ['uniswap', 'uni', 'юнисвап'],
  ATOM: ['cosmos', 'atom', 'космос'],
  NEAR: ['near protocol', 'near'],
  ARB: ['arbitrum', 'arb'],
  OP: ['optimism', 'op'],
  SUI: ['sui network', 'sui'],
  APT: ['aptos', 'apt'],
  PEPE: ['pepe', 'пепе'],
  WIF: ['dogwifhat', 'wif'],
}

const GLOBAL_CRYPTO_KEYWORDS = [
  'crypto',
  'cryptocurrency',
  'blockchain',
  'defi',
  'web3',
  'bitcoin etf',
  'crypto market',
  'digital asset',
  'крипто',
  'блокчейн',
  'рынок',
]

export function extractMentionedCoins(
  title: string,
  summary = ''
): string[] {
  const text = `${title} ${summary}`.toLowerCase()
  const found = new Set<string>()

  for (const [symbol, keywords] of Object.entries(COIN_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) {
        found.add(symbol)
        break
      }
    }
  }

  return Array.from(found)
}

export function isRelevantForCoin(
  symbol: string,
  coins: string[],
  title: string
): boolean {
  if (coins.includes(symbol)) return true
  const text = title.toLowerCase()
  return GLOBAL_CRYPTO_KEYWORDS.some((kw) => text.includes(kw))
}
