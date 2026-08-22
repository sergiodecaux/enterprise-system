/** Meme bot — shown in meme Telegram /status */
export const BOT_ENGINE = {
  id: 'jeweler-burst-v28.0',
  label: 'MEME: JEWELER BURST ONLY',
  deployedNote:
    'v28.0: только Jeweler Burst LONG/SHORT · phase + BTC + momentum + sync · 3-snapshot стакан · quality ≥68 без базового якоря · paper-first · failover A/B/C.',
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
