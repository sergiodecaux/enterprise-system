/** Bumped on each user-visible bot engine change — shown in /status /scan /alerts */
export const BOT_ENGINE = {
  id: 'meme-selective-v18',
  label: 'Selective pre-impulse meme order-flow',
  deployedNote:
    'Меньше сделок: только нарастающий OBI / сильный vacuum / редкий trap. SL ≥1.4%, RR≥1.5, max 1 мем/цикл и 2 активных, cooldown 45м на монету.',
} as const
