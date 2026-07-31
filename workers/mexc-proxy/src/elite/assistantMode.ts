/**
 * Elite Assistant mode — Enterpriseelite_bot is a market helper, not a sniper.
 * Auto trade alerts on sniper channel are suppressed; briefings + /zone remain.
 */

/** Default ON: Elite = assistant. Set ELITE_ASSISTANT_ONLY=0 to restore VANE spam. */
export function isEliteAssistantOnly(env?: {
  ELITE_ASSISTANT_ONLY?: string
}): boolean {
  const v = env?.ELITE_ASSISTANT_ONLY
  if (v === '0' || v === 'false' || v === 'off') return false
  return true
}
