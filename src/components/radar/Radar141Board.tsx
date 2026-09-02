import { useMemo, useState } from 'react'
import { Star } from 'lucide-react'
import { toBaseTicker, toFlatSymbol } from '../../api/mexc'
import { useAppStore } from '../../store/useAppStore'
import { useWorkerMarketContext } from '../../hooks/useWorkerMarketContext'
import { AltMacroStrip } from '../market/AltMacroStrip'
import {
  isWatchNear141,
  rowPassesFilters,
  sortByExpectedTravel,
  splitStrongWeak,
  type Radar141Row,
} from '../../engine/radar141'

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

function CoinName({ row }: { row: Radar141Row }) {
  const base = toBaseTicker(row.internalSymbol) || row.displayName
  return (
    <div className="flex min-w-0 items-baseline gap-1">
      <span className="whitespace-nowrap font-mono text-[13px] font-bold tracking-wide text-white">
        {base}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-white/35">USDT</span>
    </div>
  )
}

function RadarRow({
  row,
  index,
  selected,
  favorite,
  onOpen,
  onFav,
  onChart,
}: {
  row: Radar141Row
  index: number
  selected: boolean
  favorite: boolean
  onOpen: () => void
  onFav: () => void
  onChart: () => void
}) {
  const rs = row.rsBtc1d
  return (
    <div
      className={`border-b border-white/[0.06] ${
        selected ? 'bg-white/[0.04]' : ''
      }`}
    >
      <div className="flex w-full items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onFav()
          }}
          className={`shrink-0 rounded-md p-1 ${
            favorite ? 'text-amber-300' : 'text-white/25 hover:text-white/60'
          }`}
          title={favorite ? 'Убрать из избранного' : 'В избранное'}
        >
          <Star
            className="h-4 w-4"
            fill={favorite ? 'currentColor' : 'none'}
          />
        </button>
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="w-5 shrink-0 font-mono text-[10px] text-white/30">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <CoinName row={row} />
            <div className="mt-0.5 font-mono text-[10px] text-white/45">
              {row.triggerLabel}
              {' · '}gap {row.gapPct.toFixed(1)}%
              {row.preferredSide
                ? row.preferredSide === 'LONG'
                  ? ' · лонг'
                  : ' · шорт'
                : ''}
              {row.newsRisk ? ' · риск' : ''}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div
              className={`font-mono text-[12px] font-bold ${
                row.change24h >= 0 ? 'text-emerald-300' : 'text-rose-300'
              }`}
            >
              {row.change24h >= 0 ? '+' : ''}
              {row.change24h.toFixed(1)}%
            </div>
            <div
              className={`font-mono text-[10px] ${
                rs > 0.3
                  ? 'text-amber-300'
                  : rs < -0.3
                    ? 'text-sky-300'
                    : 'text-white/35'
              }`}
            >
              RS {rs >= 0 ? '+' : ''}
              {rs.toFixed(1)}
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={onChart}
          className="shrink-0 rounded-md border border-white/10 px-1.5 py-1 font-mono text-[9px] uppercase text-white/50"
        >
          график
        </button>
      </div>
    </div>
  )
}

