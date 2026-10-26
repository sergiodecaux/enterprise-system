import { useMemo, useState } from 'react'
import {
  AlertCircle,
  Crosshair,
  Target,
  TrendingUp,
} from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { getSniperSignals } from '../../engine/sniperMode'
import {
  averagePotential,
  buildLiveLimitTrades,
} from '../../engine/sniper/liveLimits'
import {
  getSniperFiredAt,
  isSniperFireNew,
  sniperFireKey,
} from '../../engine/sniper/fire'
import { useLiveLimitFreshness } from '../../hooks/useLiveLimitFreshness'
import { isCommoditySymbol } from '../../api/mexc'
import type { TradeSide } from '../../engine/smc'
import type { TradeStyle } from '../../engine/types'
import SniperCard from './SniperCard'
import SniperFilters from './SniperFilters'
import LiveLimitCard from './LiveLimitCard'

const POTENTIAL_STEPS = [2, 3, 5, 8] as const

const SniperView = () => {
  const signals = useAppStore((s) => s.signals)
  const liveTickets = useAppStore((s) => s.liveTickets)
  const liquidityMaps = useAppStore((s) => s.liquidityMaps)
  const mmIntent = useAppStore((s) => s.mmIntent)
  const surgicalEntries = useAppStore((s) => s.surgicalEntries)
  const buyerAggression = useAppStore((s) => s.buyerAggression)
  const isScanning = useAppStore((s) => s.isScanning)
  const journalVersion = useAppStore((s) => s.journalVersion)

  const [activeFilter, setActiveFilter] = useState<'ALL' | TradeSide>('ALL')
  const [styleFilter, setStyleFilter] = useState<'ALL' | TradeStyle>('ALL')
  const [minPotential, setMinPotential] = useState<number>(2)

  const allLiveTrades = useMemo(
    () =>
      buildLiveLimitTrades({
        signals,
        liveTickets,
        liquidityMaps,
        mmIntent,
        surgicalEntries,
        minPotentialPct: minPotential,
        maxResults: 30,
      }),
    [
      signals,
      liveTickets,
      liquidityMaps,
      mmIntent,
      surgicalEntries,
      minPotential,
    ]
  )

  const liveTrades = useMemo(
    () =>
      allLiveTrades.filter(
        (trade) =>
          (activeFilter === 'ALL' || trade.side === activeFilter) &&
          (styleFilter === 'ALL' || trade.style === styleFilter)
      ),
    [allLiveTrades, activeFilter, styleFilter]
  )

  const freshMeta = useLiveLimitFreshness(liveTrades)

  const sniperSignals = useMemo(() => {
    const enriched = signals.map((s) => ({
      ...s,
      buyerAggression:
        buyerAggression[s.internalSymbol] ?? s.buyerAggression ?? null,
    }))
    const all = getSniperSignals(enriched, styleFilter)
    if (activeFilter === 'ALL') return all
    return all.filter((s) => s.direction === activeFilter)
  }, [signals, buyerAggression, activeFilter, styleFilter])

  const firedMeta = useMemo(() => {
    const map: Record<string, { at: number; isNew: boolean }> = {}
    for (const s of sniperSignals) {
      const key = sniperFireKey(s)
      const at = getSniperFiredAt(key)
      if (at != null) map[key] = { at, isNew: isSniperFireNew(key) }
    }
    return map
  }, [sniperSignals, journalVersion])

  const totalCount = liveTrades.length
  const longCount = liveTrades.filter((t) => t.side === 'LONG').length
  const shortCount = liveTrades.filter((t) => t.side === 'SHORT').length
  const inZoneCount = liveTrades.filter((t) => t.state === 'IN_ZONE').length
  const approachCount = liveTrades.filter(
    (t) => t.state === 'APPROACHING'
  ).length
  const filledCount = liveTrades.filter((t) => t.state === 'FILLED').length
  const avgPotential = averagePotential(liveTrades)
  const newCount = liveTrades.filter(
    (t) => freshMeta[t.id]?.isNew
  ).length

  const firedCount = Object.keys(firedMeta).length
  const newStrictCount = Object.values(firedMeta).filter(
    (m) => m.isNew
  ).length

  return (
    <div className="flex min-h-screen flex-col bg-space pb-6">
      <div className="sticky top-[96px] z-10 border-b border-hull-border bg-space/95 px-4 py-3 backdrop-blur-sm min-[1100px]:top-0">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Crosshair className="h-5 w-5 shrink-0 text-matrix" />
            <div className="min-w-0">
              <h1 className="truncate font-mono text-lg font-bold uppercase tracking-tight text-holo sm:text-2xl">
                Снайпер
              </h1>
              <p className="flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-wide text-amber-100/80">
                <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-matrix" />
                Живые лимитки · потенциал ≥{minPotential}%
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1 rounded-lg border border-matrix/30 bg-matrix/10 px-2 py-1">
            <TrendingUp className="h-3.5 w-3.5 text-matrix" />
            <span className="font-mono text-sm font-bold text-matrix">
              {totalCount}
            </span>
          </div>
        </div>

        <div className="mb-2.5 grid grid-cols-4 gap-1.5">
          <div className="rounded-md bg-hull px-1.5 py-1 text-center">
            <div className="font-mono text-[8px] uppercase text-holo/40">
              Лиды
            </div>
            <div className="font-mono text-base font-bold text-holo">
              {totalCount}
            </div>
          </div>
          <div className="rounded-md bg-matrix/5 px-1.5 py-1 text-center">
            <div className="font-mono text-[8px] uppercase text-matrix/60">
              В зоне
            </div>
            <div className="font-mono text-base font-bold text-matrix">
              {inZoneCount}
            </div>
          </div>
          <div className="rounded-md bg-yellow-400/5 px-1.5 py-1 text-center">
            <div className="font-mono text-[8px] uppercase text-yellow-300/70">
              Подход
            </div>
            <div className="font-mono text-base font-bold text-yellow-300">
              {approachCount}
            </div>
          </div>
          <div className="rounded-md bg-hull px-1.5 py-1 text-center">
            <div className="font-mono text-[8px] uppercase text-holo/40">
              Ср. +%
            </div>
            <div className="font-mono text-base font-bold text-holo">
              {avgPotential.toFixed(1)}
            </div>
          </div>
        </div>

        <div className="mb-2.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-mono text-[8px] uppercase tracking-wide text-holo/35">
              Мин. потенциал
            </span>
            {(inZoneCount > 0 || filledCount > 0) && (
              <span className="font-mono text-[8px] text-matrix/70">
                в зоне {inZoneCount}
                {filledCount > 0 ? ` · в рынке ${filledCount}` : ''}
              </span>
            )}
          </div>
          <div className="flex gap-1.5">
            {POTENTIAL_STEPS.map((step) => (
              <button
                key={step}
                type="button"
                onClick={() => setMinPotential(step)}
                className={`flex-1 rounded-md px-1 py-1 font-mono text-[10px] font-bold transition-all ${
                  minPotential === step
                    ? 'border border-matrix/50 bg-matrix/20 text-matrix shadow-md'
                    : 'border border-hull-border bg-hull text-holo/40 hover:bg-hull-light hover:text-holo/70'
                }`}
              >
                ≥{step}%
              </button>
            ))}
          </div>
        </div>

        <SniperFilters
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
          styleFilter={styleFilter}
          onStyleFilterChange={setStyleFilter}
        />
      </div>

      <div className="flex-1 px-4 pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-matrix" />
            <h2 className="truncate font-mono text-[10px] font-bold uppercase tracking-wide text-holo/65">
              Живые лимитки
            </h2>
            <span className="rounded bg-matrix/15 px-1 py-0.5 font-mono text-[9px] font-bold text-matrix">
              {totalCount}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 font-mono text-[9px]">
            {newCount > 0 && (
              <span className="rounded border border-matrix/40 bg-matrix/10 px-1 py-0.5 font-bold text-matrix">
                NEW {newCount}
              </span>
            )}
            <span className="text-matrix/60">{longCount}L</span>
            <span className="text-alert/60">{shortCount}S</span>
          </div>
        </div>

        {totalCount === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-hull-border bg-hull/30 px-4 py-8 text-center">
            {isScanning ? (
              <>
                <div className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-hull-border border-t-matrix" />
                <p className="font-mono text-xs text-holo/50">
                  Сканирование рынка…
                </p>
              </>
            ) : (
              <>
                <AlertCircle className="mb-2 h-8 w-8 text-holo/20" />
                <p className="mb-1 font-mono text-xs font-bold text-holo/60">
                  Нет лимиток с потенциалом ≥{minPotential}%
                </p>
                <p className="max-w-[250px] font-mono text-[10px] leading-relaxed text-holo/35">
                  Движок ищет откаты к SSL/BSL, surgical-лимиты, MM-ханты и
                  OTE. Если порог слишком высокий — снизь его или дождись
                  следующего скана (~75с).
                </p>
                {minPotential > 2 && (
                  <button
                    type="button"
                    onClick={() => setMinPotential(2)}
                    className="mt-3 rounded-md border border-matrix/40 bg-matrix/10 px-3 py-1.5 font-mono text-[10px] font-bold text-matrix transition-all hover:bg-matrix/20"
                  >
                    Показать от 2%
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {totalCount > 0 && (
          <div className="space-y-2.5">
            {liveTrades.map((trade) => (
              <LiveLimitCard
                key={trade.id}
                trade={trade}
                isNew={freshMeta[trade.id]?.isNew ?? false}
                isCommodity={isCommoditySymbol(trade.internalSymbol)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="mt-5 px-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Target className="h-3.5 w-3.5 shrink-0 text-holo/40" />
            <h2 className="truncate font-mono text-[10px] font-bold uppercase tracking-wide text-holo/50">
              Готовые снайперские
            </h2>
            <span className="rounded bg-holo/10 px-1 py-0.5 font-mono text-[9px] font-bold text-holo/50">
              {sniperSignals.length}
            </span>
          </div>
          {firedCount > 0 && (
            <span className="shrink-0 font-mono text-[8px] text-holo/30">
              выброшено {firedCount}
              {newStrictCount > 0 ? ` · новых ${newStrictCount}` : ''}
            </span>
          )}
        </div>

        {sniperSignals.length === 0 ? (
          <p className="rounded-lg border border-hull-border bg-hull/30 px-3 py-2 font-mono text-[9px] leading-relaxed text-holo/30">
            Строгих подтверждённых сетапов сейчас нет — это норма. Живые
            лимитки выше показывают потенциал ещё до подтверждения.
          </p>
        ) : (
          <div className="space-y-3">
            {sniperSignals.map((signal) => {
              const key = sniperFireKey(signal)
              const meta = firedMeta[key]
              return (
                <SniperCard
                  key={`${signal.symbol}_${signal.tradeStyle}`}
                  signal={signal}
                  firedAt={meta?.at ?? null}
                  isNewFire={meta?.isNew ?? false}
                  isCommodity={isCommoditySymbol(signal.internalSymbol)}
                />
              )
            })}
          </div>
        )}
      </div>

      <div className="mt-5 px-4">
        <div className="rounded-lg border border-yellow-400/20 bg-yellow-400/5 p-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-sm">💡</span>
            <span className="font-mono text-[10px] font-bold uppercase text-yellow-400">
              Как читать
            </span>
          </div>
          <p className="font-mono text-[9px] leading-relaxed text-holo/55">
            Потенциал — движение от лимита до первой цели, а не гарантия.
            Лимит исполняется только при касании; стоп — закон. Чем ближе
            цена к лимиту, тем выше шанс входа.
          </p>
        </div>
      </div>
    </div>
  )
}

export default SniperView
