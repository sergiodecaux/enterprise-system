import type { AltBias, AltRegime } from '../../api/marketContext'

export type { AltBias, AltRegime }

export interface AltMacroInput {
  btcDominance?: number | null
  btcDomDelta24h?: number | null
  total3Usd?: number | null
  total3Delta24h?: number | null
  totalMcapDelta24h?: number | null
  altRegime?: AltRegime | null
  altBias?: AltBias | null
}

export interface AltMacro {
  regime: AltRegime
  altBias: AltBias
  line: string
}

const BTC_D_UP = 0.2
const BTC_D_DN = -0.2
const ALT_UP = 1.0
const ALT_DN = -1.0

function signOf(delta: number | null | undefined, up: number, dn: number): 1 | -1 | 0 {
  if (delta == null || !Number.isFinite(delta)) return 0
  if (delta >= up) return 1
  if (delta <= dn) return -1
  return 0
}

export function deriveAltMacro(input: AltMacroInput): AltMacro {
  if (input.altRegime && input.altBias) {
    return {
      regime: input.altRegime,
      altBias: input.altBias,
      line: lineOf(input.altRegime, input),
    }
  }

  const btcD = input.btcDominance ?? null
  const dBtc = signOf(input.btcDomDelta24h, BTC_D_UP, BTC_D_DN)
  const altDelta =
    input.total3Delta24h != null && Number.isFinite(input.total3Delta24h)
      ? input.total3Delta24h
      : input.totalMcapDelta24h
  const dAlt = signOf(altDelta, ALT_UP, ALT_DN)

  let regime: AltRegime = 'NEUTRAL'
  if (dBtc !== 0 && dAlt !== 0) {
    if (dBtc > 0 && dAlt < 0) regime = 'ALT_OFF'
    else if (dBtc < 0 && dAlt > 0) regime = 'ALT_ON'
    else if (dBtc > 0 && dAlt > 0) regime = 'BTC_LEAD'
    else regime = 'RISK_OFF'
  } else if (btcD != null) {
    if (btcD >= 56 && dAlt < 0) regime = 'ALT_OFF'
    else if (btcD <= 48 && dAlt > 0) regime = 'ALT_ON'
    else if (btcD >= 56 && dAlt > 0) regime = 'BTC_LEAD'
    else if (btcD <= 48 && dAlt < 0) regime = 'RISK_OFF'
    else if (btcD >= 56) regime = 'ALT_OFF'
    else if (btcD <= 48) regime = 'ALT_ON'
  }

  const altBias: AltBias =
    regime === 'ALT_ON' ? 'LONG' : regime === 'ALT_OFF' || regime === 'RISK_OFF' ? 'SHORT' : 'NEUTRAL'

  return { regime, altBias, line: lineOf(regime, input) }
}

function lineOf(regime: AltRegime, input: AltMacroInput): string {
  const d = input.btcDominance
  const dBtc = input.btcDomDelta24h
  const t3 = input.total3Delta24h ?? input.totalMcapDelta24h
  const btcBit =
    d != null
      ? `BTC.D ${d.toFixed(1)}%${dBtc != null ? ` ${dBtc >= 0 ? '+' : ''}${dBtc.toFixed(2)}пп` : ''}`
      : 'BTC.D н/д'
  const t3Bit =
    t3 != null ? `TOTAL3 ${t3 >= 0 ? '+' : ''}${t3.toFixed(1)}%` : 'TOTAL3 н/д'
  switch (regime) {
    case 'ALT_ON':
      return `${btcBit} ↓ · ${t3Bit} ↑ → альтсезон, лонги альтов`
    case 'ALT_OFF':
      return `${btcBit} ↑ · ${t3Bit} ↓ → отток в BTC, шорты альтов`
    case 'BTC_LEAD':
      return `${btcBit} ↑ · ${t3Bit} ↑ → рост ведёт BTC, альты отстают`
    case 'RISK_OFF':
      return `${btcBit} ↓ · ${t3Bit} ↓ → риск-офф, не ловить альты`
    default:
      return `${btcBit} · ${t3Bit} — смешанно`
  }
}

export function fmtTotal3Usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9) return `$${(n / 1e9).toFixed(0)}B`
  return `$${(n / 1e6).toFixed(0)}M`
}

export function fmtSigned(n: number | null | undefined, digits = 1, suffix = '%'): string {
  if (n == null || !Number.isFinite(n)) return ''
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}${suffix}`
}

export function altBiasLabel(bias: AltBias): string {
  if (bias === 'LONG') return 'ЛОНГ АЛЬТЫ'
  if (bias === 'SHORT') return 'ШОРТ АЛЬТЫ'
  return 'НЕЙТРАЛ'
}
