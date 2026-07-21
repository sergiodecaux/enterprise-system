import type { CoinSignal, MemeSignal } from '../../engine/types'
import type { SniperSignal } from '../../engine/sniperMode'
import { sendTelegramAlert } from '../../api/telegram/alerts'

function fmt(price: number): string {
  if (price >= 1000) return price.toFixed(2)
  if (price >= 1) return price.toFixed(4)
  return price.toFixed(6)
}

/** Формат снайперского сигнала для Telegram */
export function formatSniperTelegramMessage(signal: SniperSignal): {
  title: string
  text: string
  dedupeKey: string
} {
  const style = signal.tradeStyle === 'SCALP' ? '⚡️ SCALP' : '🎯 INTRADAY'
  const dir = signal.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'
  const title = `${style} ${dir} ${signal.displayName}`

  const lines = [
    `Confidence: ${signal.calibratedWinRate}%`,
    `Entry: ${fmt(signal.entryPrice)}`,
    `SL: ${fmt(signal.sl!)} (${signal.riskPercent.toFixed(2)}%)`,
    `TP1: ${fmt(signal.tp1!)} (${signal.rewardPercent.toFixed(2)}%)`,
    `R:R 1:${signal.riskReward.toFixed(1)}`,
  ]

  if (signal.sniperReasons.length) {
    lines.push('', 'Фильтры:')
    for (const r of signal.sniperReasons.slice(0, 5)) {
      lines.push(`• ${r}`)
    }
  }

  lines.push('', 'ENTERPRISE SYSTEM · Sniper')

  return {
    title,
    text: lines.join('\n'),
    dedupeKey: `sniper:${signal.symbol}:${signal.direction}:${signal.tradeStyle}`,
  }
}

export function formatMemeTelegramMessage(meme: MemeSignal): {
  title: string
  text: string
  dedupeKey: string
} {
  const tag = meme.setupTag ?? `🔥 ${meme.quality}`
  const title = `${tag} ${meme.displayName}`

  const lines = [
    `Heat / Fuel: ${meme.heatScore}/100`,
    `Price: ${fmt(meme.price)} (${meme.priceChange24h >= 0 ? '+' : ''}${meme.priceChange24h.toFixed(2)}%)`,
  ]

  if (meme.lifecycle) lines.push(`Phase: ${meme.lifecycle.badge}`)
  if (meme.volatility) lines.push(`Vol: ${meme.volatility.label}`)
  if (meme.criticalAlert) lines.push('', meme.criticalAlert)
  if (meme.longBlocked) lines.push('🔒 LONG LOCKED')
  if (meme.shortBlocked) lines.push('🔒 SHORT LOCKED')

  lines.push('', 'ENTERPRISE SYSTEM · Meme Radar')

  return {
    title,
    text: lines.join('\n'),
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

  const entry = signal.ltfChoCH?.surgicalEntryPrice ?? signal.price
  const risk = Math.abs(entry - signal.sl)
  const reward = Math.abs(signal.tp1 - entry)
  const rr = risk > 0 ? reward / risk : 0

  await sendTelegramAlert({
    type: 'SNIPER',
    title: `${signal.tradeStyle === 'SCALP' ? '⚡️' : '🎯'} ${signal.direction} ${signal.displayName}`,
    text: [
      `Score: ${signal.score}/10 · Prob ${signal.probabilityPct}%`,
      `Entry: ${fmt(entry)}`,
      `SL: ${fmt(signal.sl)} · TP1: ${fmt(signal.tp1)}`,
      `R:R 1:${rr.toFixed(1)}`,
      signal.styleConfidence != null
        ? `Style Confidence: ${signal.styleConfidence}%`
        : '',
      '',
      ...(signal.zones.slice(0, 4).map((z) => `• ${z}`)),
    ]
      .filter(Boolean)
      .join('\n'),
    dedupeKey: `setup:${signal.symbol}:${signal.direction}:${Math.round(signal.score)}`,
  })
}
