/** Bumped on each user-visible bot engine change — shown in /status /scan /alerts */
export const BOT_ENGINE = {
  id: 'htf-zones-v2',
  label: 'HTF zones 4H/D · F&G · BTC.D · spoof filter',
  deployedNote:
    'Зоны только 4H/Daily. 15m = тайминг реакции. Сигнал без HTF SSL/BSL не шлётся.',
} as const
