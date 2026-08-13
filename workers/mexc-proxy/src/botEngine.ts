/** Meme bot — shown in meme Telegram /status */
export const BOT_ENGINE = {
  id: 'meme-regime-v31.1',
  label: 'MEME: regime · exhaustion · age',
  deployedNote:
    'v31.1: primary снова ACTIVE (был idle после handoff) · regime+exh+ageGate · TP1→BE→TP2.',
} as const

/**
 * Enterpriseelite_bot — PUMP LONG (meme path) + ALT JEWEL L/S (MM book).
 */
export const SNIPER_ENGINE = {
  id: 'elite-meme-regime-v3.1.1',
  label: 'ELITE: PUMP regime + ALT JEWEL L/S',
  deployedNote:
    'v3.1.1: PUMP LAUNCH/exh≤35 · ALT JEWEL L/S · failover heal если standby мёртв.',
} as const

/** Alias for clarity in Elite-facing code */
export const ELITE_ENGINE = SNIPER_ENGINE
