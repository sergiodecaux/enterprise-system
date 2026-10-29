import { useMemo, type ReactNode } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronRight,
  Crosshair,
  Gauge,
  Keyboard,
  Radar,
  Search,
  Sparkles,
} from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import type { CoinSignal } from '../../engine/types'

const biasRu = (bias?: string | null): string => {
  if (bias === 'BULLISH') return 'БЫЧИЙ'
  if (bias === 'BEARISH') return 'МЕДВЕЖИЙ'
  return 'НЕЙТРАЛЬНЫЙ'
}

const trendRu = (trend?: string | null): string => {
  if (trend === 'BULLISH') return 'вверх'
  if (trend === 'BEARISH') return 'вниз'
  if (trend === 'RANGING') return 'боковик'
  return '—'
}

const fmtPrice = (price: number): string => {
  if (!(price > 0)) return '—'
  if (price >= 1000) return price.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
  if (price >= 1) return price.toLocaleString('ru-RU', { maximumFractionDigits: 4 })
  return price.toLocaleString('ru-RU', { maximumFractionDigits: 6 })
}

const fmtChange = (change: number): string =>
  `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`

function StatCard({
  label,
  value,
  hint,
  tone = 'text-holo',
  children,
}: {
  label: string
  value: string
  hint?: string
  tone?: string
  children?: ReactNode
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-hull-border/80 bg-hull/45 px-3.5 py-3 shadow-panel">
      <div className="font-sans text-[11px] font-semibold uppercase tracking-[0.16em] text-holo/35">
        {label}
      </div>
      <div className={`mt-1.5 font-mono text-xl font-semibold leading-none ${tone}`}>
        {value}
      </div>
      {hint && (
        <div className="mt-1.5 truncate font-sans text-[11px] text-holo/35">{hint}</div>
      )}
      {children}
    </div>
  )
}

function SectionCard({
  title,
  icon: Icon,
  iconClass,
  trailing,
  children,
}: {
  title: string
  icon: typeof Gauge
  iconClass: string
  trailing?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-hull-border/80 bg-hull/35 shadow-panel">
      <header className="flex items-center gap-2 border-b border-hull-border/60 px-3.5 py-2.5">
        <Icon className={`h-3.5 w-3.5 ${iconClass}`} />
        <h2 className="font-sans text-[11px] font-semibold uppercase tracking-[0.16em] text-holo/55">
          {title}
        </h2>
        <div className="ml-auto flex items-center gap-2">{trailing}</div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{children}</div>
    </section>
  )
}

function CoinLine({
  signal,
  rank,
  mode,
  onClick,
}: {
  signal: CoinSignal
  rank: number
  mode: 'move' | 'setup'
  onClick: () => void
}) {
  const up = signal.priceChange24h >= 0
  const score = Math.min(100, Math.max(0, signal.score * 10))
  const move = Math.min(100, Math.max(4, Math.abs(signal.priceChange24h) * 6))

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.045]"
    >
      <span className="w-4 shrink-0 text-right font-mono text-[11px] text-holo/20 group-hover:text-holo/40">
        {rank}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-mono text-[12px] font-semibold text-holo/90">
            {signal.displayName}
          </span>
          {signal.hasActiveSetup && (
            <span className="rounded bg-matrix/15 px-1 py-px font-sans text-[11px] font-semibold uppercase tracking-wide text-matrix/90">
              сетап
            </span>
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-holo/35">
          <span>${fmtPrice(signal.price)}</span>
          <span className={up ? 'text-matrix/80' : 'text-alert/80'}>
            {fmtChange(signal.priceChange24h)}
          </span>
        </span>
      </span>

      <span className="hidden w-20 shrink-0 sm:block">
        <span className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
          <span
            className={`h-full rounded-full ${
              mode === 'move'
                ? up
                  ? 'bg-matrix/70'
                  : 'bg-alert/70'
                : 'bg-gradient-to-r from-matrix/45 to-matrix'
            }`}
            style={{ width: `${mode === 'move' ? move : score}%` }}
          />
        </span>
      </span>

      <span
        className={`w-9 shrink-0 text-right font-mono text-[11px] font-semibold ${
          signal.score >= 7
            ? 'text-matrix'
            : signal.score >= 4
              ? 'text-amber-300'
              : 'text-holo/30'
        }`}
        title="Score"
      >
        {signal.score.toFixed(1)}
      </span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-holo/15 transition-colors group-hover:text-matrix/70" />
    </button>
  )
}

/**
 * ПК-терминал без выбранной монеты: вместо пустого экрана — сводка рынка,
 * движение за 24ч и готовые сетапы, из которых можно сразу открыть график.
 */
