/** Meme bot — shown in meme Telegram /status */
export const BOT_ENGINE = {
  id: 'meme-book-directional-v27.7',
  label: 'MEME: LIVE BOOK + CANDLES + FAILOVER',
  deployedNote:
    'v27.7: LONG/SHORT только со свечами 1m+5m/15m и живым стаканом · hard veto против сильной встречной ликвидности · подробный журнал v293 · failover A/B/C.',
} as const

/**
 * Enterpriseelite_bot — ALT JEWEL + assistant (meme LONGs off in peak-only era).
 */
export const SNIPER_ENGINE = {
  id: 'elite-vane-miniapp-v28',
  label: 'ELITE: альты как Mini App',
  deployedNote:
    'Как вкладка Сигналы: зоны HTF, SMC hunt, confluence, вход только READY. Прокси: mexc-proxy-f.',
} as const

/** Alias for clarity in Elite-facing code */
export const ELITE_ENGINE = SNIPER_ENGINE
