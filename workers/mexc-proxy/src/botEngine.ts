/** Meme bot — shown in meme Telegram /status */
export const BOT_ENGINE = {
  id: 'meme-regime-v31.3.2',
  label: 'MEME: regime · exhaustion · age',
  deployedNote:
    'v31.3.2: book-dist A без wick/follow · peer fetch 2.5s timeout (standby hang убивал cron).',
} as const

/**
 * Enterpriseelite_bot — PUMP LONG (meme path) + ALT JEWEL L/S (MM book).
 */
export const SNIPER_ENGINE = {
  id: 'elite-meme-regime-v3.1.3',
  label: 'ELITE: PUMP regime + ALT JEWEL L/S',
  deployedNote:
    'v3.1.3: FOMO_PEAK LONG ок · exh≤55 · book≥52 · меньше structure starve.',
} as const

/** Alias for clarity in Elite-facing code */
export const ELITE_ENGINE = SNIPER_ENGINE
