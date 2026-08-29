import { useMemo, useState } from 'react'
import { toFlatSymbol } from '../../api/mexc'
import { useAppStore } from '../../store/useAppStore'
import {
  isWatchNear141,
  rowPassesFilters,
  sortByExpectedTravel,
  type Radar141Row,
} from '../../engine/radar141'
import Radar141Heatmap from './Radar141Heatmap'

function fmtPx(p: number): string {
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(4)
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-md border px-2 py-1 font-mono text-[10px] font-bold uppercase ${
        on
          ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
          : 'border-white/10 bg-[#10141a] text-white/40'
      }`}
    >
      {children}
    </button>
  )
}

const Radar141Board = ({
  mode,
}: {
  mode: 'scan' | 'map' | 'watch'
}) => {
  const rows = useAppStore((s) => s.radar141Rows)
  const meta = useAppStore((s) => s.radar141Meta)
  const filters = useAppStore((s) => s.radar141Filters)
  const setFilters = useAppStore((s) => s.setRadar141Filters)
  const selectCoin = useAppStore((s) => s.selectCoin)
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen)
  const [openId, setOpenId] = useState<string | null>(null)

  const visible = useMemo(() => {
    const base =
      mode === 'watch' ? rows.filter(isWatchNear141) : rows.filter((r) => rowPassesFilters(r, filters))
    return sortByExpectedTravel(base)
  }, [rows, filters, mode])

  const selected = visible.find((r) => r.internalSymbol === openId) ?? visible[0] ?? null

  const openChart = (row: Radar141Row) => {
    const signals = useAppStore.getState().signals
    const hit = signals.find((s) => s.internalSymbol === row.internalSymbol)
    selectCoin(hit?.symbol ?? toFlatSymbol(row.internalSymbol))
    setDrawerOpen(true)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {mode !== 'map' && (
        <div className="flex gap-1 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Chip
            on={filters.topLiquidityOnly}
            onClick={() => setFilters({ topLiquidityOnly: !filters.topLiquidityOnly })}
          >
            топ-ликвид
          </Chip>
          <Chip
            on={filters.minGapPct >= 3}
            onClick={() =>
              setFilters({ minGapPct: filters.minGapPct >= 3 ? 1.5 : 3 })
            }
          >
            gap {filters.minGapPct}%+
          </Chip>
          <Chip
            on={filters.minGapAtr >= 2}
            onClick={() =>
              setFilters({ minGapAtr: filters.minGapAtr >= 2 ? 1 : 2 })
            }
          >
            {filters.minGapAtr}+ ATR
          </Chip>
          <Chip
            on={filters.maxDist141Pct <= 0.8}
            onClick={() =>
              setFilters({
                maxDist141Pct: filters.maxDist141Pct <= 0.8 ? 3 : 0.8,
              })
            }
          >
            dist&lt;{filters.maxDist141Pct}%
          </Chip>
          <Chip
            on={filters.minAtrPct >= 0.35}
            onClick={() =>
              setFilters({ minAtrPct: filters.minAtrPct >= 0.35 ? 0.15 : 0.35 })
            }
          >
            ATR {filters.minAtrPct}%+
          </Chip>
          <Chip
            on={filters.excludeNewsRisk}
            onClick={() => setFilters({ excludeNewsRisk: !filters.excludeNewsRisk })}
          >
            без новостей
          </Chip>
        </div>
      )}

      <p className="px-4 pb-1 font-mono text-[10px] text-white/35">
        {meta.scanning ? meta.progress || 'скан…' : meta.progress}
        {meta.error ? ` · ${meta.error}` : ''}
        {mode === 'watch' ? ' · watch: ближе всех к 141' : ' · сорт: ожидаемый путь × ликвидность'}
      </p>

      {mode === 'map' ? (
        <Radar141Heatmap rows={visible} onPick={(r) => setOpenId(r.internalSymbol)} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="px-4 py-10 text-center font-mono text-xs text-white/35">
              {meta.scanning
                ? 'Сканирую фьючи…'
                : 'Нет монет под фильтры. Ослабь gap / dist.'}
            </p>
          ) : (
            visible.map((row, i) => (
              <button
                key={row.internalSymbol}
                type="button"
                onClick={() =>
                  setOpenId((id) =>
                    id === row.internalSymbol ? null : row.internalSymbol
                  )
                }
                className="flex w-full items-start gap-2 border-b border-white/[0.05] px-4 py-2.5 text-left"
              >
                <span className="w-5 pt-0.5 font-mono text-[10px] text-white/30">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[12px] font-bold text-white/90">
                      {row.displayName}
                    </span>
                    <span
                      className={`font-mono text-[9px] font-bold ${
                        row.rsLabel === 'STRONG'
                          ? 'text-amber-300'
                          : row.rsLabel === 'WEAK'
                            ? 'text-sky-300'
                            : 'text-white/35'
                      }`}
                    >
                      {row.rsLabel === 'STRONG'
                        ? '🔥 Strong'
                        : row.rsLabel === 'WEAK'
                          ? '🧊 Weak'
                          : '·'}
                    </span>
                    <span className="font-mono text-[9px] text-white/40">
                      {row.triggerLabel}
                    </span>
                    {row.newsRisk && (
                      <span className="font-mono text-[9px] text-rose-300/80">
                        риск
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-white/45">
                    Dist {row.dist141Pct == null
                      ? '—'
                      : `${row.dist141Pct >= 0 ? '+' : ''}${row.dist141Pct.toFixed(2)}%`}
                    {row.dist141Atr != null
                      ? ` · ${Math.abs(row.dist141Atr).toFixed(1)}ATR`
                      : ''}
                    {' · '}gap {row.gapPct.toFixed(1)}% / {row.gapAtr.toFixed(1)}ATR
                    {' · '}path {row.freePathScore}
                  </div>
                  <div className="font-mono text-[10px] text-white/35">
                    Liq {row.liquidityGrade}
                    {row.liquidityOk ? ' OK' : ''}
                    {' · '}vol {row.volRegime}
                    {' · '}RS BTC {row.rsBtc1d >= 0 ? '+' : ''}
                    {row.rsBtc1d.toFixed(1)} / mkt {row.rsMarket >= 0 ? '+' : ''}
                    {row.rsMarket.toFixed(1)}
                    {row.trendAlign ? ' · align' : ''}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-[13px] font-bold text-emerald-300">
                    {row.opportunityScore}
                  </div>
                  <div className="font-mono text-[9px] text-white/35">
                    {row.preferredSide === 'LONG'
                      ? 'лонг'
                      : row.preferredSide === 'SHORT'
                        ? 'шорт'
                        : '—'}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {selected && (
        <div className="border-t border-white/10 bg-[#0c1016] px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-mono text-[11px] font-bold text-white/85">
                Gap Card · {selected.displayName}
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-white/45">
                {selected.scoreWhy}
              </p>
            </div>
            <button
              type="button"
              onClick={() => openChart(selected)}
              className="rounded-md border border-white/15 px-2 py-1 font-mono text-[10px] uppercase text-white/60"
            >
              график
            </button>
          </div>
          {selected.gap ? (
            <div className="mt-2 space-y-1 font-mono text-[10px] text-white/65">
              <p>
                {selected.gap.lower.label} {fmtPx(selected.gap.lower.price)} →{' '}
                {selected.gap.upper.label} {fmtPx(selected.gap.upper.price)} ·{' '}
                {selected.gap.upper.tf}
              </p>
              <p>
                пропасть {selected.gap.gapPct.toFixed(1)}% / {selected.gap.gapAtr.toFixed(1)} ATR · помех{' '}
                {selected.gap.clutter} · пролёт {selected.gap.flyProb}%
              </p>
              <p className="text-white/45">{selected.gap.plan.retest}</p>
              <p className="text-white/45">{selected.gap.plan.breakout}</p>
              <p className="text-rose-300/70">{selected.gap.plan.invalidation}</p>
            </div>
          ) : (
            <p className="mt-2 font-mono text-[10px] text-white/40">
              Пропасть ещё не собрана — мало данных 141/161.
            </p>
          )}
          <p className="mt-2 font-mono text-[10px] text-white/35">
            {selected.testKind === 'NONE'
              ? 'тест 141: нет'
              : selected.testKind === 'FIRST'
                ? 'первый тест'
                : selected.testKind === 'RETEST'
                  ? 'повторный тест'
                  : 'зона выработана'}
            {selected.minutesInZone != null
              ? ` · в зоне ~${selected.minutesInZone} мин`
              : ''}
            {selected.stats.flights
              ? ` · летала ${selected.stats.flights}× ср. ${selected.stats.avgFlightPct.toFixed(1)}%`
              : ''}
            {selected.stats.bestSession
              ? ` · лучше в ${selected.stats.bestSession}`
              : ''}
            {selected.stats.false141Exits
              ? ` · ложных выходов ${selected.stats.false141Exits}`
              : ''}
          </p>
        </div>
      )}
    </div>
  )
}

export default Radar141Board
