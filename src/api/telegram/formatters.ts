import type { CoinSignal, MemeSignal } from '../../engine/types'
import type { SniperSignal } from '../../engine/sniperMode'
import { sendTelegramAlert } from '../../api/telegram/alerts'

function fmt(price: number): string {
  if (!(price > 0)) return '—'
  if (price >= 1000) return price.toFixed(2)
  if (price >= 1) return price.toFixed(4)
  if (price >= 0.01) return price.toFixed(6)
  return price.toFixed(8)
}

function pct(from: number, to: number): string {
  if (!from) return '—'
  const p = ((to - from) / from) * 100
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`
}

function rrLabel(entry: number, sl: number, tp: number): string {
  const risk = Math.abs(entry - sl)
  if (risk <= 0) return '—'
  return `1:${(Math.abs(tp - entry) / risk).toFixed(1)}`
}

function mexcContract(symbol: string): string {
  // App uses BTCUSDT / BTC_USDT — normalize to MEXC futures form
  if (symbol.includes('_')) return symbol.toUpperCase()
  if (symbol.endsWith('USDT') && !symbol.includes('_')) {
    return symbol.replace(/USDT$/i, '_USDT').toUpperCase()
  }
  return symbol.toUpperCase()
}

function tradeBlock(opts: {
  side: 'LONG' | 'SHORT'
  contract: string
  entry: number
  sl: number
  tp: number
  winPct: number
  reason: string
  extras?: string[]
}): string {
  const lines = [
    `Биржа: MEXC Futures`,
    `Контракт: ${opts.contract}`,
    '',
    `Вход: ${fmt(opts.entry)}`,
    `Стоп: ${fmt(opts.sl)} (${pct(opts.entry, opts.sl)})`,
    `Цель: ${fmt(opts.tp)} (${pct(opts.entry, opts.tp)})`,
    `Победа: ${opts.winPct}%`,
    `R:R ${rrLabel(opts.entry, opts.sl, opts.tp)}`,
    '',
    `Причина: ${opts.reason}`,
  ]
  if (opts.extras?.length) {
    lines.push('', ...opts.extras)
  }
  lines.push(
    '',
    'Ищи в MEXC → Фьючерсы → USDT-M → точное имя контракта выше.'
  )
  return lines.join('\n')
}

/** Формат снайперского сигнала для Telegram */
export function formatSniperTelegramMessage(signal: SniperSignal): {
  title: string
  text: string
  dedupeKey: string
} {
  const direction = signal.direction === 'SHORT' ? 'SHORT' : 'LONG'
  const style = signal.tradeStyle === 'SCALP' ? 'SCALP' : 'INTRADAY'
  const icon = direction === 'LONG' ? '🟢' : '🔴'
  const contract = mexcContract(signal.symbol)
  const title = `${icon} ${direction} ${signal.displayName} · ${style}`

  const reason =
    signal.sniperReasons.slice(0, 3).join('; ') ||
    `${style} setup · conf ${signal.calibratedWinRate}%`

  const text = tradeBlock({
    side: direction,
    contract,
    entry: signal.entryPrice,
    sl: signal.sl!,
    tp: signal.tp1!,
    winPct: Math.round(signal.calibratedWinRate),
    reason,
    extras: [
      `Risk ${signal.riskPercent.toFixed(2)}% · Reward ${signal.rewardPercent.toFixed(2)}%`,
      ...(signal.sniperReasons.slice(0, 5).map((r) => `• ${r}`)),
    ],
  })

  return {
    title,
    text,
    dedupeKey: `sniper:${signal.symbol}:${direction}:${signal.tradeStyle}`,
  }
}

function inferMemeSide(meme: MemeSignal): 'LONG' | 'SHORT' {
  if (meme.shortBlocked && !meme.longBlocked) return 'LONG'
  if (meme.longBlocked && !meme.shortBlocked) return 'SHORT'
  if (meme.backside?.detected) return 'SHORT'
  if (meme.bidVoid?.detected) return 'SHORT'
  if (meme.squeeze?.detected || meme.flatline?.detected) return 'LONG'
  if (meme.priceChange24h < -8 && meme.heatScore >= 60) return 'SHORT'
  return 'LONG'
}

function memeLevels(
  side: 'LONG' | 'SHORT',
  price: number,
  volScore: number
): { sl: number; tp: number } {
  const riskPct = Math.min(0.035, Math.max(0.01, 0.012 + volScore / 4000))
  const rewardPct = riskPct * 2.2
  if (side === 'LONG') {
    return { sl: price * (1 - riskPct), tp: price * (1 + rewardPct) }
  }
  return { sl: price * (1 + riskPct), tp: price * (1 - rewardPct) }
}

export function formatMemeTelegramMessage(meme: MemeSignal): {
  title: string
  text: string
  dedupeKey: string
} {
  const setup = meme.setupTag ?? meme.quality
  const side = inferMemeSide(meme)
  const icon = side === 'LONG' ? '🟢' : '🔴'
  const contract = mexcContract(meme.symbol)
  const title = `${icon} ${side} ${meme.displayName} · ${setup}`

  const { sl, tp } = memeLevels(side, meme.price, meme.volatility?.gauge ?? 40)
  const winPct = Math.round(
    Math.min(82, Math.max(55, 50 + meme.heatScore * 0.28))
  )

  const reasons: string[] = []
  if (meme.criticalAlert) reasons.push(meme.criticalAlert)
  if (meme.lifecycle) reasons.push(`Фаза: ${meme.lifecycle.badge}`)
  if (meme.squeeze?.detected) reasons.push('Short squeeze / funding fuel')
  if (meme.flatline?.detected) reasons.push('Flatline ignition')
  if (meme.backside?.detected) reasons.push('Backside short')
  if (meme.volumeSpike?.detected)
    reasons.push(`Vol spike ×${meme.volumeSpike.volumeMultiplier.toFixed(1)}`)
  if (!reasons.length) {
    reasons.push(`Heat ${meme.heatScore}/100 · ${meme.quality}`)
  }

  const text = tradeBlock({
    side,
    contract,
    entry: meme.price,
    sl,
    tp,
    winPct,
    reason: reasons.slice(0, 3).join('; '),
    extras: [
      `Heat/Fuel: ${meme.heatScore}/100`,
      `24h: ${meme.priceChange24h >= 0 ? '+' : ''}${meme.priceChange24h.toFixed(2)}%`,
      meme.longBlocked ? '🔒 LONG LOCKED' : '',
      meme.shortBlocked ? '🔒 SHORT LOCKED' : '',
    ].filter(Boolean),
  })

  return {
    title,
    text,
    dedupeKey: `meme:${meme.symbol}:${meme.setupTag ?? meme.quality}`,
  }
}

export async function pushSniperAlert(signal: SniperSignal): Promise<void> {
  const msg = formatSniperTelegramMessage(signal)
  await sendTelegramAlert({
    type: 'SNIPER',
    title: msg.title,
    text: msg.text,
    dedupeKey: msg.dedupeKey,
  })
}

export async function pushMemeAlert(meme: MemeSignal): Promise<void> {
  const msg = formatMemeTelegramMessage(meme)
  await sendTelegramAlert({
    type: 'MEME',
    title: msg.title,
    text: msg.text,
    dedupeKey: msg.dedupeKey,
  })
}

/** Soft signal (triggered setup) → sniper-quality check done by caller */
export async function pushCoinSignalAlert(
  signal: CoinSignal & { calibratedWinRate?: number }
): Promise<void> {
  if (!signal.direction || signal.sl == null || signal.tp1 == null) return

  const direction = signal.direction
  const entry = signal.ltfChoCH?.surgicalEntryPrice ?? signal.price
  const winPct = Math.round(
    signal.styleConfidence ??
      signal.calibratedWinRate ??
      signal.probabilityPct ??
      60
  )
  const contract = mexcContract(signal.symbol)
  const icon = direction === 'LONG' ? '🟢' : '🔴'
  const style = signal.tradeStyle === 'SCALP' ? 'SCALP' : 'INTRADAY'

  await sendTelegramAlert({
    type: 'SNIPER',
    title: `${icon} ${direction} ${signal.displayName} · ${style}`,
    text: tradeBlock({
      side: direction,
      contract,
      entry,
      sl: signal.sl,
      tp: signal.tp1,
      winPct,
      reason:
        signal.zones.slice(0, 3).join('; ') ||
        `Score ${signal.score}/10 · Prob ${signal.probabilityPct}%`,
      extras: signal.zones.slice(0, 4).map((z) => `• ${z}`),
    }),
    dedupeKey: `setup:${signal.symbol}:${direction}:${Math.round(signal.score)}`,
  })
}
