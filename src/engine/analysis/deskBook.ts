/**
 * One live read after the cascade.
 * Week + day name the side. 4H names the location in that leg.
 * 15m only confirms the entry. It never rewrites the side.
 *
 * Gold, silver and oil accept value. Bitcoin and alts trade a hunt
 * only after the higher timeframe already named the pool.
 */

import type { OhlcvCandle } from '../../api/mexc'
import { isCommoditySymbol } from '../../api/mexc'
import type { AltBias, AltRegime } from '../../api/marketContext'

export type DeskBook = 'COMMODITY' | 'BTC' | 'ALT'
export type CommodityKind = 'GOLD' | 'SILVER' | 'OIL'
export type DeskLocation = 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM'
export type DeskTrigger = 'ACCEPT' | 'SWEEP_RETURN' | 'WAIT'
export type DeskSide = 'LONG' | 'SHORT'

export interface DeskTf {
  trend: 'BULLISH' | 'BEARISH' | 'RANGING'
  inPremium: boolean
  inDiscount: boolean
  nextBsl: number | null
  nextSsl: number | null
}

export interface SituationRead {
  book: DeskBook
  commodity: CommodityKind | null
  htfSide: DeskSide | null
  location: DeskLocation
  trigger: DeskTrigger
  tradable: boolean
  line: string
}

export interface SituationInput {
  symbol?: string | null
  isBtc?: boolean
  w1: DeskTf | null
  d1: DeskTf | null
  h4: DeskTf | null
  h1: DeskTf | null
  candles15m?: OhlcvCandle[]
  altBias?: AltBias | null
  altRegime?: AltRegime | null
  btcRs?: number | null
}

export function commodityKindOf(symbol: string | null | undefined): CommodityKind | null {
  if (!symbol || !isCommoditySymbol(symbol)) return null
  const s = symbol.toUpperCase()
  if (s.includes('SILVER') || s.includes('XAG')) return 'SILVER'
  if (s.includes('USOIL') || s.includes('WTI') || s.includes('OIL')) return 'OIL'
  return 'GOLD'
}

export function resolveDeskBook(symbol: string | null | undefined, isBtc = false): DeskBook {
  if (commodityKindOf(symbol)) return 'COMMODITY'
  if (isBtc) return 'BTC'
  const base = (symbol ?? '')
    .toUpperCase()
    .replace('/USDT:USDT', '')
    .replace('/USDT', '')
    .replace('_USDT', '')
    .replace('USDT', '')
  if (base === 'BTC' || base === 'XBT') return 'BTC'
  return 'ALT'
}

function bookTitle(book: DeskBook, commodity: CommodityKind | null): string {
  if (commodity === 'GOLD') return 'Золото'
  if (commodity === 'SILVER') return 'Серебро'
  if (commodity === 'OIL') return 'Нефть'
  if (book === 'BTC') return 'Биткоин'
  return 'Альт'
}

function sideWord(side: DeskSide | null): string {
  if (side === 'LONG') return 'бычьи'
  if (side === 'SHORT') return 'медвежьи'
  return 'без стороны'
}

function locationWord(loc: DeskLocation): string {
  if (loc === 'PREMIUM') return 'премиум 4ч'
  if (loc === 'DISCOUNT') return 'дисконт 4ч'
  return 'равновесие 4ч'
}

function tfSign(tf: DeskTf | null): 1 | -1 | 0 {
  if (!tf || tf.trend === 'RANGING') return 0
  return tf.trend === 'BULLISH' ? 1 : -1
}

/** Week and day only. A disagreement is no side. */
export function htfSideOf(w1: DeskTf | null, d1: DeskTf | null): DeskSide | null {
  const w = tfSign(w1)
  const d = tfSign(d1)
  if (w !== 0 && d !== 0 && w !== d) return null
  const s = w !== 0 ? w : d
  if (s > 0) return 'LONG'
  if (s < 0) return 'SHORT'
  return null
}

function locationOf(h4: DeskTf | null, h1: DeskTf | null): DeskLocation {
  const tf = h4 ?? h1
  if (!tf) return 'EQUILIBRIUM'
  if (tf.inPremium) return 'PREMIUM'
  if (tf.inDiscount) return 'DISCOUNT'
  return 'EQUILIBRIUM'
}

function legAgrees(h4: DeskTf | null, side: DeskSide): boolean {
  if (!h4 || h4.trend === 'RANGING') return true
  if (side === 'LONG') return h4.trend === 'BULLISH'
  return h4.trend === 'BEARISH'
}

function displacement(c: OhlcvCandle): 1 | -1 | 0 {
  const range = c[2] - c[3]
  if (!(range > 0)) return 0
  const body = Math.abs(c[4] - c[1]) / range
  const closePos = (c[4] - c[3]) / range
  if (body >= 0.55 && closePos >= 0.62 && c[4] > c[1]) return 1
  if (body >= 0.55 && closePos <= 0.38 && c[4] < c[1]) return -1
  return 0
}

function rejection(c: OhlcvCandle): 1 | -1 | 0 {
  const range = c[2] - c[3]
  if (!(range > 0)) return 0
  const upper = c[2] - Math.max(c[1], c[4])
  const lower = Math.min(c[1], c[4]) - c[3]
  const mid = (c[2] + c[3]) / 2
  if (lower / range >= 0.45 && c[4] > mid && c[4] >= c[1]) return 1
  if (upper / range >= 0.45 && c[4] < mid && c[4] <= c[1]) return -1
  return 0
}

function lastAgrees(candles: OhlcvCandle[] | undefined, side: DeskSide, pins: boolean): boolean {
  const c = candles?.[candles.length - 1]
  if (!c) return false
  const want = side === 'LONG' ? 1 : -1
  if (displacement(c) === want) return true
  return pins && rejection(c) === want
}

