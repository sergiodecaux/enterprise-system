import type { OhlcvCandle } from '../../api/mexc'
import { calculateHtfInvalidation } from '../confidence/invalidation'
import type { ConditionalSetup, ConditionalSetupStatus, SetupPrecondition } from './types'

export interface SetupEvalCandles {
  price: number
  ohlcv1m?: OhlcvCandle[] | null
  ohlcv5m?: OhlcvCandle[] | null
  ohlcv1h?: OhlcvCandle[] | null
  ohlcv4h?: OhlcvCandle[] | null
}

function wickSweptMicro(
  candles: OhlcvCandle[],
  micro: number,
  side: 'LONG' | 'SHORT'
): boolean {
  const slice = candles.slice(-40)
  for (const c of slice) {
    const [, , high, low, close] = c
    if (side === 'LONG' && low <= micro * 1.001 && close > micro * 0.999) {
      return true
    }
    if (side === 'SHORT' && high >= micro * 0.999 && close < micro * 1.001) {
      return true
    }
  }
  return false
}

function priceInZone(
  price: number,
  zone: { top: number; bottom: number }
): boolean {
  return price >= zone.bottom * 0.997 && price <= zone.top * 1.003
}

function reclaimAfterSweep(
  candles: OhlcvCandle[],
  side: 'LONG' | 'SHORT',
  micro: number
): boolean {
  if (candles.length < 3) return false
  const last = candles[candles.length - 1][4]
  return side === 'LONG' ? last > micro : last < micro
}

/**
 * Обновляет статус условного сетапа по свечам (клиент + логика для worker-порта).
 */
export function evaluateSetupReadiness(
  setup: ConditionalSetup,
  candles: SetupEvalCandles
): ConditionalSetup {
  const { price } = candles
  const ltf = candles.ohlcv1m?.length
    ? candles.ohlcv1m
    : candles.ohlcv5m ?? []

  // HTF break → invalidated
  if (candles.ohlcv4h?.length) {
    const inv4 = calculateHtfInvalidation(candles.ohlcv4h, setup.side, '4h')
    if (inv4?.breached) {
      return {
        ...setup,
        status: 'INVALIDATED',
        preconditions: setup.preconditions.map((p) =>
          p.id === 'htf' ? { ...p, status: 'FAILED' as const } : p
        ),
      }
    }
  }
  if (candles.ohlcv1h?.length) {
    const inv1 = calculateHtfInvalidation(candles.ohlcv1h, setup.side, '1h')
    if (inv1?.breached) {
      return {
        ...setup,
        status: 'INVALIDATED',
        preconditions: setup.preconditions.map((p) =>
          p.id === 'htf' ? { ...p, status: 'FAILED' as const } : p
        ),
      }
    }
  }

  // Hard invalidation price
  if (
    (setup.side === 'LONG' && price < setup.invalidation) ||
    (setup.side === 'SHORT' && price > setup.invalidation)
  ) {
    return { ...setup, status: 'INVALIDATED' }
  }

  const preconditions: SetupPrecondition[] = setup.preconditions.map((p) => {
    let status = p.status
    if (p.id === 'touch' || p.id === 'zone') {
      status = priceInZone(price, setup.entryZone) ? 'MET' : 'PENDING'
    }
    if (p.id === 'sweep' || p.id === 'stop_hunt') {
      const micro =
        setup.kind === 'BOUNCE_SSL' || setup.kind === 'BOUNCE_BSL'
          ? setup.entryZone.bottom
          : setup.limitEntry
      status =
        ltf.length && wickSweptMicro(ltf, micro, setup.side)
          ? 'MET'
          : status === 'MET'
            ? 'MET'
            : 'PENDING'
    }
    if (p.id === 'reject' || p.id === 'confirm' || p.id === 'flip') {
      const swept = setup.preconditions.find(
        (x) => x.id === 'sweep' || x.id === 'stop_hunt' || x.id === 'touch'
      )
      if (swept?.status === 'MET' || status === 'MET') {
        const micro = setup.limitEntry
        status = reclaimAfterSweep(ltf, setup.side, micro) ? 'MET' : status
      }
    }
    if (p.id === 'limit' || p.id === 'entry') {
      status = priceInZone(price, setup.entryZone) ? 'MET' : 'PENDING'
    }
    return { ...p, status }
  })

  let status: ConditionalSetupStatus = 'HYPOTHESIS'
  if (preconditions.some((p) => p.status === 'FAILED')) status = 'INVALIDATED'
  else if (
    preconditions.length > 0 &&
    preconditions.every((p) => p.status === 'MET')
  ) {
    status = 'READY'
  } else if (preconditions.some((p) => p.status === 'MET')) {
    status = 'ARMED'
  }

  // Forecast / bounce: READY when in zone after touch+reject met
  if (
    (setup.kind.startsWith('FORECAST') ||
      setup.kind === 'BOUNCE_SSL' ||
      setup.kind === 'BOUNCE_BSL') &&
    priceInZone(price, setup.entryZone) &&
    !preconditions.some((p) => p.status === 'FAILED')
  ) {
    const needReject = preconditions.find((p) => p.id === 'reject')
    if (!needReject || needReject.status === 'MET') {
      if (
        setup.kind.startsWith('FORECAST') ||
        (needReject && needReject.status === 'MET')
      ) {
        const zonePre = preconditions.find((p) => p.id === 'zone' || p.id === 'touch')
        if (zonePre?.status === 'MET' || setup.kind.startsWith('FORECAST')) {
          if (
            setup.kind.startsWith('FORECAST') &&
            priceInZone(price, setup.entryZone)
          ) {
            status = 'READY'
          }
        }
      }
    }
  }

  return { ...setup, preconditions, status }
}
