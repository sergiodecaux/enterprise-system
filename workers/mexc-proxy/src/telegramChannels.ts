/**
 * Dual Telegram bots:
 * - meme: Predator / liquidation echo (TELEGRAM_BOT_TOKEN)
 * - sniper: BTC + alts zones scalp/intraday (TELEGRAM_SNIPER_BOT_TOKEN)
 */

export type TgChannel = 'meme' | 'sniper'

export const SUB_KEY_MEME = 'telegram:subscribers'
export const SUB_KEY_SNIPER = 'telegram:subscribers_sniper'

export interface ChannelSubscriber {
  chatId: number
  username?: string
  subscribedAt: number
  sniper: boolean
  meme: boolean
}

export function channelForAlertType(
  type: 'SNIPER' | 'MEME' | 'SYSTEM' | 'SETUP_WATCH',
  explicit?: TgChannel
): TgChannel {
  if (explicit) return explicit
  if (type === 'SNIPER' || type === 'SETUP_WATCH') return 'sniper'
  return 'meme'
}

export function tokenForChannel(
  env: { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_SNIPER_BOT_TOKEN?: string },
  channel: TgChannel
): string | undefined {
  return channel === 'sniper'
    ? env.TELEGRAM_SNIPER_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN
    : env.TELEGRAM_BOT_TOKEN
}

export function subKey(channel: TgChannel): string {
  return channel === 'sniper' ? SUB_KEY_SNIPER : SUB_KEY_MEME
}
