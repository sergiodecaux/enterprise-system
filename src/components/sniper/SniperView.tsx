import { useMemo, useState } from 'react'
import {
  AlertCircle,
  Crosshair,
  Info,
  Target,
} from 'lucide-react'
import Badge from '../ui/Badge'
import Button from '../ui/Button'
import SegmentedControl from '../ui/SegmentedControl'
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

const POTENTIAL_OPTIONS = POTENTIAL_STEPS.map((step) => ({
  value: String(step),
  label: `≥${step}%`,
}))

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
  const newCount = liveTrades.filter((t) => freshMeta[t.id]?.isNew).length

  const firedCount = Object.keys(firedMeta).length
  const newStrictCount = Object.values(firedMeta).filter(
    (m) => m.isNew
  ).length

  return (
    <div className="flex min-h-full flex-col bg-bg-base pb-6">
      <div className="z-10 border-b border-border bg-bg-base/95 px-3 py-2.5 backdrop-blur-sm min-[1100px]:sticky min-[1100px]:top-0">
        <div className="mb-2 flex items-center gap-2 min-[1100px]:hidden">
          <Crosshair className="h-4 w-4 shrink-0 text-brand" />
          <h1 className="min-w-0 truncate font-sans text-[15px] font-semibold leading-5 text-text-primary">
            Снайпер
          </h1>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 font-sans text-[11px] leading-4 text-text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
            {isScanning ? 'скан' : 'live'}
          </span>
        </div>

        <div className="grid grid-cols-4 divide-x divide-border-subtle">
          <div className="pr-2">
            <div className="font-sans text-[11px] leading-4 text-text-muted">
              Лиды
            </div>
            <div className="tnum font-mono text-[15px] font-medium leading-5 text-text-primary">
              {totalCount}
            </div>
          </div>
          <div className="px-2">
            <div className="font-sans text-[11px] leading-4 text-text-muted">
              В зоне
            </div>
            <div className="tnum font-mono text-[15px] font-medium leading-5 text-market-long">
              {inZoneCount}
            </div>
          </div>
          <div className="px-2">
            <div className="font-sans text-[11px] leading-4 text-text-muted">
              Подход
            </div>
            <div className="tnum font-mono text-[15px] font-medium leading-5 text-market-warning">
              {approachCount}
            </div>
          </div>
          <div className="pl-2">
            <div className="font-sans text-[11px] leading-4 text-text-muted">
              Ср. потенциал
            </div>
            <div className="tnum font-mono text-[15px] font-medium leading-5 text-text-primary">
              +{avgPotential.toFixed(1)}%
            </div>
          </div>
        </div>

        <div className="mt-2.5 flex items-center gap-2">
          <span className="shrink-0 font-sans text-[11px] leading-4 text-text-muted">
            Порог
          </span>
          <SegmentedControl
            value={String(minPotential)}
            onChange={(value) => setMinPotential(Number(value))}
            options={POTENTIAL_OPTIONS}
            size="md"
            stretch
            ariaLabel="Минимальный потенциал"
            className="min-w-0 flex-1"
          />
        </div>

        <div className="mt-1.5">
          <SniperFilters
            activeFilter={activeFilter}
            onFilterChange={setActiveFilter}
            styleFilter={styleFilter}
            onStyleFilterChange={setStyleFilter}
          />
        </div>
      </div>

      <div className="flex-1 px-3 pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="truncate font-sans text-[13px] font-medium leading-5 text-text-primary">
              Живые лимитки
            </h2>
            <span className="tnum font-mono text-[11px] leading-4 text-text-muted">
              {totalCount}
            </span>
            {filledCount > 0 && (
              <span className="font-sans text-[11px] leading-4 text-text-muted">
                · в рынке {filledCount}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] leading-4">
            {newCount > 0 && (
              <Badge tone="brand" dot>
                NEW {newCount}
              </Badge>
            )}
            <span className="text-market-long">{longCount}L</span>
            <span className="text-market-short">{shortCount}S</span>
          </div>
        </div>

        {totalCount === 0 && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-bg-panel/40 px-4 py-8 text-center">
            {isScanning ? (
              <>
                <div className="mb-3 h-7 w-7 animate-spin rounded-full border-2 border-bg-surface border-t-brand" />
                <p className="font-sans text-[12px] text-text-secondary">
                  Сканирование рынка…
                </p>
              </>
            ) : (
              <>
                <AlertCircle className="mb-2 h-6 w-6 text-text-muted" />
                <p className="mb-1 font-sans text-[13px] font-medium text-text-secondary">
                  Нет лимиток с потенциалом ≥{minPotential}%
                </p>
                <p className="max-w-[260px] font-sans text-[11px] leading-4 text-text-muted">
                  Движок ищет откаты к SSL/BSL, surgical-лимиты, MM-ханты и
                  OTE. Если порог слишком высокий — снизьте его или дождитесь
                  следующего скана (~75 с).
                </p>
                {minPotential > 2 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setMinPotential(2)}
                    className="mt-3"
                  >
                    Показать от 2%
                  </Button>
                )}
              </>
            )}
          </div>
        )}

        {totalCount > 0 && (
          <div className="space-y-2">
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

      <div className="mt-5 px-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Target className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            <h2 className="truncate font-sans text-[13px] font-medium leading-5 text-text-primary">
              Готовые снайперские
            </h2>
            <span className="tnum font-mono text-[11px] leading-4 text-text-muted">
              {sniperSignals.length}
            </span>
          </div>
          {firedCount > 0 && (
            <span className="shrink-0 font-mono text-[11px] leading-4 text-text-muted">
              выброшено {firedCount}
              {newStrictCount > 0 ? ` · новых ${newStrictCount}` : ''}
            </span>
          )}
        </div>

        {sniperSignals.length === 0 ? (
          <p className="rounded-lg border border-border bg-bg-panel/40 px-3 py-2.5 font-sans text-[11px] leading-4 text-text-muted">
            Строгих подтверждённых сетапов сейчас нет — это норма. Живые
            лимитки выше показывают потенциал ещё до подтверждения.
          </p>
        ) : (
          <div className="space-y-2.5">
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

      <div className="mt-5 px-3">
        <div className="rounded-md border-l-2 border-market-warning/50 bg-market-warning/[0.05] py-2 pl-2.5 pr-2">
          <div className="mb-1 flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5 text-market-warning/90" />
            <span className="font-sans text-[11px] font-medium leading-4 text-market-warning/90">
              Как читать
            </span>
          </div>
          <p className="font-sans text-[11px] leading-4 text-text-muted">
            Потенциал — движение от лимита до первой цели, а не гарантия.
            Лимит исполняется только при касании; стоп — закон. Чем ближе цена
            к лимиту, тем выше шанс входа.
          </p>
        </div>
      </div>
    </div>
  )
}

export default SniperView
