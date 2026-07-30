/**
 * Map worker market context → analyzeSymbol boosts (aligned with bot rules).
 */

import type { WorkerMarketContext } from '../../api/marketContext'

export interface MarketContextBoost {
  /** Added to PE score via newsSentimentBoost channel (−1.5…+1.5) */
  newsSentimentBoost: number
  /** Extra score nudge from BTC.D / F&G (−0.8…+0.8) */
  marketCtxBoost: number
  notes: string[]
  fearGreed: number | null
  btcDominance: number | null
  newsLabel: string | null
  coinNewsLabel: string | null
}

function baseFromInternal(internalSymbol: string): string {
  return internalSymbol
    .replace(/\/USDT:USDT$/i, '')
    .replace(/_USDT$/i, '')
    .replace(/USDT$/i, '')
    .toUpperCase()
}

/**
 * Build boosts for analyzeSymbol from worker context + optional local news boost.
 */
export function buildMarketContextBoost(opts: {
  internalSymbol: string
  side?: 'LONG' | 'SHORT' | null
  workerCtx: WorkerMarketContext | null
  /** Existing Mini App coin sentiment boost (−1.5…+1.5) */
  localNewsBoost?: number
}): MarketContextBoost {
  const notes: string[] = []
  const base = baseFromInternal(opts.internalSymbol)
  const ctx = opts.workerCtx
  const isBtc = base === 'BTC'
  const side = opts.side ?? null

  let newsSentimentBoost = opts.localNewsBoost ?? 0
  let marketCtxBoost = 0

  if (ctx) {
    const coin = ctx.coinNews?.[base]
    if (coin && Math.abs(coin.score) > 0.05) {
      const fromWorker = Math.max(-1.2, Math.min(1.2, coin.score * 1.2))
      // Prefer stronger of local vs worker coin news
      if (Math.abs(fromWorker) > Math.abs(newsSentimentBoost)) {
        newsSentimentBoost = fromWorker
      }
      notes.push(
        `Новости ${base}: ${coin.label}${coin.headlines[0] ? ` · ${coin.headlines[0].slice(0, 48)}` : ''}`
      )
    } else if (ctx.newsLabel && ctx.newsLabel !== 'NEUTRAL') {
      notes.push(`Новости (глоб.): ${ctx.newsLabel}`)
    }

    const fg = ctx.fearGreed
    if (fg != null && side) {
      if (side === 'LONG') {
        if (fg <= 25) {
          marketCtxBoost += 0.25
          notes.push(`F&G ${fg} Extreme Fear → лонг комфортнее`)
        } else if (fg >= 75) {
          marketCtxBoost -= 0.3
          notes.push(`F&G ${fg} Greed → лонг осторожнее`)
        }
      } else {
        if (fg >= 75) {
          marketCtxBoost += 0.25
          notes.push(`F&G ${fg} Greed → шорт комфортнее`)
        } else if (fg <= 25) {
          marketCtxBoost -= 0.3
          notes.push(`F&G ${fg} Fear → шорт осторожнее`)
        }
      }
    }

    const d = ctx.btcDominance
    if (d != null && side) {
      if (!isBtc) {
        if (d >= 55 && side === 'LONG') {
          marketCtxBoost -= 0.35
          notes.push(`BTC.D ${d.toFixed(0)}% давит альты (LONG)`)
        } else if (d <= 48 && side === 'LONG') {
          marketCtxBoost += 0.25
          notes.push(`BTC.D ${d.toFixed(0)}% — пространство альтам`)
        } else if (d >= 55 && side === 'SHORT') {
          marketCtxBoost += 0.15
          notes.push(`BTC.D ${d.toFixed(0)}% поддерживает SHORT альта`)
        }
      } else if (d >= 54 && side === 'LONG') {
        marketCtxBoost += 0.15
        notes.push(`BTC.D ${d.toFixed(0)}% поддерживает BTC LONG`)
      }
    }
  }

  marketCtxBoost = Math.max(-0.8, Math.min(0.8, marketCtxBoost))
  newsSentimentBoost = Math.max(-1.5, Math.min(1.5, newsSentimentBoost))

  return {
    newsSentimentBoost,
    marketCtxBoost,
    notes,
    fearGreed: ctx?.fearGreed ?? null,
    btcDominance: ctx?.btcDominance ?? null,
    newsLabel: ctx?.newsLabel ?? null,
    coinNewsLabel: ctx?.coinNews?.[base]?.label ?? null,
  }
}
