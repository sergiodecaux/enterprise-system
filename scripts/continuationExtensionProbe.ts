/**
 * One-off check: continuation 141 vs the Aug 2024 manual BTC extension.
 * Not imported by the app.
 */
import type { OhlcvCandle } from '../src/api/mexc'
import {
  buildContinuationExtension,
  continuationLevels,
  readContinuationReaction,
} from '../src/engine/smc/continuationExtension'
import { buildGlobalFibonacci } from '../src/engine/zones/globalFibonacci'

async function binance4h(start: number, end: number): Promise<OhlcvCandle[]> {
  const url =
    `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=4h` +
    `&startTime=${start}&endTime=${end}&limit=1500`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`binance ${res.status}`)
  const rows = (await res.json()) as unknown[][]
  return rows.map((r) => [
    Number(r[0]),
    Number(r[1]),
    Number(r[2]),
    Number(r[3]),
    Number(r[4]),
    Number(r[5]),
  ])
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

const manualP = 60301.5
const manualE = 65000
const manual = continuationLevels(manualP, manualE, 'UP')
console.log('formula on the reference wicks', {
  P: manualP,
  E: manualE,
  level141: Math.round(manual.level141),
  level161: Math.round(manual.level161),
  expect141: 66946,
  expect161: 67903,
})

const all = await binance4h(Date.UTC(2024, 7, 1), Date.UTC(2024, 7, 27))
const through24 = all.filter((c) => c[0] < Date.UTC(2024, 7, 25))
const zone = buildContinuationExtension(through24, '4h')
const old = buildGlobalFibonacci(through24, through24[through24.length - 1][4])
const reaction = zone ? readContinuationReaction(through24, zone) : null

console.log('continuation on 4h through 24 Aug 2024', zone && {
  impulse: zone.impulse,
  mode: zone.mode,
  P: zone.pivotStart.price,
  Ptime: iso(zone.pivotStart.time),
  E: zone.pivotEnd.price,
  Etime: iso(zone.pivotEnd.time),
  level141: Math.round(zone.level141),
  level161: Math.round(zone.level161),
  top: Math.round(zone.top),
  bottom: Math.round(zone.bottom),
  state: reaction?.state,
})
console.log('reversal globalFibonacci same window', old && {
  impulse: old.impulse,
  P: old.fib100,
  E: old.fib0,
  zoneTop: old.zone141 ? Math.round(Math.max(old.zone141.top, old.zone141.bottom)) : null,
  zoneBottom: old.zone141 ? Math.round(Math.min(old.zone141.top, old.zone141.bottom)) : null,
})
