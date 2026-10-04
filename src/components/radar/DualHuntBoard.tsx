import { useEffect, useMemo, useRef, useState } from 'react'
import { Star } from 'lucide-react'
import { toRadarLabel } from '../../api/mexc'
import { useAppStore } from '../../store/useAppStore'
import { useRadarFavoriteToggle } from '../../hooks/useRadarFavoriteToggle'
import { useWorkerMarketContext } from '../../hooks/useWorkerMarketContext'
import {
  buildDualHunt,
  createHuntSticky,
  type DualHuntCard,
  type HuntShelf,
  type HuntShelfCounts,
  type HuntSide,
} from '../../engine/radar/dualHunt'
import { AltMacroStrip } from '../market/AltMacroStrip'

type Lane = 'long' | 'short'
type ShelfFilter = HuntShelf | 'ALL'

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

function shelfBadgeClass(shelf: HuntShelf): string {
  if (shelf === 'READY') return 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
  if (shelf === 'WAIT') return 'border-amber-400/35 bg-amber-500/12 text-amber-100'
  return 'border-rose-400/40 bg-rose-500/12 text-rose-200'
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
  const showStar = card.shelf === 'READY'
  return (
    <div className="flex min-h-[4.75rem] items-start gap-2 border-b border-white/[0.06] px-3 py-2.5">
      {showStar ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onFav()
          }}
          className={`mt-0.5 shrink-0 rounded-md p-1 ${
            favorite ? 'text-amber-300' : 'text-white/25 hover:text-white/60'
          }`}
          title={favorite ? 'Убрать из избранного' : 'В избранное'}
        >
          <Star className="h-3.5 w-3.5" fill={favorite ? 'currentColor' : 'none'} />
        </button>
      ) : (
        <span className="mt-0.5 w-6 shrink-0" />
      )}
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-2 text-left"
      >
        <span className="mt-0.5 w-4 shrink-0 font-mono text-[10px] text-white/30">
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-1">
            <span className="whitespace-nowrap font-mono text-[13px] font-bold tracking-wide text-white">
              {label.title}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-white/35">
              {label.hint}
            </span>
            <span
              className={`shrink-0 rounded border px-1 py-px font-mono text-[9px] uppercase ${shelfBadgeClass(card.shelf)}`}
            >
              {card.shelfLabel}
            </span>
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-white/55">
            {card.reason}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-white/40">
            стрим: {card.streamTo}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-white/35">
            топливо: {card.fuelWhere}
          </p>
          {card.doNotChase && (
            <p className="mt-0.5 font-mono text-[10px] text-rose-200/80">не догонять</p>
          )}
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
        </div>
      </button>
    </div>
  )
}

function emptyHuntText(counts: HuntShelfCounts, filter: ShelfFilter): string {
  if (filter === 'READY') {
    const extra = [
      counts.wait > 0 ? `ждут топливо ${counts.wait}` : null,
      counts.stream > 0 ? 'стримят — не догонять' : null,
    ]
      .filter(Boolean)
      .join(' · ')
    return extra ? `нет живых «можно» · ${extra}` : 'нет живых «можно»'
  }
  if (filter === 'WAIT') {
    return counts.wait === 0
      ? counts.ready === 0
        ? 'нет живых «можно»'
        : 'ждут топливо 0'
      : `ждут топливо ${counts.wait}`
  }
  if (filter === 'STREAM') {
    return counts.stream === 0 ? 'стримят — не догонять' : `стримят ${counts.stream} — не догонять`
  }
  if (counts.ready + counts.wait + counts.stream === 0) {
    return 'нет живых «можно»'
  }
  const bits = [
    counts.ready === 0 ? 'нет живых «можно»' : null,
    counts.wait > 0 ? `ждут топливо ${counts.wait}` : null,
    counts.stream > 0 ? 'стримят — не догонять' : null,
  ].filter(Boolean)
  return bits.join(' · ') || 'нет живых «можно»'
}

