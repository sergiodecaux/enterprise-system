/**
 * Flow gate after the cascade. Volume is mandatory.
 * Open interest speaks only when a real series exists.
 * A book wall is a level ahead of the trade, not a whale position.
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { OrderBookWall } from '../types'
import type { DeskBook, DeskSide, DeskTrigger } from './deskBook'
import type { SessionWalk } from './sessionWalk'
import type { OiSnapshot } from '../sequence/oiTracker'

export type FlowVerdict = 'CONFIRM' | 'VETO' | 'WAIT'
export type OiCase = 'NEW_LONGS' | 'NEW_SHORTS' | 'SHORT_COVER' | 'LONG_EXIT' | 'FLAT' | 'UNKNOWN'

export interface FlowCrowd {
  longShortRatio: number
  known: boolean
}

export interface FlowRead {
  verdict: FlowVerdict
  clause: string
  volumeRatio: number | null
  oiCase: OiCase
  confidenceDelta: number
}

export interface FlowInput {
  book: DeskBook
  side: DeskSide | null
  trigger: DeskTrigger
  structural: boolean
  candles15m?: OhlcvCandle[]
  oi?: OiSnapshot | null
  btcOi?: OiSnapshot | null
  /** Buyer share 0–100 from the tape. Absent tape stays silent. */
  buyerPct?: number | null
  /** Signed price change over the same tape window, percent. */
  tapePricePct?: number | null
  walls?: OrderBookWall[] | null
  price: number
  walk?: SessionWalk | null
  crowd?: FlowCrowd | null
}

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2
}

export function oiCaseOf(pricePct: number, oiPct: number): OiCase {
  if (pricePct > 0.08 && oiPct > 0.25) return 'NEW_LONGS'
  if (pricePct < -0.08 && oiPct > 0.25) return 'NEW_SHORTS'
  if (pricePct > 0.08 && oiPct < -0.25) return 'SHORT_COVER'
  if (pricePct < -0.08 && oiPct < -0.25) return 'LONG_EXIT'
  return 'FLAT'
}

function volumeRatio(candles: OhlcvCandle[] | undefined): number | null {
  if (!candles || candles.length < 12) return null
  const vols = candles.slice(0, -1).slice(-20).map((c) => c[5]).filter((v) => v > 0)
  const last = candles[candles.length - 1]?.[5] ?? 0
  const mid = median(vols)
  if (!(mid > 0) || !(last > 0)) return null
  return last / mid
}

function absorptionClause(
  candles: OhlcvCandle[] | undefined,
  side: DeskSide
): string | null {
  if (!candles || candles.length < 8) return null
  const prev = candles.slice(0, -1).slice(-20)
  const mid = median(prev.map((c) => c[5]).filter((v) => v > 0))
  const last = candles[candles.length - 1]
  if (!last || !(mid > 0) || last[5] < mid * 1.3) return null
  const range = last[2] - last[3]
  if (!(range > 0)) return null
  const body = Math.abs(last[4] - last[1]) / range
  if (body >= 0.35) return null
  const closePos = (last[4] - last[3]) / range
  if (closePos >= 0.65 && side === 'SHORT') return 'объём удержался у хая — продажи поглотили, шорт гаснет'
  if (closePos <= 0.35 && side === 'LONG') return 'объём удержался у лоя — покупки поглотили, лонг гаснет'
  if (closePos > 0.35 && closePos < 0.65) return 'большой объём и малое тело — сторона не принята'
  return null
}

function tapeVeto(input: FlowInput): string | null {
  const buy = input.buyerPct
  const px = input.tapePricePct
  if (buy == null || px == null || !input.side) return null
  if (input.side === 'LONG' && buy >= 80 && px < 0.15) {
    return 'лента покупает, цена стоит — лонг гаснет'
  }
  if (input.side === 'SHORT' && buy <= 20 && px > -0.15) {
    return 'лента продаёт, цена стоит — шорт гаснет'
  }
  return null
}

function wallAhead(input: FlowInput, reach: number): string | null {
  if (!input.side || !(input.price > 0) || !(reach > 0)) return null
  const walls = input.walls ?? []
  const ratios = walls.map((w) => w.ratio).filter((r) => r > 0)
  const thick = Math.max(3, median(ratios) * 2)
  const side = input.side
  const hit = walls.find((w) => {
    if (!(w.price > 0) || w.ratio < thick) return false
    const dist = Math.abs(w.price - input.price)
    if (dist > reach) return false
    if (side === 'LONG') return w.side === 'ASK' && w.price > input.price
    return w.side === 'BID' && w.price < input.price
  })
  if (!hit) return null
  return side === 'LONG'
    ? `впереди крупный оффер ×${hit.ratio.toFixed(1)} — ждём принятие стены`
    : `впереди крупный бид ×${hit.ratio.toFixed(1)} — ждём принятие стены`
}

