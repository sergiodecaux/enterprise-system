import { useEffect, useMemo, useState } from 'react'
import { Star } from 'lucide-react'
import { toRadarLabel } from '../../api/mexc'
import { useAppStore } from '../../store/useAppStore'
import { useWorkerMarketContext } from '../../hooks/useWorkerMarketContext'
import { buildDualHunt, type DualHuntCard, type HuntSide } from '../../engine/radar/dualHunt'
import { AltMacroStrip } from '../market/AltMacroStrip'
import WinRateBar from './WinRateBar'

type Lane = 'long' | 'short' | 'all'

function useTwoColumns(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(min-width: 640px)').matches
      : false
  )
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 640px)')
    const sync = () => setWide(mql.matches)
    sync()
    mql.addEventListener('change', sync)
    return () => mql.removeEventListener('change', sync)
  }, [])
  return wide
}

function HuntRow({
  card,
  rank,
  favorite,
  onOpen,
  onFav,
}: {
  card: DualHuntCard
  rank: number
  favorite: boolean
  onOpen: () => void
  onFav: () => void
}) {
  const long = card.side === 'LONG'
  const label = toRadarLabel(card.internalSymbol)
  return (
    <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
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
        <Star className="h-4 w-4" fill={favorite ? 'currentColor' : 'none'} />
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="w-5 shrink-0 font-mono text-[10px] text-white/30">
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1">
            <span className="whitespace-nowrap font-mono text-[13px] font-bold tracking-wide text-white">
              {label.title}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-white/35">
              {label.hint}
            </span>
            {card.settingUp && (
              <span className="shrink-0 font-mono text-[9px] uppercase text-amber-200/80">
                набор
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-white/50">
            {card.reason}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div
            className={`rounded border px-1.5 py-0.5 text-center font-mono text-[9px] font-bold uppercase ${
              long
                ? 'border-emerald-400/35 bg-emerald-500/12 text-emerald-200'
                : 'border-rose-400/35 bg-rose-500/12 text-rose-200'
            }`}
          >
            {long ? 'лонг' : 'шорт'}
          </div>
          <div className="mt-1 flex items-center justify-end gap-1">
            <span className="font-mono text-[9px] tabular-nums text-white/40">
              {card.score}
            </span>
            <WinRateBar value={card.probability} compact label="Score" />
          </div>
        </div>
      </button>
    </div>
  )
}

function HuntLane({
  side,
  cards,
  empty,
  scanning,
  favSet,
  onOpen,
  onFav,
}: {
  side: HuntSide
  cards: DualHuntCard[]
  empty: string
  scanning: boolean
  favSet: Set<string>
  onOpen: (card: DualHuntCard) => void
  onFav: (internal: string) => void
}) {
  const long = side === 'LONG'
  return (
    <section
      className={`overflow-hidden rounded-xl border ${
        long
          ? 'border-emerald-400/25 bg-emerald-500/[0.04]'
          : 'border-rose-400/25 bg-rose-500/[0.04]'
      }`}
    >
      <header
        className={`border-b px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-wider ${
          long
            ? 'border-emerald-400/15 text-emerald-200'
            : 'border-rose-400/15 text-rose-200'
        }`}
      >
        {long ? 'Лонг — готовятся расти' : 'Шорт — готовятся падать'}
        <span
          className={`ml-2 font-normal ${
            long ? 'text-emerald-200/50' : 'text-rose-200/50'
          }`}
        >
          {cards.length}
        </span>
      </header>
      {cards.length === 0 ? (
        <p className="px-4 py-8 text-center font-mono text-xs text-white/35">
          {scanning ? 'Сканирую сетапы…' : empty}
        </p>
      ) : (
        cards.map((card, i) => (
          <HuntRow
            key={card.internalSymbol}
            card={card}
            rank={i + 1}
            favorite={favSet.has(card.internalSymbol)}
            onOpen={() => onOpen(card)}
            onFav={() => onFav(card.internalSymbol)}
          />
        ))
      )}
    </section>
  )
}

const DualHuntBoard = () => {
  const signals = useAppStore((s) => s.signals)
  const radarRows = useAppStore((s) => s.radar141Rows)
  const radarMeta = useAppStore((s) => s.radar141Meta)
  const isScanning = useAppStore((s) => s.isScanning)
  const liquidityMaps = useAppStore((s) => s.liquidityMaps)
  const mmIntent = useAppStore((s) => s.mmIntent)
  const surgicalEntries = useAppStore((s) => s.surgicalEntries)
  const whaleWatcher = useAppStore((s) => s.whaleWatcher)
  const favorites = useAppStore((s) => s.radarFavorites)
  const toggleFav = useAppStore((s) => s.toggleRadarFavorite)
  const selectCoin = useAppStore((s) => s.selectCoin)
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen)
  const workerCtx = useWorkerMarketContext()
  const twoCols = useTwoColumns()
  const [lane, setLane] = useState<Lane>('all')

  const favSet = useMemo(() => new Set(favorites), [favorites])

  const hunt = useMemo(
    () =>
      buildDualHunt({
        signals,
        radarRows,
        liquidityMaps,
        mmIntent,
        surgicalEntries,
        whaleWatcher,
      }),
    [signals, radarRows, liquidityMaps, mmIntent, surgicalEntries, whaleWatcher]
  )

  const scanning = isScanning || radarMeta.scanning

  const openCard = (card: DualHuntCard) => {
    selectCoin(card.symbol)
    setDrawerOpen(true)
  }

  const showLong = twoCols || lane === 'long' || lane === 'all'
  const showShort = twoCols || lane === 'short' || lane === 'all'
  const stacked = !twoCols && lane === 'all'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2">
        <AltMacroStrip ctx={workerCtx} />
      </div>

      {!twoCols && (
        <div className="flex gap-1 px-4 pb-2">
          {(
            [
              ['long', 'Лонг'],
              ['short', 'Шорт'],
              ['all', 'Все'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setLane(id)}
              className={`flex-1 rounded-md px-2 py-1.5 font-mono text-[10px] font-bold uppercase ${
                lane === id
                  ? id === 'short'
                    ? 'bg-rose-500/20 text-rose-200'
                    : id === 'long'
                      ? 'bg-emerald-500/20 text-emerald-200'
                      : 'bg-white/15 text-white'
                  : 'bg-white/5 text-white/40'
              }`}
            >
              {label}
              <span className="ml-1 font-normal opacity-60">
                {id === 'long'
                  ? hunt.longs.length
                  : id === 'short'
                    ? hunt.shorts.length
                    : hunt.longs.length + hunt.shorts.length}
              </span>
            </button>
          ))}
        </div>
      )}

      <p className="px-4 pb-1 font-mono text-[10px] text-white/35">
        {scanning
          ? radarMeta.progress || 'охота за сетапами…'
          : `лонг ${hunt.longs.length} · шорт ${hunt.shorts.length}`}
        {radarMeta.error ? ` · ${radarMeta.error}` : ''}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div
          className={
            twoCols
              ? 'grid grid-cols-2 gap-3'
              : stacked
                ? 'flex flex-col gap-3'
                : ''
          }
        >
          {showLong && (
            <HuntLane
              side="LONG"
              cards={hunt.longs}
              empty="Пока нет лонгов в наборе — ждём свип / зону."
              scanning={scanning}
              favSet={favSet}
              onOpen={openCard}
              onFav={toggleFav}
            />
          )}
          {showShort && (
            <HuntLane
              side="SHORT"
              cards={hunt.shorts}
              empty="Пока нет шортов в наборе — ждём свип / зону."
              scanning={scanning}
              favSet={favSet}
              onOpen={openCard}
              onFav={toggleFav}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default DualHuntBoard