const DesktopTerminalEmpty = () => {
  const signals = useAppStore((s) => s.signals)
  const marketContext = useAppStore((s) => s.marketContext)
  const isScanning = useAppStore((s) => s.isScanning)
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const selectCoin = useAppStore((s) => s.selectCoin)
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen)
  const fearGreed = useAppStore((s) => s.newsIntel.fearGreed)

  const open = (signal: CoinSignal) => {
    selectCoin(signal.symbol)
    setDrawerOpen(true)
  }

  const btc = useMemo(
    () => signals.find((s) => s.internalSymbol === 'BTC/USDT:USDT') ?? null,
    [signals]
  )

  const movers = useMemo(
    () =>
      [...signals]
        .filter((s) => Number.isFinite(s.priceChange24h))
        .sort((a, b) => Math.abs(b.priceChange24h) - Math.abs(a.priceChange24h))
        .slice(0, 8),
    [signals]
  )

  const setups = useMemo(
    () =>
      [...signals]
        .filter((s) => s.hasActiveSetup || s.score >= 6)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8),
    [signals]
  )

  const longCount = signals.filter((s) => s.direction === 'LONG').length
  const shortCount = signals.filter((s) => s.direction === 'SHORT').length
  const setupCount = signals.filter((s) => s.hasActiveSetup).length
  const biasTone =
    marketContext?.dailyBias === 'BULLISH'
      ? 'text-matrix'
      : marketContext?.dailyBias === 'BEARISH'
        ? 'text-alert'
        : 'text-holo'
  const fgTone =
    fearGreed == null
      ? 'text-holo/40'
      : fearGreed.value >= 55
        ? 'text-matrix'
        : fearGreed.value <= 45
          ? 'text-alert'
          : 'text-amber-300'

  const avgScore = signals.length
    ? signals.reduce((sum, s) => sum + s.score, 0) / signals.length
    : 0
  const avgTone =
    signals.length === 0
      ? 'text-holo/40'
      : avgScore >= 7
        ? 'text-matrix'
        : avgScore >= 4
          ? 'text-amber-300'
          : 'text-holo/70'

  const feed =
    isScanning
      ? { label: 'скан', dot: 'animate-pulse bg-amber-300' }
      : connectionStatus === 'ONLINE'
        ? { label: 'live', dot: 'bg-matrix' }
        : connectionStatus === 'POLLING'
          ? { label: 'опрос', dot: 'bg-amber-300' }
          : { label: 'офлайн', dot: 'bg-alert' }

  return (
    <div className="terminal-empty flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="px-5 pb-2 pt-5 lg:px-6 lg:pt-6">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_250px] xl:grid-cols-[minmax(0,1fr)_286px]">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-sans text-[11px] font-semibold uppercase tracking-[0.24em] text-matrix/70">
              <Crosshair className="h-3.5 w-3.5" />
              терминал · готов к работе
            </div>
            <h1 className="mt-2 font-sans text-[26px] font-semibold leading-tight tracking-tight text-holo">
              Выберите инструмент
            </h1>
            <p className="mt-1.5 max-w-2xl font-sans text-[12px] leading-relaxed text-holo/40">
              Кликните монету в списке слева или в подборках ниже — откроется
              график, стакан и полный разбор структуры. Поиск слева добавляет
              новую пару в скан.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!btc}
                onClick={() => btc && open(btc)}
                className="group inline-flex items-center gap-2 rounded-lg border border-matrix/35 bg-matrix/10 px-3 py-2 font-sans text-[11px] font-semibold text-matrix transition-colors hover:border-matrix/60 hover:bg-matrix/15 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Открыть BTC/USDT
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </button>
              <button
                type="button"
                disabled={setups.length === 0}
                onClick={() => setups[0] && open(setups[0])}
                className="inline-flex items-center gap-2 rounded-lg border border-hull-border/90 bg-hull/45 px-3 py-2 font-sans text-[11px] font-semibold text-holo/65 transition-colors hover:border-holo/25 hover:bg-hull-light/60 hover:text-holo disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Gauge className="h-3.5 w-3.5" />
                Лучший сетап
              </button>
            </div>
          </div>

          <div className="relative overflow-hidden rounded-xl border border-hull-border/80 bg-black/25 p-3.5 shadow-panel">
            <div className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-matrix/10 blur-2xl" />
            <div className="flex items-center justify-between">
              <span className="font-sans text-[11px] font-semibold uppercase tracking-[0.18em] text-holo/35">
                пульс рынка
              </span>
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-holo/30">
                <span className={`h-1.5 w-1.5 rounded-full ${feed.dot}`} />
                {feed.label}
              </span>
            </div>

            <div className={`mt-2 font-sans text-lg font-semibold ${biasTone}`}>
              {biasRu(marketContext?.dailyBias)}
            </div>
            <div className="mt-0.5 font-sans text-[11px] text-holo/35">
              BTC {trendRu(marketContext?.btcTrend)} · день
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-hull-border/70 bg-hull/40 px-2 py-1.5">
                <div className="font-sans text-[11px] uppercase tracking-wide text-holo/30">
                  Fear &amp; Greed
                </div>
                <div className={`font-mono text-base font-semibold ${fgTone}`}>
                  {fearGreed?.value ?? '—'}
                </div>
              </div>
              <div className="rounded-lg border border-hull-border/70 bg-hull/40 px-2 py-1.5">
                <div className="font-sans text-[11px] uppercase tracking-wide text-holo/30">
                  В скане
                </div>
                <div className="font-mono text-base font-semibold text-holo/80">
                  {signals.length}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatCard
            label="Сетапы"
            value={String(setupCount)}
            hint={`${longCount} лонг · ${shortCount} шорт`}
            tone={setupCount > 0 ? 'text-matrix' : 'text-holo/70'}
          />
          <StatCard
            label="Лонг"
            value={String(longCount)}
            hint="сценарии вверх"
            tone={longCount > 0 ? 'text-matrix' : 'text-holo/50'}
          />
          <StatCard
            label="Шорт"
            value={String(shortCount)}
            hint="сценарии вниз"
            tone={shortCount > 0 ? 'text-alert' : 'text-holo/50'}
          />
          <StatCard
            label="Средний score"
            value={signals.length ? avgScore.toFixed(1) : '—'}
            hint={signals.length ? 'сила текущего скана' : 'нет данных'}
            tone={avgTone}
          />
        </div>

        <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-accent/15 bg-accent/[0.045] px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-accent/80" />
          <p className="font-sans text-[11px] leading-relaxed text-holo/40">
            <span className="text-holo/65">Совет:</span> начните с BTC/USDT —
            он задаёт направление рынка. Затем сравните альты в «Сильных сетапах».
          </p>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-2.5 p-4 pb-3 lg:grid-cols-2 lg:p-5">
        <SectionCard
          title="Импульс 24ч"
          icon={Gauge}
          iconClass="text-amber-300/80"
          trailing={<span className="font-mono text-[11px] text-holo/25">Δ%</span>}
        >
          {movers.length > 0 ? (
            <div className="animate-panel-in">
              {movers.map((s, i) => (
                <CoinLine
                  key={s.symbol}
                  signal={s}
                  rank={i + 1}
                  mode="move"
                  onClick={() => open(s)}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center px-2 py-10 text-center">
              {isScanning && (
                <span className="mb-3 h-6 w-6 animate-spin rounded-full border-2 border-hull-border border-t-matrix" />
              )}
              <p className="font-sans text-[11px] text-holo/30">
                {isScanning ? 'Собираем данные рынка…' : 'Пока нет данных скана'}
              </p>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Сильные сетапы"
          icon={Radar}
          iconClass="text-matrix/80"
          trailing={<span className="font-mono text-[11px] text-holo/25">SCORE</span>}
        >
          {setups.length > 0 ? (
            <div className="animate-panel-in">
              {setups.map((s, i) => (
                <CoinLine
                  key={s.symbol}
                  signal={s}
                  rank={i + 1}
                  mode="setup"
                  onClick={() => open(s)}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center px-2 py-10 text-center">
              {isScanning && (
                <span className="mb-3 h-6 w-6 animate-spin rounded-full border-2 border-hull-border border-t-matrix" />
              )}
              <p className="max-w-[240px] font-sans text-[11px] leading-relaxed text-holo/30">
                {isScanning
                  ? 'Ищем сетапы с фильтрами силы…'
                  : 'Готовых сетапов нет — рынок вне условий входа'}
              </p>
            </div>
          )}
        </SectionCard>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-hull-border/50 px-5 py-3 font-sans text-[11px] text-holo/30">
        <span className="flex items-center gap-1.5">
          <Keyboard className="h-3.5 w-3.5 text-holo/25" />
          Горячие клавиши
        </span>
        <span className="flex items-center gap-1.5">
          <kbd className="rounded border border-hull-border bg-hull/60 px-1.5 py-0.5 font-mono text-[11px] text-holo/45">
            Alt+1…4
          </kbd>
          разделы
        </span>
        <span className="flex items-center gap-1.5">
          <kbd className="rounded border border-hull-border bg-hull/60 px-1.5 py-0.5 font-mono text-[11px] text-holo/45">
            Ctrl+K
          </kbd>
          поиск монеты
        </span>
        <span className="hidden items-center gap-1.5 md:flex">
          <kbd className="rounded border border-hull-border bg-hull/60 px-1.5 py-0.5 font-mono text-[11px] text-holo/45">
            drag
          </kbd>
          ширина панели
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-holo/20">
          <ArrowUpRight className="h-3 w-3" />
          <ArrowDownRight className="h-3 w-3" />
          без прогнозов — только структура
        </span>
      </div>
    </div>
  )
}

export default DesktopTerminalEmpty
