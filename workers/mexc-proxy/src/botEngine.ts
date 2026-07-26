/** Meme / Predator bot — shown in meme Telegram /status */
export const BOT_ENGINE = {
  id: 'predator-liq-echo-v23',
  label: 'PREDATOR: Liquidation Echo',
  deployedNote:
    'Powder-keg hotlist (vol $3–15M, |chg|≥8%, spread≤0.08%, OI+2h≥5%). Ждём wave1 liq → tape fade → Post-Only на эхо. TP+1.1% SL−0.7%, fill≤8s, time-stop 12s maker. Unit 10% + circuit breaker.',
} as const

/** BTC + alts vane sniper — hold strong zone or S/R flip on break+retest */
export const SNIPER_ENGINE = {
  id: 'vane-zone-flip-v1',
  label: 'VANE: Zone Hold / S/R Flip',
  deployedNote:
    'Флюгер: сильная зона (absorption+CVD+wall≥12с) → LONG; пробой+5m close+ретест → SHORT. TOP-50 · Tier1≥85 / Tier2≥70 · TP 1.5–2% · ATR SL · R:R≥1.8 · BTC shield · session/vol pause · circuit −3%/2 loss.',
} as const