function sweepReturn(
  candles: OhlcvCandle[] | undefined,
  level: number | null | undefined,
  side: DeskSide
): boolean {
  if (!candles || candles.length < 4 || level == null || !(level > 0)) return false
  const recent = candles.slice(-8)
  for (let i = 0; i < recent.length; i++) {
    const c = recent[i]
    if (!c) continue
    const swept = side === 'LONG' ? c[3] < level && c[4] > level : c[2] > level && c[4] < level
    if (!swept) continue
    const after = recent.slice(i)
    const want = side === 'LONG' ? 1 : -1
    if (after.some((bar) => displacement(bar) === want)) return true
  }
  return false
}

function poolFor(side: DeskSide, h1: DeskTf | null, h4: DeskTf | null): number | null {
  if (side === 'LONG') return h4?.nextSsl ?? h1?.nextSsl ?? null
  return h4?.nextBsl ?? h1?.nextBsl ?? null
}

function locationFits(book: DeskBook, side: DeskSide, location: DeskLocation): boolean {
  if (side === 'LONG') {
    if (location === 'DISCOUNT') return true
    if (location === 'EQUILIBRIUM') return book !== 'ALT'
    return false
  }
  if (location === 'PREMIUM') return true
  if (location === 'EQUILIBRIUM') return book !== 'ALT'
  return false
}

function altBlock(
  side: DeskSide,
  altBias: AltBias | null | undefined,
  altRegime: AltRegime | null | undefined,
  btcRs: number | null | undefined
): string | null {
  if (side === 'LONG') {
    if (altRegime === 'ALT_OFF' || altRegime === 'RISK_OFF') {
      return 'фон альтов выключен — лонг не читается'
    }
    if (btcRs != null && btcRs <= -1.5) {
      return 'альт слабее биткоина — лонг не читается'
    }
    if (altBias === 'SHORT') return 'день биткоина против лонга альта'
  }
  return null
}

function commodityTail(kind: CommodityKind | null, tradable: boolean): string {
  if (!tradable || !kind) return ''
  if (kind === 'SILVER') return ' Серебро шире золота: стоп от ATR ноги, не от фитиля.'
  if (kind === 'OIL') return ' Нефть держит тренд дня. Фитиль новости сам по себе не разворот.'
  return ' Стоп за принятым уровнем, от ATR дня.'
}

export function readSituation(input: SituationInput): SituationRead {
  const book = resolveDeskBook(input.symbol, input.isBtc)
  const commodity = commodityKindOf(input.symbol)
  const title = bookTitle(book, commodity)
  const htfSide = htfSideOf(input.w1, input.d1)
  const location = locationOf(input.h4, input.h1)
  const empty = (line: string): SituationRead => ({
    book,
    commodity,
    htfSide,
    location,
    trigger: 'WAIT',
    tradable: false,
    line,
  })

  if (!htfSide) {
    return empty(
      `${title}. Неделя и день не дают одну сторону — 15м направление не ставит.`
    )
  }

  const legOk = legAgrees(input.h4, htfSide)
  if (!legOk) {
    return empty(
      `${title}. Неделя и день ${sideWord(htfSide)}, 4ч против них. Это откат, пока 4ч не примет ту же сторону.`
    )
  }

  const m15 = input.candles15m
  if (!m15 || m15.length < 4) {
    return empty(
      `${title}. Неделя и день ${sideWord(htfSide)}, ${locationWord(location)}. Ждём закрытие 15м.`
    )
  }

  const pool = poolFor(htfSide, input.h1, input.h4)
  const swept = book !== 'COMMODITY' && sweepReturn(m15, pool, htfSide)
  const pins = book === 'COMMODITY'
  const accepted = lastAgrees(m15, htfSide, pins)
  const trigger: DeskTrigger = swept ? 'SWEEP_RETURN' : accepted ? 'ACCEPT' : 'WAIT'

  if (trigger === 'WAIT') {
    const wait =
      book === 'COMMODITY'
        ? `${title}. Неделя и день ${sideWord(htfSide)}, ${locationWord(location)}. Фитиль без закрепа 15м — входа нет.`
        : `${title}. Неделя и день ${sideWord(htfSide)}, ${locationWord(location)}. 15м не показал закреп или возврат после снятия пула.`
    return empty(wait)
  }

  if (!locationFits(book, htfSide, location)) {
    const where = htfSide === 'LONG' ? 'дисконт' : 'премиум'
    return empty(
      book === 'ALT'
        ? `${title}. Старшие ${sideWord(htfSide)}, цена не в ${where === 'дисконт' ? 'дисконте' : 'премиуме'} ноги. Середина для альта не вход.`
        : `${title}. Старшие ${sideWord(htfSide)}, но цена не в рабочей половине ноги (${locationWord(location)}). Ждём ${where}.`
    )
  }

  if (book === 'ALT') {
    const block = altBlock(htfSide, input.altBias, input.altRegime, input.btcRs)
    if (block) {
      return empty(`${title}. Свой каскад собран, но ${block}.`)
    }
  }

  const how =
    trigger === 'SWEEP_RETURN'
      ? '15м снял пул и закрылся обратно'
      : book === 'COMMODITY'
        ? '15м принял уровень закрытием'
        : '15м закрепил сторону старших'
  const action = htfSide === 'LONG' ? 'лонг' : 'шорт'
  return {
    book,
    commodity,
    htfSide,
    location,
    trigger,
    tradable: true,
    line: `${title}. Неделя и день ${sideWord(htfSide)}, ${locationWord(location)}. ${how} — рабочий ${action}.${commodityTail(commodity, true)}`,
  }
}