const Radar141Board = ({
  mode,
}: {
  mode: 'scan' | 'map' | 'watch' | 'fav'
}) => {
  const rows = useAppStore((s) => s.radar141Rows)
  const meta = useAppStore((s) => s.radar141Meta)
  const filters = useAppStore((s) => s.radar141Filters)
  const setFilters = useAppStore((s) => s.setRadar141Filters)
  const favorites = useAppStore((s) => s.radarFavorites)
  const toggleFav = useAppStore((s) => s.toggleRadarFavorite)
  const selectCoin = useAppStore((s) => s.selectCoin)
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen)
  const [openId, setOpenId] = useState<string | null>(null)
  const workerCtx = useWorkerMarketContext()

  const favSet = useMemo(() => new Set(favorites), [favorites])

  const visible = useMemo(() => {
    if (mode === 'fav') {
      return rows.filter((r) => favSet.has(r.internalSymbol))
    }
    if (mode === 'watch') return rows.filter(isWatchNear141)
    if (mode === 'map') return rows
    return sortByExpectedTravel(rows.filter((r) => rowPassesFilters(r, filters)))
  }, [rows, filters, mode, favSet])

  const leaders = useMemo(() => splitStrongWeak(rows, 8), [rows])

  const selected =
    visible.find((r) => r.internalSymbol === openId) ??
    (mode === 'map' ? leaders.strong[0] ?? leaders.weak[0] : visible[0]) ??
    null

  const openChart = (row: Radar141Row) => {
    const signals = useAppStore.getState().signals
    const hit = signals.find((s) => s.internalSymbol === row.internalSymbol)
    selectCoin(hit?.symbol ?? toFlatSymbol(row.internalSymbol))
    setDrawerOpen(true)
  }

  const renderList = (list: Radar141Row[], empty: string) => {
    if (list.length === 0) {
      return (
        <p className="px-4 py-8 text-center font-mono text-xs text-white/35">
          {meta.scanning ? 'Сканирую фьючи…' : empty}
        </p>
      )
    }
    return list.map((row, i) => (
      <RadarRow
        key={row.internalSymbol}
        row={row}
        index={i}
        selected={selected?.internalSymbol === row.internalSymbol}
        favorite={favSet.has(row.internalSymbol)}
        onOpen={() =>
          setOpenId((id) =>
            id === row.internalSymbol ? null : row.internalSymbol
          )
        }
        onFav={() => toggleFav(row.internalSymbol)}
        onChart={() => openChart(row)}
      />
    ))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2">
        <AltMacroStrip ctx={workerCtx} />
      </div>
      {mode === 'scan' && (
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
              setFilters({ minGapPct: filters.minGapPct >= 3 ? 0 : 3 })
            }
          >
            gap {filters.minGapPct >= 3 ? '3%+' : 'все'}
          </Chip>
          <Chip
            on={filters.minGapAtr >= 2}
            onClick={() =>
              setFilters({ minGapAtr: filters.minGapAtr >= 2 ? 0 : 2 })
            }
          >
            {filters.minGapAtr >= 2 ? '2+ ATR' : 'ATR все'}
          </Chip>
          <Chip
            on={filters.maxDist141Pct <= 0.8}
            onClick={() =>
              setFilters({
                maxDist141Pct: filters.maxDist141Pct <= 0.8 ? 99 : 0.8,
              })
            }
          >
            {filters.maxDist141Pct <= 0.8 ? 'у 141' : 'любая дист.'}
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
        {mode === 'watch'
          ? ' · ближе всех к 141'
          : mode === 'fav'
            ? ' · избранное'
            : mode === 'map'
              ? ' · относительно BTC за сутки'
              : ` · ${visible.length} монет`}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === 'map' ? (
          <div className="grid grid-cols-1 gap-3 px-3 pb-3 sm:grid-cols-2">
            <section className="overflow-hidden rounded-xl border border-amber-400/20 bg-amber-500/[0.04]">
              <header className="border-b border-amber-400/15 px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-wider text-amber-200">
                Сильные
                <span className="ml-2 font-normal text-amber-200/50">
                  vs BTC · {leaders.strong.length}
                </span>
              </header>
              {renderList(leaders.strong, 'Пока нет лидеров — дождитесь скана.')}
            </section>
            <section className="overflow-hidden rounded-xl border border-sky-400/20 bg-sky-500/[0.04]">
              <header className="border-b border-sky-400/15 px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-wider text-sky-200">
                Слабые
                <span className="ml-2 font-normal text-sky-200/50">
                  vs BTC · {leaders.weak.length}
                </span>
              </header>
              {renderList(leaders.weak, 'Пока нет отстающих — дождитесь скана.')}
            </section>
          </div>
        ) : (
          renderList(
            visible,
            mode === 'fav'
              ? 'Нажмите звезду у монеты — она попадёт сюда.'
              : mode === 'watch'
                ? 'Нет монет у 141. Откройте скан.'
                : 'Список пуст. Скан ещё идёт или фильтры слишком жёсткие.'
          )
        )}
      </div>

      {selected && (
        <div className="border-t border-white/10 bg-[#0c1016] px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-mono text-[13px] font-bold text-white">
                {toBaseTicker(selected.internalSymbol)}
                <span className="ml-1 text-[11px] font-normal text-white/40">
                  /USDT
                </span>
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-white/45">
                {selected.scoreWhy}
              </p>
            </div>
            <button
              type="button"
              onClick={() => toggleFav(selected.internalSymbol)}
              className={`rounded-md p-1.5 ${
                favSet.has(selected.internalSymbol)
                  ? 'text-amber-300'
                  : 'text-white/30'
              }`}
            >
              <Star
                className="h-4 w-4"
                fill={
                  favSet.has(selected.internalSymbol) ? 'currentColor' : 'none'
                }
              />
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
              <p className="text-rose-300/70">{selected.gap.plan.invalidation}</p>
            </div>
          ) : (
            <p className="mt-2 font-mono text-[10px] text-white/40">
              RS к BTC {selected.rsBtc1d >= 0 ? '+' : ''}
              {selected.rsBtc1d.toFixed(1)} · рынок {selected.rsMarket >= 0 ? '+' : ''}
              {selected.rsMarket.toFixed(1)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export default Radar141Board
