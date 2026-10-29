import { useAppStore } from '../../store/useAppStore'

const biasRu = (bias?: string | null): string => {
  if (bias === 'BULLISH') return 'БЫЧИЙ'
  if (bias === 'BEARISH') return 'МЕДВЕЖИЙ'
  return 'НЕЙТРАЛЬНЫЙ'
}

const clock = (ts?: number | null): string => {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Нижняя строка терминала: связь, скан, счётчики. Только для ПК. */
const DesktopStatusBar = () => {
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const marketContext = useAppStore((s) => s.marketContext)
  const isScanning = useAppStore((s) => s.isScanning)
  const signals = useAppStore((s) => s.signals)
  const liveTickets = useAppStore((s) => s.liveTickets)
  const lastUpdate = useAppStore((s) => s.lastUpdate)

  const longCount = signals.filter((s) => s.direction === 'LONG').length
  const shortCount = signals.filter((s) => s.direction === 'SHORT').length
  const setupCount = signals.filter((s) => s.hasActiveSetup).length
  const tracked = Math.max(Object.keys(liveTickets).length, signals.length)

  const status =
    connectionStatus === 'ONLINE'
      ? { dot: 'bg-brand', text: 'ONLINE', tone: 'text-brand' }
      : connectionStatus === 'POLLING'
        ? {
            dot: 'bg-market-warning',
            text: 'POLLING',
            tone: 'text-market-warning',
          }
        : { dot: 'bg-market-short', text: 'OFFLINE', tone: 'text-market-short' }

  const scanText = isScanning
    ? marketContext?.scanProgress || 'Сканирование рынка…'
    : marketContext?.lastScanAt
      ? `Скан готов · ${setupCount} сетапов`
      : 'Ожидание первого скана'

  return (
    <footer className="relative flex h-6 shrink-0 items-center gap-3 overflow-hidden border-t border-border bg-bg-panel/80 px-3 font-sans text-[11px] text-text-muted">
      {isScanning && (
        <span className="absolute inset-x-0 top-0 h-px overflow-hidden">
          <span className="animate-scan block h-full w-1/3 bg-gradient-to-r from-transparent via-brand to-transparent" />
        </span>
      )}

      <span className="flex shrink-0 items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dot} ${
            isScanning ? 'pulse-dot' : ''
          }`}
        />
        <span className="font-medium text-text-muted">MEXC</span>
        <span className={`font-mono text-[11px] font-medium ${status.tone}`}>
          {status.text}
        </span>
      </span>

      <span className="h-3.5 w-px shrink-0 bg-border" />

      <span className="flex shrink-0 items-center gap-1.5">
        <span className="text-text-muted">День</span>
        <span
          className={`font-medium ${
            marketContext?.dailyBias === 'BULLISH'
              ? 'text-market-long'
              : marketContext?.dailyBias === 'BEARISH'
                ? 'text-market-short'
                : 'text-text-secondary'
          }`}
        >
          {biasRu(marketContext?.dailyBias)}
        </span>
      </span>

      <span className="h-3.5 w-px shrink-0 bg-border" />

      <span className="flex min-w-0 items-center gap-1.5">
        {isScanning && (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-market-warning" />
        )}
        <span className="truncate text-text-muted">{scanText}</span>
      </span>

      <span className="ml-auto flex shrink-0 items-center gap-3">
        <span className="flex items-center gap-1">
          <span className="h-1 w-1 rounded-full bg-market-long" />
          <span className="font-mono text-[11px] text-market-long">
            L {longCount}
          </span>
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1 w-1 rounded-full bg-market-short" />
          <span className="font-mono text-[11px] text-market-short">
            S {shortCount}
          </span>
        </span>
        <span className="font-mono text-[11px] text-text-muted">
          ПАР {tracked}
        </span>
        <span className="hidden items-center gap-1 min-[1420px]:flex">
          <span className="text-text-muted">ОБН</span>
          <span className="tnum font-mono text-[11px] text-text-muted">
            {clock(lastUpdate)}
          </span>
        </span>
        <span className="hidden rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-text-muted min-[1280px]:inline">
          Alt+1…4
        </span>
      </span>
    </footer>
  )
}

export default DesktopStatusBar
