/** Bumped on each user-visible bot engine change — shown in /status /scan /alerts */
export const BOT_ENGINE = {
  id: 'meme-results-v9',
  label: 'Meme targets + visible signal outcomes',
  deployedNote:
    'Каждый новый сигнал получает финальный статус в Telegram: WIN / LOSS / BE / NO ENTRY / TIMEOUT с PnL, MFE и MAE. Результаты проверяются до тяжёлого мониторинга.',
} as const
