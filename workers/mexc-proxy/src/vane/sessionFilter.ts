/**
 * Worker session / news blackouts (simplified port of Mini App sessionQuality).
 * Times in UTC.
 */

export interface SessionGate {
  ok: boolean
  reason?: string
  session: 'ASIA' | 'LONDON' | 'NY' | 'OFF'
}

function utcParts(nowMs = Date.now()): {
  h: number
  m: number
  dow: number
  minutes: number
} {
  const d = new Date(nowMs)
  const h = d.getUTCHours()
  const m = d.getUTCMinutes()
  return { h, m, dow: d.getUTCDay(), minutes: h * 60 + m }
}

/** US cash open ~13:30 UTC (EDT) / 14:30 UTC (EST) — use 13:30–14:00 window + buffer */
function nearUsCashOpen(minutes: number): boolean {
  // Block 13:15–14:00 UTC
  return minutes >= 13 * 60 + 15 && minutes <= 14 * 60
}

function nearHtfClose(minutes: number): boolean {
  // 4H closes at 00/04/08/12/16/20 UTC — block last 5 minutes
  const mod = minutes % (4 * 60)
  if (mod >= 4 * 60 - 5) return true
  // Daily close near 00:00 UTC
  if (minutes >= 23 * 60 + 55 || minutes <= 5) return true
  return false
}

function sessionOf(minutes: number): SessionGate['session'] {
  if (minutes >= 0 && minutes < 8 * 60) return 'ASIA'
  if (minutes >= 7 * 60 && minutes < 13 * 60) return 'LONDON'
  if (minutes >= 13 * 60 && minutes < 21 * 60) return 'NY'
  return 'OFF'
}

/** Soft weekend / known macro windows — weekday CPI/NFP proxies via hour bands */
function softMacroBlackout(dow: number, minutes: number): string | null {
  // Fri NFP typical 12:30 UTC — block 12:15–13:00
  if (dow === 5 && minutes >= 12 * 60 + 15 && minutes <= 13 * 60) {
    return 'NFP window (soft)'
  }
  // Mid-month CPI often 12:30 UTC Tue/Wed — block same band on Tue/Wed
  if (
    (dow === 2 || dow === 3) &&
    minutes >= 12 * 60 + 15 &&
    minutes <= 13 * 60
  ) {
    return 'CPI/macro window (soft)'
  }
  return null
}

export function evaluateVaneSession(nowMs = Date.now()): SessionGate {
  const { minutes, dow } = utcParts(nowMs)
  const session = sessionOf(minutes)

  // Crypto weekends are tradable — no hard block (was killing Sunday scans).
  // Keep only short toxic windows: US cash open + HTF roll + macro prints.
  if (nearUsCashOpen(minutes)) {
    return {
      ok: false,
      reason: 'NY cash open ± — стакан нестабилен',
      session,
    }
  }
  if (nearHtfClose(minutes)) {
    return {
      ok: false,
      reason: '4H/Daily close −5m — не открываем',
      session,
    }
  }
  const macro = softMacroBlackout(dow, minutes)
  if (macro) {
    return { ok: false, reason: macro, session }
  }
  return { ok: true, session }
}
