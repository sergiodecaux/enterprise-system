import { useEffect, useState } from 'react'
import { fetchOhlcv } from '../../api/mexc'
import { fetchCrowdContext } from '../../api/binance/crowd'
import {
  buildFullMarketContext,
  type FullMarketContext,
} from '../../engine/context'
import type { MmIntentSnapshot } from '../../engine/types'

const SESSION_RU: Record<FullMarketContext['session']['session'], string> = {
  ASIA: 'Азия',
  LONDON: 'Лондон',
  NY: 'Нью-Йорк',
  LONDON_NY_OVERLAP: 'Лондон + NY',
  LOW_LIQUIDITY: 'тонкая ликвидность',
}

function biasRu(bias: 'BULL' | 'BEAR' | 'NEUTRAL'): string {
  if (bias === 'BULL') return 'бычье'
  if (bias === 'BEAR') return 'медвежье'
  return 'нейтральное'
}

export function ContextPanel({ ctx }: { ctx: FullMarketContext }) {
  const flags = [
    ctx.session.dayType === 'WEEKEND' ? 'выходные' : null,
    ctx.session.isFridayClose ? 'закрытие пятницы' : null,
    ctx.session.isMondayOpen ? 'открытие понедельника' : null,
    ctx.session.isQuarterEnd ? 'конец квартала' : null,
    ctx.session.isMonthEnd && !ctx.session.isQuarterEnd ? 'конец месяца' : null,
  ].filter(Boolean)
  const confirm =
    ctx.thresholds.requiredConfirmation === 'HARD' ? 'подтверждение жёсткое' : 'подтверждение мягкое'
  const daily = ctx.htf?.dailyClose
  const weekly = ctx.htf?.weeklyClose

  return (
    <div className="rounded-xl border border-hull-border bg-hull/40 p-3">
      <div className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-holo/50">
        Контекст
      </div>
      <p className="font-mono text-[11px] text-holo/80">
        {SESSION_RU[ctx.session.session]}
        {flags.length ? ` · ${flags.join(' · ')}` : ''}
        {' · '}
        {confirm}
      </p>
      {daily && weekly && (
        <p className="mt-1 font-mono text-[11px] text-holo/60">
          день {biasRu(daily.bias)}
          {ctx.htf?.closedNearHighOrLow === 'HIGH'
            ? ' у хая'
            : ctx.htf?.closedNearHighOrLow === 'LOW'
              ? ' у лоя'
              : ''}
          {' · '}неделя {biasRu(weekly.bias)}
          {ctx.htf?.closedAboveMidpoint ? ' · день выше середины' : ' · день ниже середины'}
        </p>
      )}
      <p className="mt-1 font-mono text-[11px] text-holo/60">
        {ctx.crowd.known
          ? `толпа L/S ${ctx.crowd.longShortRatio.toFixed(2)} ${ctx.crowd.longShortTrend.toLowerCase()} · funding ${(ctx.crowd.fundingRate * 100).toFixed(3)}% · OI ${ctx.crowd.openInterestChangePct >= 0 ? '+' : ''}${ctx.crowd.openInterestChangePct.toFixed(1)}%`
          : 'толпа: нет публичного ratio'}
        {ctx.whales.hunt
          ? ` · киты: охота${ctx.whales.nearCluster ? ' у кластера' : ''}`
          : ctx.whales.drive !== 'NEUTRAL'
            ? ` · киты drive ${ctx.whales.drive}`
            : ''}
      </p>
      {ctx.notes.length > 0 && (
        <p className="mt-1 font-mono text-[10px] leading-snug text-amber-200/80">
          {ctx.notes.slice(0, 3).join(' · ')}
        </p>
      )}
    </div>
  )
}

/** Session is instant; daily close and crowd fill in after the fetches. */
export function useInstrumentMarketContext(
  symbol: string | null,
  mm: MmIntentSnapshot | null,
  price: number
): FullMarketContext {
  const [ctx, setCtx] = useState<FullMarketContext>(() =>
    buildFullMarketContext({ mm, price, crowd: null })
  )

  useEffect(() => {
    let cancelled = false
    setCtx(buildFullMarketContext({ mm, price, crowd: null }))
    if (!symbol) return
    void (async () => {
      const [daily, crowd] = await Promise.all([
        fetchOhlcv(symbol, '1d', 40).catch(() => []),
        fetchCrowdContext(symbol),
      ])
      if (cancelled) return
      const last = daily.length ? daily[daily.length - 1][4] : price
      setCtx(
        buildFullMarketContext({
          candles1d: daily,
          price: price > 0 ? price : last,
          mm,
          crowd,
        })
      )
    })()
    return () => {
      cancelled = true
    }
    // Price ticks must not refetch. Drive / hunt side is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, mm?.drive, mm?.hunt.microIsStopHunt, mm?.preferredSide, mm?.confidence])

  return ctx
}
