import { useAppStore } from '../../store/useAppStore'

const fmtPrice = (price?: number): string => {
  if (!price || !Number.isFinite(price)) return '—'
  if (price >= 1000) return price.toLocaleString('ru-RU', { maximumFractionDigits: 0 })
  if (price >= 1) return price.toFixed(2)
  return price.toFixed(4)
}

const fmtChange = (change?: number): string => {
  if (change == null || !Number.isFinite(change)) return '—'
  return `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`
}

const biasLabel = (bias?: string | null): string => {
  if (bias === 'BULLISH') return 'Бычий'
  if (bias === 'BEARISH') return 'Медвежий'
  return 'Нейтральный'
}

function Quote({
  ticker,
  fallback,
}: {
  ticker?: { price: number; priceChange24h: number }
  fallback: string
}) {
  const up = (ticker?.priceChange24h ?? 0) >= 0
  return (
    <span className="flex items-baseline gap-1.5 px-2.5 py-1">
      <span className="font-sans text-[10px] font-semibold uppercase tracking-wide text-holo/40">
        {fallback}
      </span>
      <span className="tnum font-mono text-[11px] font-semibold text-holo/90">
        ${fmtPrice(ticker?.price)}
      </span>
      <span
        className={`tnum font-mono text-[10px] font-medium ${
          ticker ? (up ? 'text-matrix' : 'text-alert') : 'text-holo/30'
        }`}
      >
        {fmtChange(ticker?.priceChange24h)}
      </span>
    </span>
  )
}

/** Рыночная лента в шапке: BTC, ETH, дневной bias и Fear & Greed. */
const MarketRibbon = () => {
  const btc = useAppStore((s) => s.liveTickets.BTCUSDT)
  const eth = useAppStore((s) => s.liveTickets.ETHUSDT)
  const marketContext = useAppStore((s) => s.marketContext)
  const fearGreed = useAppStore((s) => s.newsIntel.fearGreed)

  const bias = marketContext?.dailyBias
  const biasTone =
    bias === 'BULLISH' ? 'text-matrix' : bias === 'BEARISH' ? 'text-alert' : 'text-holo/55'
  const fgTone =
    fearGreed == null
      ? 'text-holo/30'
      : fearGreed.value >= 55
        ? 'text-matrix'
        : fearGreed.value <= 45
          ? 'text-alert'
          : 'text-amber-300'

  return (
    <div className="flex items-center rounded-xl border border-hull-border/70 bg-black/25 p-0.5 shadow-panel">
      <Quote ticker={btc} fallback="BTC" />
      <span className="h-4 w-px bg-hull-border/80" />
      <Quote ticker={eth} fallback="ETH" />
      <span className="h-4 w-px bg-hull-border/80" />
      <span className="flex items-center gap-1.5 px-2.5 py-1">
        <span className="font-sans text-[10px] font-semibold uppercase tracking-wide text-holo/40">
          День
        </span>
        <span className={`font-sans text-[10px] font-semibold ${biasTone}`}>
          {biasLabel(bias)}
        </span>
      </span>
      <span className="h-4 w-px bg-hull-border/80" />
      <span className="flex items-center gap-1.5 px-2.5 py-1">
        <span className="font-sans text-[10px] font-semibold uppercase tracking-wide text-holo/40">
          F&amp;G
        </span>
        <span className={`tnum font-mono text-[11px] font-semibold ${fgTone}`}>
          {fearGreed?.value ?? '—'}
        </span>
      </span>
    </div>
  )
}

export default MarketRibbon
