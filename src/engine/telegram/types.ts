export interface TelegramAlertSettings {
  /** Мастер-тумблер */
  enabled: boolean
  /** Снайперские сигналы */
  sniper: boolean
  /** Мем-сигналы */
  meme: boolean
  /** Слежение за выбранными сетапами */
  setupWatch: boolean
  /** Мин. confidence / heat для отправки */
  minSniperConfidence: number
  minMemeHeat: number
  /**
   * Chat ID для теста вне Telegram / явная привязка.
   * В Mini App обычно берётся userId из WebApp.
   */
  manualChatId: string
  /** Последняя успешная подписка */
  subscribedChatId: number | null
  lastSubscribeAt: number | null
}

export const DEFAULT_TELEGRAM_ALERT_SETTINGS: TelegramAlertSettings = {
  enabled: true,
  sniper: true,
  meme: true,
  setupWatch: true,
  minSniperConfidence: 70,
  minMemeHeat: 50,
  manualChatId: '',
  subscribedChatId: null,
  lastSubscribeAt: null,
}

export const TELEGRAM_ALERT_SETTINGS_KEY = 'enterprise_telegram_alerts'
