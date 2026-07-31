/** Meme bot — shown in meme Telegram /status */
export const BOT_ENGINE = {
  id: 'meme-day-continue-v26.2',
  label: 'MEME: Day Continue',
  deployedNote:
    'v26.2: BE@0.5R · TP1 lock+trail 0.45–0.6% · abs conf≥92 · symbol cooldown 75м · CONT_BOOK_RELEASE приоритет.',
} as const

/**
 * Enterpriseelite_bot — market assistant (not auto-sniper).
 * Hourly TOP-8+BTC brief · daily close · zones · F&G · news · liq map.
 */
export const SNIPER_ENGINE = {
  id: 'elite-assistant-v1',
  label: 'ELITE: Market Assistant',
  deployedNote:
    'v1: почасовой доклад BTC+TOP-8 · суточный close · F&G/новости/зоны/скальп·интра · ликвидации (SSL/BSL) · без авто-спама сделок.',
} as const

/** Alias for clarity in Elite-facing code */
export const ELITE_ENGINE = SNIPER_ENGINE
