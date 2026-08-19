/** Meme bot — shown in meme Telegram /status */
export const BOT_ENGINE = {
  id: 'meme-peak-fuel-v27.4',
  label: 'MEME: PEAK + proven coins',
  deployedNote:
    'v27.4: сигналы только по монетам с WR · новая = notice без входа · WR в каждом алерте.',
} as const

/**
 * Enterpriseelite_bot — ALT JEWEL + assistant (meme LONGs off in peak-only era).
 */
export const SNIPER_ENGINE = {
  id: 'elite-alt-jewel-v27.1r',
  label: 'ELITE: ALT JEWEL L/S + assistant',
  deployedNote:
    'Peak-only memes на Predator. Elite: ALT JEWEL топ‑3 · brief · Mini App.',
} as const

/** Alias for clarity in Elite-facing code */
export const ELITE_ENGINE = SNIPER_ENGINE
