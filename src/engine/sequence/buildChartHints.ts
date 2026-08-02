import type { SequenceHit } from '../sequence'
import type { MarketRegime } from '../regime/marketRegime'
import type { WhaleWatcherState } from '../types'
import type { LiveSignalResult } from '../trades/findLiveSignal'
import { getOiSnapshot, getFrames, getCachedSpotPerpHealth } from '../sequence'

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
 * Подсказки на языке процесса (Ремизов), без биржевого жаргона.
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

  hints.push({
    id: 'regime',
    price: null,
    side: 'INFO',
    title: `Сейчас рынок: ${regimeLabel(regime)}`,
    body: regimeHint(regime),
    priority: 10,
  })

  if (seq) {
    const action =
      seq.side === 'LONG'
        ? 'Смотри отскок вверх от стены'
        : 'Смотри откат вниз от стены'
    const fuel =
      seq.kind === 'TRAPPED_TRADERS' ? 'Топливо · запертые · ' : ''
    hints.push({
      id: 'seq',
      price: seq.wallPrice,
      side: seq.side,
      title: seq.allowedInRegime
        ? `${fuel}Сигнал процесса · ${seq.side === 'LONG' ? 'вверх' : 'вниз'}`
        : `Процесс есть, но режим другой`,
      body: seq.allowedInRegime
        ? `${kindRu(seq.kind)} (~${seq.confidence}%). ${firstSentence(seq.summary)} ${action}.`
        : `Нашли последовательность, но сейчас «${regimeLabel(regime)}» — не входи по этому сигналу. Жди смену режима.`,
      priority: seq.allowedInRegime
        ? seq.kind === 'TRAPPED_TRADERS'
          ? 105
          : 100
        : 70,
    })

    if (seq.steps[0]) {
      hints.push({
        id: 'seq_step',
        price: seq.wallPrice,
        side: seq.side,
        title: 'Что уже произошло',
        body: seq.steps
          .slice(0, 2)
          .map(plainStep)
          .join(' → '),
        priority: 85,
      })
    }
  }

  const support = input.whale?.strongestSupport
  const resist = input.whale?.strongestResistance
  if (support && price > 0) {
    const absorbing =
      seq?.kind === 'WALL_ABSORPTION_EXHAUSTION' && seq.side === 'LONG'
    hints.push({
      id: 'whale_bid',
      price: support.price,
      side: 'LONG',
      title: 'Стена снизу · крупные хотят купить',
      body: absorbing
        ? `Продавцы бьют в эту стену, а она пока стоит (−${support.distancePct.toFixed(1)}%, ~$${fmtVol(support.volumeUsd)}). Если удары стихнут — вероятен отскок вверх.`
        : `Крупный лимитный спрос ниже цены (−${support.distancePct.toFixed(1)}%, ~$${fmtVol(support.volumeUsd)}). Это опора. Пока сюда не били продажами — это только «картинка», не сигнал.`,
      priority: 55,
    })
  }
  if (resist && price > 0) {
    const absorbing =
      seq?.kind === 'WALL_ABSORPTION_EXHAUSTION' && seq.side === 'SHORT'
    hints.push({
      id: 'whale_ask',
      price: resist.price,
      side: 'SHORT',
      title: 'Стена сверху · крупные хотят продать',
      body: absorbing
        ? `Покупатели бьют в эту стену, а она пока стоит (+${resist.distancePct.toFixed(1)}%, ~$${fmtVol(resist.volumeUsd)}). Если покупки стихнут — вероятен откат вниз.`
        : `Крупный лимитный сброс выше цены (+${resist.distancePct.toFixed(1)}%, ~$${fmtVol(resist.volumeUsd)}). Это крыша. Жди: пробьют её покупками или отскочат вниз.`,
      priority: 55,
    })
  }

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
      title: `Открытый интерес ${oi.changePct >= 0 ? '+' : ''}${oi.changePct.toFixed(1)}%`,
      body:
        oi.divergenceType === 'DISTRIBUTION'
          ? 'Цена растёт, а новых контрактов меньше — рост «пустой». Не догоняй вверх.'
          : oi.divergenceType === 'SHORT_BUILD'
            ? 'Цена падает, контрактов больше — давят шорты. Лонг от воздуха опасен.'
            : oi.confirmsMove
              ? 'Цена и открытый интерес движутся вместе — в движении реальные деньги.'
              : 'Открытый интерес пока шумит. Нужно совпадение с покупками/продажами.',
      priority: 48,
    })
  }

  const imb = input.bookImbalance
  if (imb != null && Math.abs(imb) >= 18) {
    hints.push({
      id: 'book',
      price: null,
      side: imb > 0 ? 'LONG' : 'SHORT',
      title:
        imb > 0
          ? `В стакане больше желающих купить (${Math.abs(imb).toFixed(0)}%)`
          : `В стакане больше желающих продать (${Math.abs(imb).toFixed(0)}%)`,
      body:
        imb > 0
          ? 'Перевес заявок на покупку. Это ещё не вход — нужен процесс: удары в стену снизу и их иссякание.'
          : 'Перевес заявок на продажу. Смотри стену сверху: снимут её или отобьют цену вниз.',
      priority: 40,
    })
  }

  const frames = getFrames(input.symbol, 5 * 60_000)
  const liqFrames = frames.filter((f) => f.kind === 'LIQ')
  if (liqFrames.length >= 1) {
    const last = liqFrames[liqFrames.length - 1]!
    const shorts = last.side === 'SHORT_LIQ'
    hints.push({
      id: 'liq',
      price: last.price ?? null,
      side: shorts ? 'LONG' : 'SHORT',
      title: shorts
        ? 'Волна ликвидаций шортов'
        : 'Волна ликвидаций лонгов',
      body: shorts
        ? 'Шортов выбило принудительными покупками. Если агрессия покупок сейчас падает — классический exhaustion / разворот вниз после кульминации.'
        : 'Лонгов выбило продажами. Если продажи стихают — вероятен отскок вверх (топливо отработало).',
      priority: 62,
    })
  }

  const hitBuy = frames
    .filter((f) => f.kind === 'HIT' && f.side === 'BUY')
    .reduce((s, f) => s + (f.volumeUsd ?? 0), 0)
  const hitSell = frames
    .filter((f) => f.kind === 'HIT' && f.side === 'SELL')
    .reduce((s, f) => s + (f.volumeUsd ?? 0), 0)
  const health = getCachedSpotPerpHealth(input.symbol, hitBuy - hitSell)
  if (health.status === 'DIVERGED' || health.status === 'PERP_LED') {
    hints.push({
      id: 'spot_perp',
      price: null,
      side: 'INFO',
      title: health.label,
      body: `${health.tip} Уверенность сигналов снижена.`,
      priority: 52,
    })
  } else if (health.status === 'SPOT_LED') {
    hints.push({
      id: 'spot_perp',
      price: null,
      side: health.spotDeltaUsd >= 0 ? 'LONG' : 'SHORT',
      title: 'Спот ведёт перпы',
      body: health.tip,
      priority: 44,
    })
  }

  const hits = frames.filter((f) => f.kind === 'HIT').length
  if (hits >= 4 && !seq) {
    hints.push({
      id: 'film',
      price: null,
      side: 'INFO',
      title: 'Лента активна, предела ещё нет',
      body: `За 5 минут много рыночных сделок, но критической массы у стены нет. Жди: либо стена «съест» удары и они стихнут, либо стену снимут.`,
      priority: 35,
    })
  }

  const primary = input.liveSignal?.primary
  if (primary && primary.side !== 'FLAT') {
    hints.push({
      id: 'action',
      price: input.liveSignal?.bestSetup?.limitEntry ?? null,
      side: primary.side,
      title:
        primary.side === 'LONG'
          ? `Что делать · лонг (~${primary.winPct}%)`
          : `Что делать · шорт (~${primary.winPct}%)`,
      body: `${primary.title}. ${firstSentence(primary.summary)} Не беги за ценой в середине движения — лимитка на реакции.`,
      priority: 90,
    })
  } else if (regime === 'VOLATILE_CHOP') {
    hints.push({
      id: 'wait_chop',
      price: null,
      side: 'INFO',
      title: 'Лучше подождать',
      body: 'Сейчас хаос: обычные сценарии выключены. Либо редкий отскок от очень сильной стены, либо пауза.',
      priority: 80,
    })
  }

  hints.sort((a, b) => b.priority - a.priority)
  return hints.slice(0, 4)
}