function sessionAgainst(walk: SessionWalk | null | undefined, side: DeskSide, trigger: DeskTrigger): string | null {
  if (!walk || walk.samples < 8 || trigger === 'SWEEP_RETURN') return null
  if (walk.upShare >= 0.65 && walk.medianNet > 0 && side === 'SHORT') {
    return `${walk.label} закрывается вверх в ${Math.round(walk.upShare * 100)}% случаев — шорт с закрепа против сессии не берём`
  }
  if (walk.upShare <= 0.35 && walk.medianNet < 0 && side === 'LONG') {
    return `${walk.label} закрывается вниз в ${Math.round((1 - walk.upShare) * 100)}% случаев — лонг с закрепа против сессии не берём`
  }
  return null
}

function crowdNote(input: FlowInput): { text: string | null; delta: number } {
  if (input.book === 'COMMODITY' || !input.crowd?.known || !input.side) {
    return { text: null, delta: 0 }
  }
  const ratio = input.crowd.longShortRatio
  if (!(ratio > 0) || Math.abs(ratio - 1) < 0.08) return { text: null, delta: 0 }
  const crowdLong = ratio >= 2.2
  const crowdShort = ratio <= 0.55
  if (input.side === 'LONG' && crowdLong) {
    return { text: 'счета уже сильно в лонге — уверенность ниже', delta: -8 }
  }
  if (input.side === 'SHORT' && crowdShort) {
    return { text: 'счета уже сильно в шорте — уверенность ниже', delta: -8 }
  }
  return { text: null, delta: 0 }
}

export function readFlow(input: FlowInput): FlowRead {
  const none = (verdict: FlowVerdict, clause: string, extra?: Partial<FlowRead>): FlowRead => ({
    verdict,
    clause,
    volumeRatio: extra?.volumeRatio ?? null,
    oiCase: extra?.oiCase ?? 'UNKNOWN',
    confidenceDelta: extra?.confidenceDelta ?? 0,
  })

  if (!input.structural || !input.side || input.trigger === 'WAIT') {
    return none('WAIT', '')
  }

  const ratio = volumeRatio(input.candles15m)
  if (ratio == null) return none('WAIT', 'Нет ряда объёма 15м — путь не рисуем.')
  if (ratio < 1) {
    return none('VETO', `Объём 15м ${ratio.toFixed(2)} от своей медианы — пустая свеча, входа нет.`, {
      volumeRatio: ratio,
    })
  }

  const absorbed = absorptionClause(input.candles15m, input.side) ?? tapeVeto(input)
  if (absorbed) return none('VETO', absorbed, { volumeRatio: ratio })

  const oi = input.oi
  const oiCase = oi && oi.samples >= 3 ? oiCaseOf(oi.priceChangePct, oi.changePct) : 'UNKNOWN'
  if (input.side === 'SHORT' && oiCase === 'LONG_EXIT') {
    return none('VETO', 'Интерес падает вместе с ценой — лонги уже вышли, шорт продолжения нет.', {
      volumeRatio: ratio,
      oiCase,
    })
  }
  if (input.side === 'LONG' && oiCase === 'SHORT_COVER' && ratio < 1.15) {
    return none('VETO', 'Цена вверх при падающем интересе — это закрытие шортов, объёма на новый лонг мало.', {
      volumeRatio: ratio,
      oiCase,
    })
  }
  if (input.book === 'ALT' && input.side === 'LONG' && input.btcOi && input.btcOi.samples >= 3) {
    const btc = oiCaseOf(input.btcOi.priceChangePct, input.btcOi.changePct)
    if (btc === 'NEW_SHORTS' || btc === 'LONG_EXIT') {
      return none('VETO', 'Интерес биткоина идёт против лонга альта.', {
        volumeRatio: ratio,
        oiCase,
      })
    }
  }

  const walk = input.walk
  if (walk?.spent && input.trigger === 'ACCEPT') {
    return none('WAIT', walk.line, { volumeRatio: ratio, oiCase })
  }
  const against = sessionAgainst(walk, input.side, input.trigger)
  if (against) return none('WAIT', against, { volumeRatio: ratio, oiCase })

  const reach = walk && walk.remaining > 0 ? walk.remaining : input.price * 0.004
  const wall = wallAhead(input, reach)
  if (wall) return none('WAIT', wall, { volumeRatio: ratio, oiCase })

  const crowd = crowdNote(input)
  const oiBit =
    oiCase === 'NEW_LONGS'
      ? 'интерес растёт с ценой'
      : oiCase === 'NEW_SHORTS'
        ? 'интерес растёт на снижении'
        : oiCase === 'SHORT_COVER'
          ? 'рост на закрытии шортов'
          : oiCase === 'LONG_EXIT'
            ? 'снижение на выходе лонгов'
            : 'ряда интереса нет'
  const bits = [`объём 15м ×${ratio.toFixed(2)} к медиане`, oiBit]
  if (walk && walk.samples >= 4) bits.push(walk.line)
  if (crowd.text) bits.push(crowd.text)
  const delta =
    (oiCase === 'NEW_LONGS' && input.side === 'LONG') ||
    (oiCase === 'NEW_SHORTS' && input.side === 'SHORT')
      ? 8
      : 0
  return none('CONFIRM', bits.join('. ') + '.', {
    volumeRatio: ratio,
    oiCase,
    confidenceDelta: delta + crowd.delta,
  })
}
