/** Meme bot — shown in meme Telegram /status */
export const BOT_ENGINE = {
  id: 'meme-day-continue-v26.4',
  label: 'MEME: Day Continue WR-hunt',
  deployedNote:
    'v26.4: TOP-18 WR-hunt · всегда в журнал Lab · дубль сигнала + результата в Elite.',
} as const

/**
 * Enterpriseelite_bot — market assistant + meme journal mirror.
 * Hourly TOP-8+BTC brief · daily close · zones · F&G · news · liq map.
 * Plus Predator meme deals mirrored for WR lab stats.
 */
export const SNIPER_ENGINE = {
  id: 'elite-assistant-v1.1',
  label: 'ELITE: Assistant + MEME Lab',
  deployedNote:
    'v1.1: hourly/daily brief · + дубль MEME-сделок из Mini App/Predator в журнал WR (без VANE-спама).',
} as const

/** Alias for clarity in Elite-facing code */
export const ELITE_ENGINE = SNIPER_ENGINE
