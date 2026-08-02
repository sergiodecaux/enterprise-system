import type { SequenceHit } from '../sequence'
import type { MarketRegime } from '../regime/marketRegime'
import type { WhaleWatcherState } from '../types'
import type { LiveSignalResult } from '../trades/findLiveSignal'
import { getOiSnapshot, getFrames } from '../sequence'

export interface ChartHint {
  id: string
  /** Anchor price on chart; null = float near top/mid */
  price: number | null
  side: 'LONG' | 'SHORT' | 'INFO'
  title: string
  body: string
  priority: number
}

/**
 * Remizov coach notes for the chart — process language, not RSI tips.
 */
export function buildChartHints(input: {
  symbol: string
  price: number
  regime: MarketRegime
  sequence?: SequenceHit | null
  whale?: WhaleWatcherState | null
  liveSignal?: LiveSignalResult | null
  bookImbalance?: number | null
}): ChartHint[] {
  const hints: ChartHint[] = []
  const price = input.price
  const regime = input.regime
  const seq =
    input.sequence && input.sequence.expiresAt > Date.now()
      ? input.sequence
      : null

  // 1) Regime = first frame
  hints.push({
    id: 'regime',
    price: null,
    side: 'INFO',
    title: `Режим · ${regimeLabel(regime)}`,
    body: regimeHint(regime),
    priority: 10,
  })

  // 2) Active sequence limit
  if (seq) {
    hints.push({
      id: 'seq',
      price: seq.wallPrice,
      side: seq.side,
      title: seq.allowedInRegime
        ? `Предел · ${seq.side}`
        : `Предел (контекст) · ${seq.side}`,
      body: seq.allowedInRegime
        ? `${shortKind(seq.kind)} · ~${seq.confidence}%. ${firstSentence(seq.summary)}`
        : `Есть процесс, но режим ${regime} — не primary. Жди смену режима или другую последовательность.`,
      priority: seq.allowedInRegime ? 100 : 70,
    })

    if (seq.steps[0]) {
      hints.push({
        id: 'seq_step',
        price: seq.wallPrice,
        side: seq.side,
        title: 'Кадр процесса',
        body: seq.steps.slice(0, 2).join(' → '),
        priority: 85,
      })
    }
  }

  // 3) Whale walls — static vs dynamic coaching
  const support = input.whale?.strongestSupport
  const resist = input.whale?.strongestResistance
  if (support && price > 0) {
    hints.push({
      id: 'whale_bid',
      price: support.price,
      side: 'LONG',
      title: 'Кит BID',
      body: seq?.kind === 'WALL_ABSORPTION_EXHAUSTION' && seq.side === 'LONG'
        ? 'Стена уже в процессе поглощения — смотри ленту: удары vs объём стены.'
        : `Поддержка ~$${fmtVol(support.volumeUsd)} · −${support.distancePct.toFixed(2)}%. Статика. Нужны удары рыночными продажами, чтобы проверить «настоящий» лимит.`,
      priority: 55,
    })
  }
  if (resist && price > 0) {
    hints.push({
      id: 'whale_ask',
      price: resist.price,
      side: 'SHORT',
      title: 'Кит ASK',
      body: seq?.kind === 'WALL_ABSORPTION_EXHAUSTION' && seq.side === 'SHORT'
        ? 'ASK в процессе поглощения — жди иссякания покупок у стены.'
        : `Сопротивление ~$${fmtVol(resist.volumeUsd)} · +${resist.distancePct.toFixed(2)}%. Жди рыночные покупки в стену → держит или снимают.`,
      priority: 55,
    })
  }

  // 4) OI frame
  const oi = getOiSnapshot(input.symbol)
  if (oi && oi.samples >= 2) {
    hints.push({
      id: 'oi',
      price: null,
      side:
        oi.divergenceType === 'DISTRIBUTION'
          ? 'SHORT'
          : oi.confirmsMove && oi.priceChangePct > 0
            ? 'LONG'
            : oi.confirmsMove && oi.priceChangePct < 0
              ? 'SHORT'
              : 'INFO',
      title: `OI ${oi.changePct >= 0 ? '+' : ''}${oi.changePct.toFixed(1)}%`,
      body:
        oi.divergenceType === 'DISTRIBUTION'
          ? 'Цена↑ OI↓ — разгрузка / слабое топливо. Не догонять лонг.'
          : oi.divergenceType === 'SHORT_BUILD'
            ? 'Цена↓ OI↑ — набор шортов. Осторожно с лонгом от воздуха.'
            : oi.confirmsMove
              ? 'OI и цена согласованы — живые деньги в движении.'
              : 'OI пока шум. Жди подтверждения с дельтой.',
      priority: 48,
    })
  }

  // 5) Book imbalance
  const imb = input.bookImbalance
  if (imb != null && Math.abs(imb) >= 18) {
    hints.push({
      id: 'book',
      price: null,
      side: imb > 0 ? 'LONG' : 'SHORT',
      title: `Стакан ${imb > 0 ? 'BID' : 'ASK'} ${Math.abs(imb).toFixed(0)}%`,
      body:
        imb > 0
          ? 'Перевес бидов — кадр поддержки. Без ударов в стену это ещё не предел.'
          : 'Перевес асков — давление сверху. Смотри, снимают ли ASK или держат.',
      priority: 40,
    })
  }

  // 6) Film strip density
  const frames = getFrames(input.symbol, 5 * 60_000)
  const hits = frames.filter((f) => f.kind === 'HIT').length
  if (hits >= 4 && !seq) {
    hints.push({
      id: 'film',
      price: null,
      side: 'INFO',
      title: 'Лента активна',
      body: `За 5м много HIT-кадров (${hits}), но предела ещё нет — жди иссякание агрессии у стены или CVD-дивергенцию.`,
      priority: 35,
    })
  }

  // 7) Live signal action
  const primary = input.liveSignal?.primary
  if (primary && primary.side !== 'FLAT') {
    hints.push({
      id: 'action',
      price: input.liveSignal?.bestSetup?.limitEntry ?? null,
      side: primary.side,
      title: `Действие · ${primary.side}`,
      body: `${primary.title} (~${primary.winPct}%). ${firstSentence(primary.summary)} Не mid-impulse — лимит на реакции.`,
      priority: 90,
    })
  } else if (regime === 'VOLATILE_CHOP') {
    hints.push({
      id: 'wait_chop',
      price: null,
      side: 'INFO',
      title: 'Ждать',
      body: 'CHOP — большинство playbook выключено. Только extreme absorb у стены или тишина.',
      priority: 80,
    })
  }

  hints.sort((a, b) => b.priority - a.priority)
  // Cap so chart stays readable
  return hints.slice(0, 5)
}

