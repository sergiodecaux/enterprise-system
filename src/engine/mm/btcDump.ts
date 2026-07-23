import type { OhlcvCandle } from '../../api/mexc'

export interface BtcDumpResult {
  dumping: boolean
  changePct15m: number
  /** Multiply confidence by this (0.5 when dumping on meme longs) */
  confidenceMultiplier: number
  label: string
  emoji: string
}

const DUMP_THRESHOLD_PCT = -0.5

/**
 * Если BTC падает >0.5% за 15 минут — мем-лонги теряют 50% уверенности.
 */
export function detectBtcDump(
  btcOhlcv1m: OhlcvCandle[],
  lookbackCandles = 15
): BtcDumpResult {
  if (btcOhlcv1m.length < lookbackCandles + 1) {
    return {
      dumping: false,
      changePct15m: 0,
      confidenceMultiplier: 1,
      label: '',
      emoji: '',
    }
  }

  const end = btcOhlcv1m[btcOhlcv1m.length - 1][4]
  const start = btcOhlcv1m[btcOhlcv1m.length - 1 - lookbackCandles][4]
  const changePct15m = start > 0 ? ((end - start) / start) * 100 : 0
  const dumping = changePct15m <= DUMP_THRESHOLD_PCT

  if (!dumping) {
    return {
      dumping: false,
      changePct15m,
      confidenceMultiplier: 1,
      label: '',
      emoji: '',
    }
  }

  return {
    dumping: true,
    changePct15m,
    confidenceMultiplier: 0.5,
    emoji: '📉',
    label: `BTC DUMP ${changePct15m.toFixed(2)}% / 15м — не лови ракету, когда рынок рушится`,
  }
}

/**
 * Apply BTC dump penalty to score for meme LONGs only.
 */
export function applyBtcDumpPenalty(
  score: number,
  direction: 'LONG' | 'SHORT' | null,
  isMeme: boolean,
  dump: BtcDumpResult
): { score: number; applied: boolean; label: string } {
  if (!isMeme || direction !== 'LONG' || !dump.dumping) {
    return { score, applied: false, label: '' }
  }
  return {
    score: Math.round(score * dump.confidenceMultiplier),
    applied: true,
    label: dump.label,
  }
}
