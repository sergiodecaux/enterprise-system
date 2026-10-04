/**
 * Human-readable Russian copy for Elite favorites digest,
 * urgent alerts and chart-snapshot captions.
 * Keep facts, drop the spreadsheet tone.
 */

import type { CoinBriefRow } from './briefing'

export function fmtHumanPx(n: number): string {
  if (!(n > 0) || !Number.isFinite(n)) return '—'
  if (n >= 1000) return String(Math.round(n))
  if (n >= 100) return trimNum(n.toFixed(1))
  if (n >= 1) return trimNum(n.toFixed(3))
  return trimNum(n.toPrecision(4))
}

function trimNum(s: string): string {
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

export function sideWord(side: 'LONG' | 'SHORT' | null | undefined): string {
  if (side === 'SHORT') return 'шорт'
  if (side === 'LONG') return 'лонг'
  return 'сделка'
}

function zoneOf(side: 'LONG' | 'SHORT'): string {
  return side === 'SHORT' ? 'шорта' : 'лонга'
}

export function tickerOf(symbol: string): string {
  return symbol.replace(/_USDT$/i, '').replace('/', '')
}

function moveHint(chg15: number): string | null {
  if (!Number.isFinite(chg15) || Math.abs(chg15) < 0.7) return null
  if (chg15 >= 2) return 'за четверть часа заметно выросла'
  if (chg15 >= 0.7) return 'за четверть часа чуть подросла'
  if (chg15 <= -2) return 'за четверть часа заметно сдала'
  return 'за четверть часа чуть сдала'
}

function storyOf(row: CoinBriefRow) {
  return (
    row.story ?? {
      side: null,
      phase: null,
      align: null,
      style: null,
      entry: null,
      target: null,
      ssl: null,
      bsl: null,
      quiet: true,
    }
  )
}

/** 2–4 short lines per favorite coin. First line always starts with ticker. */
export function formatFavoriteCoinLines(
  row: CoinBriefRow,
  opts?: { urgentRecent?: boolean }
): string[] {
  const story = storyOf(row)
  const px = fmtHumanPx(row.price)
  const move = moveHint(row.chg15)
  const now = move ? `Сейчас около ${px}, ${move}.` : `Сейчас около ${px}.`

  if (opts?.urgentRecent) {
    return [
      `${row.base} — недавно был срочный алерт, смотри его.`,
      `Цена около ${px}. Новой картины в сводке нет.`,
    ]
  }

  if (story.quiet || !story.side) {
    const bias =
      row.bias4h === 'BULL'
        ? 'Тон скорее лонговый, но зоны рядом нет.'
        : row.bias4h === 'BEAR'
          ? 'Тон скорее шортовый, но зоны рядом нет.'
          : 'Явной зоны нет — просто смотрим.'
    return [`${row.base} тихо, около ${px}. ${bias}`]
  }

  const side = sideWord(story.side)
  const lines: string[] = []

  if (story.phase === 'TOUCH' && story.align === 'WAIT') {
    lines.push(`${row.base} спокойно держится в зоне ${zoneOf(story.side)}. ${now}`)
  } else if (story.phase === 'TOUCH') {
    lines.push(`${row.base} уже в зоне ${zoneOf(story.side)}. ${now}`)
  } else if (story.phase === 'APPROACH') {
    lines.push(`${row.base} подходит к зоне ${zoneOf(story.side)}. ${now}`)
  } else if (row.bias4h === 'FLAT' && row.bias1h === 'FLAT') {
    lines.push(`${row.base} в боковике, ближе к зоне ${zoneOf(story.side)}. ${now}`)
  } else if (story.side === 'LONG') {
    lines.push(`${row.base} спокойно держится в лонговом тоне. ${now}`)
  } else {
    lines.push(`${row.base} слабее, тон шортовый. ${now}`)
  }

  const fuel = fuelSentence(row.price, story.side, story.ssl, story.bsl)
  if (fuel) lines.push(fuel)

  if (story.entry && story.target && story.phase === 'TOUCH' && story.align === 'WITH') {
    lines.push(
      `Можно смотреть ${side} от ${fmtHumanPx(story.entry)}, цель около ${fmtHumanPx(story.target)}. Не догонять.`
    )
  } else if (story.phase === 'TOUCH' && story.align === 'WAIT') {
    lines.push('Цена у зоны, но старший тон против — это не вход.')
  } else if (story.entry && story.target && story.phase === 'APPROACH' && story.align === 'WITH') {
    lines.push(
      `Ждём зону около ${fmtHumanPx(story.entry)}, цель ${fmtHumanPx(story.target)}. Это не вход прямо сейчас.`
    )
  } else {
    lines.push('Это не вход прямо сейчас.')
  }

  return lines.slice(0, 4)
}

function fuelSentence(
  price: number,
  side: 'LONG' | 'SHORT',
  ssl: number | null,
  bsl: number | null
): string | null {
  if (side === 'LONG' && ssl && ssl < price) {
    if (bsl && bsl > price) {
      return 'Топливо ещё ниже — могут сходить снять лои, потом искать рост к магниту сверху.'
    }
    return 'Топливо ещё ниже — могут сходить снять лои, потом искать рост.'
  }
  if (side === 'SHORT' && bsl && bsl > price) {
    if (ssl && ssl < price) {
      return 'Топливо ещё выше — могут сходить снять хаи, потом искать падение к магниту снизу.'
    }
    return 'Топливо ещё выше — могут сходить снять хаи, потом искать падение.'
  }
  return null
}

export function formatFavoriteCoinHtml(
  row: CoinBriefRow,
  opts?: { urgentRecent?: boolean }
): string {
  const lines = formatFavoriteCoinLines(row, opts)
  if (!lines.length) return ''
  const [first, ...rest] = lines
  const headed = first.startsWith(row.base)
    ? `<b>${row.base}</b>${first.slice(row.base.length)}`
    : `<b>${row.base}</b> ${first}`
  return [headed, ...rest].join('\n')
}

export const DIGEST_FOOTER =
  'Это не сигнал. Выключить сводку: /digest_off'

export function formatWatchUrgent(opts: {
  kind: 'READY' | 'TOUCH' | 'INVALIDATED' | 'ARMED'
  symbol: string
  side: 'LONG' | 'SHORT'
  price?: number
  entry?: number
  target?: number
}): { title: string; text: string } {
  const ticker = tickerOf(opts.symbol)
  const side = sideWord(opts.side)
  const entry = opts.entry && opts.entry > 0 ? fmtHumanPx(opts.entry) : null
  const target = opts.target && opts.target > 0 ? fmtHumanPx(opts.target) : null
  const price = opts.price && opts.price > 0 ? fmtHumanPx(opts.price) : null
  const chase =
    opts.side === 'LONG' ? 'Не догонять выше.' : 'Не догонять ниже.'

  if (opts.kind === 'READY') {
    const where =
      entry && target
        ? `Вход около ${entry}, цель ${target}.`
        : entry
          ? `Вход около ${entry}.`
          : price
            ? `Цена около ${price}.`
            : 'Зона подтвердилась.'
    return {
      title: `${ticker} — можно ${side}`,
      text: `${where} Цена уже в зоне. ${chase} Не сигнал.`,
    }
  }

  if (opts.kind === 'TOUCH') {
    const where = entry ?? price
    return {
      title: `${ticker} у зоны ${zoneOf(opts.side)}`,
      text: where
        ? `Подошёл к зоне около ${where}. Ждём реакцию — вход ещё не готов.`
        : 'Подошёл к зоне. Ждём реакцию — вход ещё не готов.',
    }
  }

  if (opts.kind === 'ARMED') {
    const where =
      entry && target
        ? `${side[0]!.toUpperCase()}${side.slice(1)} от ${entry}, цель ${target}.`
        : `Слежу за идеей ${zoneOf(opts.side)}.`
    return {
      title: `Слежу за ${ticker}`,
      text: `${where} Пока только слежение — когда зона подтвердится, придёт отдельный алерт.`,
    }
  }

  return {
    title: `${ticker} ${side} снят`,
    text: price
      ? `Цена ушла около ${price} — идея больше не жива.`
      : 'Цена ушла через стоп, идея больше не жива.',
  }
}

const MOMENT_KIND: Record<string, string> = {
  ABSORPTION_LONG: 'в стакане поглощают продажи',
  ABSORPTION_SHORT: 'в стакане поглощают покупки',
  CVD_DIVERGENCE: 'лента расходится с ценой',
  ASK_WALL_REMOVED: 'сняли стенку продаж',
  BID_WALL_REMOVED: 'сняли стенку покупок',
  BUY_FLOW_IMBALANCE: 'покупатели перетягивают ленту',
  SELL_FLOW_IMBALANCE: 'продавцы перетягивают ленту',
}

export function formatMomentUrgent(opts: {
  symbol: string
  side: 'LONG' | 'SHORT'
  kind: string
}): { title: string; text: string } {
  const ticker = tickerOf(opts.symbol)
  const side = sideWord(opts.side)
  const what = MOMENT_KIND[opts.kind] ?? 'в стакане появилось топливо'
  return {
    title: `${ticker} — ${side}-момент в стакане`,
    text: `${what[0]!.toUpperCase()}${what.slice(1)}. Это топливо у зоны, не готовый вход.`,
  }
}

export function formatSniperFavoriteUrgent(opts: {
  symbol: string
  side: 'LONG' | 'SHORT'
  entry?: number
  target?: number
  chased?: boolean
}): { title: string; text: string } {
  const ticker = tickerOf(opts.symbol)
  const side = sideWord(opts.side)
  const entry = opts.entry && opts.entry > 0 ? fmtHumanPx(opts.entry) : null
  const target = opts.target && opts.target > 0 ? fmtHumanPx(opts.target) : null
  const chase =
    opts.side === 'LONG' ? 'Не догонять выше.' : 'Не догонять ниже.'

  if (opts.chased) {
    return {
      title: `${ticker} ушёл от зоны ${zoneOf(opts.side)}`,
      text: entry
        ? `Не догонять — ждём откат к входу около ${entry}.`
        : `Не догонять — ждём откат в зону.`,
    }
  }

  const where =
    entry && target
      ? `Вход около ${entry}, цель ${target}.`
      : entry
        ? `Вход около ${entry}.`
        : `Можно смотреть ${side}.`
  return {
    title: `${ticker} — можно ${side}`,
    text: `${where} ${chase} Не сигнал.`,
  }
}

/** One short HTML paragraph for sendPhoto caption. */
export function formatSnapshotCaption(opts: {
  symbol: string
  side?: 'LONG' | 'SHORT' | null
  kind?: 'READY' | 'TOUCH' | 'INVALIDATED' | 'MOMENT' | 'DIGEST' | 'SNIPER'
  entry?: number | null
  target?: number | null
  price?: number | null
}): string {
  const ticker = tickerOf(opts.symbol)
  const side = sideWord(opts.side)
  const entry = opts.entry && opts.entry > 0 ? fmtHumanPx(opts.entry) : null
  const target = opts.target && opts.target > 0 ? fmtHumanPx(opts.target) : null
  const price = opts.price && opts.price > 0 ? fmtHumanPx(opts.price) : null
  const head = `<b>${ticker}</b>`

  if (opts.kind === 'READY' || opts.kind === 'SNIPER') {
    const where =
      entry && target
        ? `можно ${side} от ${entry}, цель ${target}`
        : `можно ${side}`
    return `${head} — ${where}. Цена в зоне, не догонять.`
  }
  if (opts.kind === 'TOUCH') {
    const z = opts.side ? zoneOf(opts.side) : 'входа'
    const where = entry ?? price
    return where
      ? `${head} подошёл к зоне ${z} около ${where}. Ждём реакцию — вход ещё не готов.`
      : `${head} подошёл к зоне ${z}. Ждём реакцию — вход ещё не готов.`
  }
  if (opts.kind === 'MOMENT') {
    return `${head} — ${side}-момент в стакане. Топливо есть, готового входа нет.`
  }
  if (opts.kind === 'INVALIDATED') {
    return `${head} ${side} снят — идея больше не жива.`
  }
  if (entry && target) {
    return `${head} — живой ${side} от ${entry}, цель ${target}. Смотри зону, не догоняй.`
  }
  return `${head} — живой сетап на ${side}. Смотри зону на снимке.`
}