function HuntLane({
  side,
  cards,
  counts,
  filter,
  scanning,
  favSet,
  onOpen,
  onFav,
}: {
  side: HuntSide
  cards: DualHuntCard[]
  counts: HuntShelfCounts
  filter: ShelfFilter
  scanning: boolean
  favSet: Set<string>
  onOpen: (card: DualHuntCard) => void
  onFav: (internal: string) => void
}) {
  const long = side === 'LONG'
  const [streamOpen, setStreamOpen] = useState(false)
  const ready = cards.filter((c) => c.shelf === 'READY')
  const wait = cards.filter((c) => c.shelf === 'WAIT')
  const stream = cards.filter((c) => c.shelf === 'STREAM')

  const shown =
    filter === 'READY'
      ? ready
      : filter === 'WAIT'
        ? wait
        : filter === 'STREAM'
          ? stream
          : [...ready, ...wait]

  const hideStreamFold = filter !== 'ALL' || stream.length === 0
  const streamRows = hideStreamFold || !streamOpen ? [] : stream

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
        {long ? 'Лонг' : 'Шорт'}
        <span
          className={`ml-2 font-normal ${
            long ? 'text-emerald-200/50' : 'text-rose-200/50'
          }`}
        >
          {counts.ready} можно · {counts.wait} ждут
        </span>
      </header>
      {shown.length === 0 && hideStreamFold ? (
        <p className="px-4 py-8 text-center font-mono text-xs text-white/35">
          {scanning ? 'Сканирую сетапы…' : emptyHuntText(counts, filter)}
        </p>
      ) : (
        <>
          {shown.map((card, i) => (
            <HuntRow
              key={card.internalSymbol}
              card={card}
              rank={i + 1}
              favorite={favSet.has(card.internalSymbol)}
              onOpen={() => onOpen(card)}
              onFav={() => onFav(card.internalSymbol)}
            />
          ))}
          {!hideStreamFold && (
            <button
              type="button"
              onClick={() => setStreamOpen((v) => !v)}
              className="w-full border-t border-white/[0.06] px-3 py-2 text-left font-mono text-[10px] text-rose-200/70"
            >
              {streamOpen ? '▾' : '▸'} стримят {stream.length} — не догонять
            </button>
          )}
          {streamRows.map((card, i) => (
            <HuntRow
              key={card.internalSymbol}
              card={card}
              rank={shown.length + i + 1}
              favorite={favSet.has(card.internalSymbol)}
              onOpen={() => onOpen(card)}
              onFav={() => onFav(card.internalSymbol)}
            />
          ))}
        </>
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
  const liveTickets = useAppStore((s) => s.liveTickets)
  const orderBookMetrics = useAppStore((s) => s.orderBookMetrics)
  const sequenceHits = useAppStore((s) => s.sequenceHits)
  const favorites = useAppStore((s) => s.radarFavorites)
  const toggleFav = useRadarFavoriteToggle()
  const selectCoin = useAppStore((s) => s.selectCoin)
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen)
  const workerCtx = useWorkerMarketContext()
  const twoCols = useTwoColumns()
  const [lane, setLane] = useState<Lane>('long')
  const [shelf, setShelf] = useState<ShelfFilter>('ALL')
  const [tick, setTick] = useState(0)
  const stickyRef = useRef(createHuntSticky())

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])

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
        liveTickets,
        orderBookMetrics,
        sequenceHits,
        sticky: stickyRef.current,
        now: Date.now(),
      }),
    [
      signals,
      radarRows,
      liquidityMaps,
      mmIntent,
      surgicalEntries,
      whaleWatcher,
      liveTickets,
      orderBookMetrics,
      sequenceHits,
      tick,
    ]
  )

  const scanning = isScanning || radarMeta.scanning

  const openCard = (card: DualHuntCard) => {
    selectCoin(card.symbol)
    setDrawerOpen(true)
  }

  const showLong = twoCols || lane === 'long'
  const showShort = twoCols || lane === 'short'
  const readyN = hunt.longCounts.ready + hunt.shortCounts.ready
  const waitN = hunt.longCounts.wait + hunt.shortCounts.wait
  const streamN = hunt.longCounts.stream + hunt.shortCounts.stream

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2">
        <AltMacroStrip ctx={workerCtx} />
      </div>

      {!twoCols && (
        <div className="flex gap-1 px-4 pb-2">
          {(
            [
              ['long', 'Лонг', hunt.longs.length],
              ['short', 'Шорт', hunt.shorts.length],
            ] as const
          ).map(([id, label, n]) => (
            <button
              key={id}
              type="button"
              onClick={() => setLane(id)}
              className={`flex-1 rounded-md px-2 py-1.5 font-mono text-[10px] font-bold uppercase ${
                lane === id
                  ? id === 'short'
                    ? 'bg-rose-500/20 text-rose-200'
                    : 'bg-emerald-500/20 text-emerald-200'
                  : 'bg-white/5 text-white/40'
              }`}
            >
              {label}
              <span className="ml-1 font-normal opacity-60">{n}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-1 px-4 pb-2">
        {          (
            [
              ['READY', 'Можно', readyN],
              ['WAIT', 'Ждут', waitN],
              ['STREAM', 'Стримит', streamN],
              ['ALL', 'Все', readyN + waitN + streamN],
            ] as const
          ).map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            onClick={() => setShelf(id)}
            className={`flex-1 rounded-md px-1.5 py-1.5 font-mono text-[10px] font-bold uppercase ${
              shelf === id ? 'bg-white/15 text-white' : 'bg-white/5 text-white/40'
            }`}
          >
            {label}
            <span className="ml-1 font-normal opacity-60">{n}</span>
          </button>
        ))}
      </div>

      <p className="px-4 pb-1 font-mono text-[10px] text-white/35">
        {scanning
          ? radarMeta.progress || 'охота за сетапами…'
          : readyN === 0
            ? `нет живых «можно» · ждут топливо ${waitN}${streamN > 0 ? ' · стримят — не догонять' : ''}`
            : `можно ${readyN} · ждут ${waitN} · стримят ${streamN}`}
        {radarMeta.error ? ` · ${radarMeta.error}` : ''}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 [scrollbar-gutter:stable]">
        <div className={twoCols ? 'grid grid-cols-2 gap-3' : ''}>
          {showLong && (
            <HuntLane
              side="LONG"
              cards={hunt.longs}
              counts={hunt.longCounts}
              filter={shelf}
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
              counts={hunt.shortCounts}
              filter={shelf}
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
