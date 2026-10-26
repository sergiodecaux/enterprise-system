import { useMemo } from 'react'
import { ArrowDownRight, ArrowUpRight, Crosshair, Gauge, Radar } from 'lucide-react'
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

function StatCard({
  label,
  value,
  hint,
  tone = 'text-holo',
}: {
  label: string
  value: string
  hint?: string
  tone?: string
}) {
  return (
    <div className="rounded-xl border border-hull-border bg-hull/50 px-3 py-2.5">
      <div className="font-mono text-[9px] font-bold uppercase tracking-widest text-holo/35">
        {label}
      </div>
      <div className={`mt-1 font-mono text-lg font-bold leading-none ${tone}`}>
        {value}
      </div>
      {hint && (
        <div className="mt-1 truncate font-mono text-[10px] text-holo/35">{hint}</div>
      )}
    </div>
  )
}

function CoinLine({
  signal,
  onClick,
}: {
  signal: CoinSignal
  onClick: () => void
}) {
  const up = signal.priceChange24h >= 0
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:border-hull-border hover:bg-hull-light/40"
    >
      <span className="w-24 shrink-0 truncate font-mono text-xs font-bold text-holo/90 group-hover:text-holo">
        {signal.displayName}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-holo/55">
        ${fmtPrice(signal.price)}
      </span>
      <span
        className={`ml-auto flex shrink-0 items-center gap-0.5 font-mono text-[11px] font-bold ${
          up ? 'text-matrix' : 'text-alert'
        }`}
      >
        {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
        {up ? '+' : ''}
        {signal.priceChange24h.toFixed(2)}%
      </span>
      <span
        className={`w-9 shrink-0 text-right font-mono text-[11px] font-bold ${
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
  const selectCoin = useAppStore((s) => s.selectCoin)
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen)
  const fearGreed = useAppStore((s) => s.newsIntel.fearGreed)

  const open = (signal: CoinSignal) => {
    selectCoin(signal.symbol)
    setDrawerOpen(true)
  }

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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-space">
      <div className="border-b border-hull-border bg-hull/25 px-6 py-4">
        <div className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-matrix/80">
          <Crosshair className="h-3.5 w-3.5" />
          терминал
        </div>
        <h1 className="mt-1.5 font-mono text-xl font-bold text-holo">
          Выберите инструмент
        </h1>
        <p className="mt-1 max-w-2xl font-mono text-[11px] leading-relaxed text-holo/40">
          Кликните монету в списке слева или в таблицах ниже — график, стакан и
          разбор откроются здесь. Поиск слева добавляет новую пару в скан.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 px-4 pt-4 lg:grid-cols-4">
        <StatCard
          label="Рынок"
          value={biasRu(marketContext?.dailyBias)}
          hint={`BTC ${trendRu(marketContext?.btcTrend)}`}
          tone={
            marketContext?.dailyBias === 'BULLISH'
              ? 'text-matrix'
              : marketContext?.dailyBias === 'BEARISH'
                ? 'text-alert'
                : 'text-holo'
          }
        />
        <StatCard
          label="Сетапы"
          value={String(setupCount)}
          hint={`${longCount} лонг · ${shortCount} шорт`}
          tone={setupCount > 0 ? 'text-matrix' : 'text-holo/70'}
        />
        <StatCard
          label="Пар в скане"
          value={String(signals.length)}
          hint={isScanning ? 'сканирование…' : 'обновлено'}
        />
        <StatCard
          label="Fear & Greed"
          value={fearGreed ? String(fearGreed.value) : '—'}
          hint={fearGreed?.label ?? 'индекс alternative.me'}
          tone={
            fearGreed
              ? fearGreed.value >= 55
                ? 'text-matrix'
                : fearGreed.value <= 45
                  ? 'text-alert'
                  : 'text-yellow-300'
              : 'text-holo/40'
          }
        />
      </div>

      <div className="grid flex-1 grid-cols-1 gap-3 p-4 xl:grid-cols-2">
        <section className="flex min-h-0 flex-col rounded-xl border border-hull-border bg-hull/25">
          <header className="flex items-center gap-2 border-b border-hull-border/60 px-3 py-2">
            <Gauge className="h-3.5 w-3.5 text-amber-300/80" />
            <h2 className="font-mono text-[10px] font-bold uppercase tracking-widest text-holo/60">
              Движение 24ч
            </h2>
            <span className="ml-auto font-mono text-[10px] text-holo/25">Δ%</span>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {movers.length > 0 ? (
              movers.map((s) => <CoinLine key={s.symbol} signal={s} onClick={() => open(s)} />)
            ) : (
              <p className="px-2 py-6 text-center font-mono text-[11px] text-holo/30">
                {isScanning ? 'Собираем данные рынка…' : 'Пока нет данных скана'}
              </p>
            )}
          </div>
        </section>

        <section className="flex min-h-0 flex-col rounded-xl border border-hull-border bg-hull/25">
          <header className="flex items-center gap-2 border-b border-hull-border/60 px-3 py-2">
            <Radar className="h-3.5 w-3.5 text-matrix/80" />
            <h2 className="font-mono text-[10px] font-bold uppercase tracking-widest text-holo/60">
              Сильные сетапы
            </h2>
            <span className="ml-auto font-mono text-[10px] text-holo/25">SCORE</span>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {setups.length > 0 ? (
              setups.map((s) => <CoinLine key={s.symbol} signal={s} onClick={() => open(s)} />)
            ) : (
              <p className="px-2 py-6 text-center font-mono text-[11px] text-holo/30">
                {isScanning
                  ? 'Ищем сетапы с фильтрами силы…'
                  : 'Готовых сетапов нет — рынок вне условий входа'}
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

export default DesktopTerminalEmpty
