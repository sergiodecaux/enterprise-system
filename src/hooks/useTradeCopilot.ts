import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import { fetchOhlcv, fetchDepth } from '../api/mexc'
import { isTradeInvalidated, evaluateFullInvalidation } from '../engine/confidence'
import {
  evaluateMemeBreakeven,
  detectEffortVsResult,
  aggressionPctFromRatio,
  priceChangePctOver,
  calculateWeightedObi,
  detectBtcDump,
} from '../engine/mm'
import type { ActiveTrade } from '../engine/types'
import { logger } from '../utils/logger'
import { useTelegramWebApp } from './useTelegramWebApp'

const MONITOR_INTERVAL_MS = 5_000
const BTC_INTERNAL = 'BTC/USDT:USDT'

export const useTradeCopilot = () => {
  const activeTrades = useAppStore((s) => s.activeTrades)
  const updateTrade = useAppStore((s) => s.updateTrade)
  const addTradeEvent = useAppStore((s) => s.addTradeEvent)
  const closeTrade = useAppStore((s) => s.closeTrade)
  const buyerAggression = useAppStore((s) => s.buyerAggression)
  const { haptic, showAlert } = useTelegramWebApp()

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isMounted = useRef(true)
  const btcCacheRef = useRef<{ at: number; candles: Awaited<ReturnType<typeof fetchOhlcv>> } | null>(null)

  const getBtcCandles = useCallback(async () => {
    const now = Date.now()
    if (btcCacheRef.current && now - btcCacheRef.current.at < 60_000) {
      return btcCacheRef.current.candles
    }
    try {
      const candles = await fetchOhlcv(BTC_INTERNAL, '1m', 20)
      btcCacheRef.current = { at: now, candles }
      return candles
    } catch {
      return btcCacheRef.current?.candles ?? []
    }
  }, [])

  const monitorTrade = useCallback(
    async (trade: ActiveTrade) => {
      if (trade.status !== 'ACTIVE' && trade.status !== 'BREAKEVEN') return

      try {
        const ohlcv1m = await fetchOhlcv(trade.internalSymbol, '1m', 30)
        if (!ohlcv1m.length || !isMounted.current) return

        const currentPrice = ohlcv1m[ohlcv1m.length - 1][4]

        const pnlPercent =
          trade.direction === 'LONG'
            ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100
            : ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100

        const pnlUsd = trade.positionSizeUsd
          ? (pnlPercent / 100) * trade.positionSizeUsd
          : null

        // Track continuous profit window (Time-Delay BE)
        const inProfit =
          trade.direction === 'LONG'
            ? currentPrice > trade.entryPrice
            : currentPrice < trade.entryPrice
        let profitSince = trade.profitSince ?? null
        if (inProfit) {
          if (profitSince == null) profitSince = Date.now()
        } else {
          profitSince = null
        }

        const tp1Hit =
          trade.tp1Hit ||
          (trade.direction === 'LONG'
            ? currentPrice >= trade.tp1
            : currentPrice <= trade.tp1)

        updateTrade(trade.id, {
          currentPrice,
          pnlPercent,
          pnlUsd,
          profitSince,
          tp1Hit,
        })

        // ── Meme Shadow Trailing ──────────────────────────────────────────
        if (trade.isMemeTrade) {
          const trailPct = 0.02 // 2% от пика
          let peak = trade.peakPrice ?? trade.entryPrice
          if (trade.direction === 'LONG' && currentPrice > peak) peak = currentPrice
          if (trade.direction === 'SHORT' && currentPrice < peak) peak = currentPrice

          const trailingStop =
            trade.direction === 'LONG'
              ? peak * (1 - trailPct)
              : peak * (1 + trailPct)

          const prevTrail = trade.trailingStop
          if (
            prevTrail == null ||
            (trade.direction === 'LONG' && trailingStop > prevTrail) ||
            (trade.direction === 'SHORT' && trailingStop < prevTrail)
          ) {
            if (prevTrail != null && Math.abs(trailingStop - prevTrail) / trade.entryPrice > 0.005) {
              addTradeEvent(trade.id, {
                type: 'TRAILING_MOVED',
                price: currentPrice,
                message: `Shadow trail → ${trailingStop.toFixed(6)} (peak ${peak.toFixed(6)})`,
              })
            }
            updateTrade(trade.id, {
              peakPrice: peak,
              trailingStop,
              currentPrice,
              pnlPercent,
              pnlUsd,
              profitSince,
              tp1Hit,
            })
          } else {
            updateTrade(trade.id, {
              peakPrice: peak,
              currentPrice,
              pnlPercent,
              pnlUsd,
              profitSince,
              tp1Hit,
            })
          }

          // TP1 on memes: recommend 50% partial — then unlock BE
          if (tp1Hit && !trade.partialTp1Taken) {
            haptic.success()
            showAlert(
              `🎯 ${trade.symbol}: TP1!\nФиксируй 50% позиции. После этого можно переводить остаток в БУ (с ATR-буфером).`
            )
            addTradeEvent(trade.id, {
              type: 'TP1_HIT',
              price: currentPrice,
              message: 'TP1 — фиксируй 50%, затем BE с ATR-дыханием',
            })
            updateTrade(trade.id, { partialTp1Taken: true, tp1Hit: true })
          }

          // Meme BE: only after TP1 + time-delay + min move + ATR buffer
          if (
            !trade.breakevenAlertShown &&
            trade.status === 'ACTIVE' &&
            tp1Hit
          ) {
            const be = evaluateMemeBreakeven({
              direction: trade.direction,
              entryPrice: trade.entryPrice,
              currentPrice,
              tp1: trade.tp1,
              entryTime: profitSince ?? trade.entryTime,
              ohlcv1m,
            })

            if (be.eligible) {
              haptic.impact()
              showAlert(
                `💎 ${trade.symbol}: БУ после TP1\nПереноси SL → ${be.beStop.toFixed(6)} (вход ± 0.5×ATR, не в ноль).`
              )
              addTradeEvent(trade.id, {
                type: 'BREAKEVEN_REACHED',
                price: currentPrice,
                message: be.reason,
              })
              updateTrade(trade.id, {
                breakevenAlertShown: true,
                status: 'BREAKEVEN',
                sl: be.beStop,
              })
            }
          }

          const trailHit =
            trade.direction === 'LONG'
              ? currentPrice <= trailingStop && peak > trade.entryPrice * 1.03
              : currentPrice >= trailingStop && peak < trade.entryPrice * 0.97

          if (trailHit && !trade.trailingAlertShown) {
            haptic.error()
            showAlert(
              `🚨 ${trade.symbol}: ТРЕЙЛИНГ ПРОБИТ!\nСРОЧНО ИДИ В MEXC И ЖМИ SELL MARKET!`
            )
            addTradeEvent(trade.id, {
              type: 'TRAILING_HIT',
              price: currentPrice,
              message: 'Shadow trailing пробит — закрывай по рынку!',
            })
            updateTrade(trade.id, { trailingAlertShown: true })
            return
          }

          // Hard SL still applies
          if (trade.direction === 'LONG' && currentPrice <= trade.sl) {
            haptic.error()
            showAlert(`🛑 ${trade.symbol}: SL активирован`)
            closeTrade(trade.id, 'LOSS', currentPrice)
            return
          }
          if (trade.direction === 'SHORT' && currentPrice >= trade.sl) {
            haptic.error()
            showAlert(`🛑 ${trade.symbol}: SL активирован`)
            closeTrade(trade.id, 'LOSS', currentPrice)
            return
          }

          // Live Effort vs Result warning on open meme trade
          const aggr = buyerAggression[trade.internalSymbol]
          if (aggr && trade.direction === 'LONG' && !trade.absorptionAlertShown) {
            const total = aggr.buyVolume + aggr.sellVolume
            const buyerPct =
              total > 0
                ? (aggr.buyVolume / total) * 100
                : aggressionPctFromRatio(aggr.buyToSellRatio).buyerPct
            const effort = detectEffortVsResult({
              direction: 'LONG',
              buyerAggressionPct: buyerPct,
              sellerAggressionPct: 100 - buyerPct,
              priceChangePct: priceChangePctOver(ohlcv1m, 5),
            })
            if (effort.detected) {
              haptic.warning()
              showAlert(`⚠️ ${trade.symbol}: ${effort.label}\n${effort.reason}`)
              addTradeEvent(trade.id, {
                type: 'ABSORPTION_TRAP',
                price: currentPrice,
                message: `${effort.label}: ${effort.reason}`,
              })
              updateTrade(trade.id, { absorptionAlertShown: true })
            }
          }

          // BTC dump soft warning for meme longs
          if (trade.direction === 'LONG') {
            const btc = await getBtcCandles()
            const dump = detectBtcDump(btc)
            if (dump.dumping) {
              logger.info(`[Copilot] ${trade.symbol} ${dump.label}`)
            }
          }
        } else if (trade.direction === 'LONG') {
          if (currentPrice >= trade.tp1) {
            haptic.success()
            showAlert(`🎯 ${trade.symbol}: TP1 достигнут!`)
            closeTrade(trade.id, 'WIN', currentPrice)
            return
          }
          if (currentPrice <= trade.sl) {
            haptic.error()
            showAlert(`🛑 ${trade.symbol}: SL активирован`)
            closeTrade(trade.id, 'LOSS', currentPrice)
            return
          }
        } else {
          if (currentPrice <= trade.tp1) {
            haptic.success()
            showAlert(`🎯 ${trade.symbol}: TP1 достигнут!`)
            closeTrade(trade.id, 'WIN', currentPrice)
            return
          }
          if (currentPrice >= trade.sl) {
            haptic.error()
            showAlert(`🛑 ${trade.symbol}: SL активирован`)
            closeTrade(trade.id, 'LOSS', currentPrice)
            return
          }
        }

        // Non-meme BE: still require meaningful progress, not early 50% poke
        if (
          !trade.isMemeTrade &&
          !trade.breakevenAlertShown &&
          trade.status === 'ACTIVE'
        ) {
          const distanceToTP1 = Math.abs(trade.tp1 - trade.entryPrice)
          const currentDistance = Math.abs(currentPrice - trade.entryPrice)
          const progressPercent =
            distanceToTP1 > 0 ? (currentDistance / distanceToTP1) * 100 : 0
          const timeOk = Date.now() - trade.entryTime >= 3 * 60 * 1000

          if (progressPercent >= 50 && timeOk && inProfit) {
            haptic.impact()
            showAlert(
              `💎 ${trade.symbol}: Сила подтверждена! Переноси SL в безубыток.`
            )
            addTradeEvent(trade.id, {
              type: 'BREAKEVEN_REACHED',
              price: currentPrice,
              message: '50% пути до TP1 + 3м удержания — рекомендация: SL → BE',
            })
            updateTrade(trade.id, { breakevenAlertShown: true })
          }
        }

        if (!trade.invalidationAlertShown) {
          const ohlcv1h = await fetchOhlcv(trade.internalSymbol, '1h', 60)
          const ohlcv4h = await fetchOhlcv(trade.internalSymbol, '4h', 40)
          if (!isMounted.current) return

          const htfInv = evaluateFullInvalidation({
            direction: trade.direction,
            ohlcv1m,
            ohlcv1h,
            ohlcv4h,
          })

          if (htfInv?.breached) {
            haptic.error()
            showAlert(
              `⚠️ ${trade.symbol}: СЛОМ ПО ${htfInv.timeframe.toUpperCase()}!\n${htfInv.message}`
            )
            addTradeEvent(trade.id, {
              type: 'INVALIDATION',
              price: currentPrice,
              message: htfInv.message,
            })
            updateTrade(trade.id, {
              invalidationAlertShown: true,
              status: 'INVALIDATED',
              invalidationPrice: htfInv.price,
            })
          } else {
            const invalidation = isTradeInvalidated(
              ohlcv1m,
              trade.direction,
              trade.entryPrice
            )

            if (invalidation.invalidated) {
              haptic.error()
              showAlert(
                `⚠️ ${trade.symbol}: ПАТТЕРН СЛОМАН!\n${invalidation.reason}`
              )
              addTradeEvent(trade.id, {
                type: 'INVALIDATION',
                price: currentPrice,
                message: invalidation.reason,
              })
              updateTrade(trade.id, {
                invalidationAlertShown: true,
                status: 'INVALIDATED',
                invalidationPrice:
                  invalidation.invalidationPrice ?? trade.invalidationPrice,
              })
            } else if (
              trade.invalidationPrice != null &&
              ((trade.direction === 'LONG' &&
                currentPrice < trade.invalidationPrice) ||
                (trade.direction === 'SHORT' &&
                  currentPrice > trade.invalidationPrice))
            ) {
              logger.info(
                `[Copilot] ${trade.symbol} near invalidation ${trade.invalidationPrice}`
              )
            }
          }
        }

        if (!trade.wallAlertShown) {
          const depth = await fetchDepth(trade.internalSymbol, 20)
          if (!isMounted.current) return

          const obi = calculateWeightedObi(depth.bids, depth.asks)
          if (
            obi &&
            trade.direction === 'LONG' &&
            obi.nearTouchPressure === 'SELL' &&
            obi.impulseProbPct >= 80
          ) {
            haptic.warning()
            showAlert(
              `📚 ${trade.symbol}: OBI против лонга\n${obi.label}`
            )
            addTradeEvent(trade.id, {
              type: 'WALL_DETECTED',
              price: currentPrice,
              message: obi.label,
            })
            updateTrade(trade.id, { wallAlertShown: true })
          } else if (trade.direction === 'LONG' && depth.asks.length > 0) {
            const bestAskVol = depth.asks[0]?.volume ?? 0
            const dangerousAsks = depth.asks.filter((ask) => {
              const inRange =
                ask.price > currentPrice && ask.price <= trade.tp1
              const isLarge = bestAskVol > 0 && ask.volume > bestAskVol * 5
              return inRange && isLarge
            })

            if (dangerousAsks.length > 0) {
              const wall = dangerousAsks[0]
              const volumeUsd = wall.price * wall.volume
              haptic.warning()
              showAlert(
                `🧱 ${trade.symbol}: Крупная стена Ask на пути!\nЦена: ${wall.price.toFixed(4)} | Объём: $${(volumeUsd / 1000).toFixed(0)}k\nВозможно торможение.`
              )
              addTradeEvent(trade.id, {
                type: 'WALL_DETECTED',
                price: wall.price,
                message: `Ask Wall: $${(volumeUsd / 1000).toFixed(0)}k`,
              })
              updateTrade(trade.id, { wallAlertShown: true })
            }
          }

          if (trade.direction === 'SHORT' && depth.bids.length > 0) {
            const bestBidVol = depth.bids[0]?.volume ?? 0
            const dangerousBids = depth.bids.filter((bid) => {
              const inRange =
                bid.price < currentPrice && bid.price >= trade.tp1
              const isLarge = bestBidVol > 0 && bid.volume > bestBidVol * 5
              return inRange && isLarge
            })

            if (dangerousBids.length > 0) {
              const wall = dangerousBids[0]
              const volumeUsd = wall.price * wall.volume
              haptic.warning()
              showAlert(
                `🧱 ${trade.symbol}: Крупная стена Bid на пути!\nЦена: ${wall.price.toFixed(4)} | Объём: $${(volumeUsd / 1000).toFixed(0)}k\nВозможно торможение.`
              )
              addTradeEvent(trade.id, {
                type: 'WALL_DETECTED',
                price: wall.price,
                message: `Bid Wall: $${(volumeUsd / 1000).toFixed(0)}k`,
              })
              updateTrade(trade.id, { wallAlertShown: true })
            }
          }
        }
      } catch (err) {
        logger.warn(`Trade monitor error ${trade.symbol}`, err)
      }
    },
    [
      updateTrade,
      addTradeEvent,
      closeTrade,
      haptic,
      showAlert,
      buyerAggression,
      getBtcCandles,
    ]
  )

  const monitorAll = useCallback(async () => {
    const active = activeTrades.filter(
      (t) => t.status === 'ACTIVE' || t.status === 'BREAKEVEN'
    )

    for (const trade of active) {
      if (!isMounted.current) break
      await monitorTrade(trade)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }, [activeTrades, monitorTrade])

  useEffect(() => {
    isMounted.current = true
    monitorAll()
    intervalRef.current = setInterval(monitorAll, MONITOR_INTERVAL_MS)

    return () => {
      isMounted.current = false
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [monitorAll])
}