function regimeLabel(r: MarketRegime): string {
  switch (r) {
    case 'TRENDING_STRONG':
      return 'сильный тренд'
    case 'TRENDING_WEAK':
      return 'слабый тренд'
    case 'RANGING':
      return 'флэт'
    case 'VOLATILE_CHOP':
      return 'хаос'
  }
}

function regimeHint(r: MarketRegime): string {
  switch (r) {
    case 'TRENDING_STRONG':
      return 'Первый кадр: тренд. Работай continuation / wall release / OI confirm. Fade от стен — только контекст.'
    case 'TRENDING_WEAK':
      return 'Тренд слабый — допустимы и отскок, и продолжение. Ищи предел последовательности, не паттерн.'
    case 'RANGING':
      return 'Флэт — bounce от SSL/BSL и wall absorb. Не гоняй mid-range.'
    case 'VOLATILE_CHOP':
      return 'Хаос после импульса/новостей. Большинство правил молчит — жди режим.'
  }
}

function shortKind(kind: string): string {
  return kind
    .replace('WALL_ABSORPTION_EXHAUSTION', 'Wall absorb')
    .replace('CVD_DIVERGENCE_LIMIT', 'CVD div')
    .replace('WALL_RELEASE', 'Wall release')
    .replace('OI_DELTA_CONFIRM', 'OI+delta')
}

function firstSentence(s: string): string {
  const cut = s.split(/[.!?]/)[0]
  return (cut || s).slice(0, 140)
}

function fmtVol(usd: number): string {
  if (usd >= 1_000_000) return `${(usd / 1_000_000).toFixed(1)}M`
  if (usd >= 1_000) return `${(usd / 1_000).toFixed(0)}K`
  return String(Math.round(usd))
}
