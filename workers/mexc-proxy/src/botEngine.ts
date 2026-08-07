/** Meme bot — shown in meme Telegram /status */
export const BOT_ENGINE = {
  id: 'meme-peak-fuel-v28.4',
  label: 'MEME: PEAK SHORT + weakness',
  deployedNote:
    'v28.4: только PEAK A · шорт запрещён на голом пампе · нужна слабость (wick/fail/LH/rollover/book).',
} as const

/**
 * Enterpriseelite_bot — market assistant + Mini App Signals (alts) lab.
 * Hourly TOP-8+BTC brief · daily close · zones · F&G · news · liq map.
 * Watches from Mini App «Сигналы» → READY → journal SNIPER WR.
 */
export const SNIPER_ENGINE = {
  id: 'elite-signals-lab-v1',
  label: 'ELITE: Assistant + Signals Lab',
  deployedNote:
    'v1: hourly/daily brief · Mini App Сигналы (альты) → Elite + журнал WR при READY.',
} as const

/** Alias for clarity in Elite-facing code */
export const ELITE_ENGINE = SNIPER_ENGINE