function regimeLabel(r: MarketRegime): string {
  switch (r) {
    case 'TRENDING_STRONG':
      return 'сильный тренд'
    case 'TRENDING_WEAK':
      return 'слабый тренд'
    case 'RANGING':
      return 'боковик'
    case 'VOLATILE_CHOP':
      return 'хаос'
  }
}

function regimeHint(r: MarketRegime): string {
  switch (r) {
    case 'TRENDING_STRONG':
      return 'Главный кадр — тренд. Ищи продолжение: сняли стену против тренда или открытый интерес подтверждает ход. Отскоки против тренда — только для наблюдения.'
    case 'TRENDING_WEAK':
      return 'Тренд неуверенный. Можно и отскок от стены, и продолжение. Смотри процесс у стены, не «голову и плечи».'
    case 'RANGING':
      return 'Цена в диапазоне. Работай от стен снизу/сверху (опора и крыша). Не лови середину канала.'
    case 'VOLATILE_CHOP':
      return 'После резкого хода рынок «рваный». Большинство сигналов молчит — дождись спокойного режима.'
  }
}

function kindRu(kind: string): string {
  switch (kind) {
    case 'WALL_ABSORPTION_EXHAUSTION':
      return 'Стена выдержала удары, агрессия стихает'
    case 'CVD_DIVERGENCE_LIMIT':
      return 'Цена и поток сделок разошлись'
    case 'WALL_RELEASE':
      return 'Крупную стену сняли — путь открыт'
    case 'OI_DELTA_CONFIRM':
      return 'Цена + открытый интерес + поток согласованы'
    case 'TRAPPED_TRADERS':
      return 'Толпа заперта у стены — их стопы станут топливом'
    default:
      return kind
  }
}

function plainStep(s: string): string {
  return s
    .replace(/BID/gi, 'стена снизу')
    .replace(/ASK/gi, 'стена сверху')
    .replace(/EATEN/gi, 'снята')
    .replace(/CVD divergence/gi, 'расхождение цены и потока')
    .replace(/Aggression buy/gi, 'доля покупок')
}

function firstSentence(s: string): string {
  const cut = s.split(/[.!?]/)[0]
  return (cut || s).slice(0, 160)
}

function fmtVol(usd: number): string {
  if (usd >= 1_000_000) return `${(usd / 1_000_000).toFixed(1)}M`
  if (usd >= 1_000) return `${(usd / 1_000).toFixed(0)}K`
  return String(Math.round(usd))
}
