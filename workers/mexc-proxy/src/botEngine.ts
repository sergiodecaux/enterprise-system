/** Meme bot — shown in meme Telegram /status */
export const BOT_ENGINE = {
  id: 'jeweler-burst-v28.9',
  label: 'MEME: JEWELER · PEAK-FIRST DESK · TAKE 1–1.5%',
  deployedNote:
    'v28.9: peak-first · LONG только impulse+tape · SHORT с вершины/дампа · без mid-range и sync 0 · TP 1–1.5%.',
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
