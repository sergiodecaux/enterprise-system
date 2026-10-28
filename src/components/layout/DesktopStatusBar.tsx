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
      ? { dot: 'bg-matrix', text: 'ONLINE', tone: 'text-matrix' }
      : connectionStatus === 'POLLING'
        ? { dot: 'bg-amber-300', text: 'POLLING', tone: 'text-amber-300' }
        : { dot: 'bg-alert', text: 'OFFLINE', tone: 'text-alert' }

  const scanText = isScanning
    ? marketContext?.scanProgress || 'Сканирование рынка…'
    : marketContext?.lastScanAt
      ? `Скан готов · ${setupCount} сетапов`
      : 'Ожидание первого скана'

  return (
    <footer className="relative flex h-8 shrink-0 items-center gap-3 overflow-hidden border-t border-hull-border/80 bg-hull/75 px-3 font-sans text-[10px] text-holo/45">
      {isScanning && (
        <span className="absolute inset-x-0 top-0 h-px overflow-hidden">
          <span className="animate-scan block h-full w-1/3 bg-gradient-to-r from-transparent via-matrix to-transparent" />
        </span>
      )}

      <span className="flex shrink-0 items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dot} ${
            isScanning ? 'pulse-dot' : ''
          }`}
        />
        <span className="font-semibold uppercase tracking-[0.1em] text-holo/35">
          MEXC
        </span>
        <span className={`font-mono text-[9px] font-semibold ${status.tone}`}>
          {status.text}
        </span>
      </span>

      <span className="h-3.5 w-px shrink-0 bg-hull-border/80" />

      <span className="flex shrink-0 items-center gap-1.5">
        <span className="uppercase tracking-[0.1em] text-holo/30">День</span>
        <span
          className={`font-semibold ${
            marketContext?.dailyBias === 'BULLISH'
              ? 'text-matrix'
              : marketContext?.dailyBias === 'BEARISH'
                ? 'text-alert'
                : 'text-holo/55'
          }`}
        >
          {biasRu(marketContext?.dailyBias)}
        </span>
      </span>

      <span className="h-3.5 w-px shrink-0 bg-hull-border/80" />

      <span className="flex min-w-0 items-center gap-1.5">
        {isScanning && (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-300" />
        )}
        <span className="truncate text-holo/50">{scanText}</span>
      </span>

      <span className="ml-auto flex shrink-0 items-center gap-3">
        <span className="flex items-center gap-1">
          <span className="h-1 w-1 rounded-full bg-matrix" />
          <span className="font-mono text-[10px] text-matrix/85">L {longCount}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1 w-1 rounded-full bg-alert" />
          <span className="font-mono text-[10px] text-alert/85">S {shortCount}</span>
        </span>
        <span className="font-mono text-[10px] text-holo/40">ПАР {tracked}</span>
        <span className="hidden items-center gap-1 min-[1420px]:flex">
          <span className="uppercase tracking-[0.1em] text-holo/25">ОБН</span>
          <span className="tnum font-mono text-[10px] text-holo/35">
            {clock(lastUpdate)}
          </span>
        </span>
        <span className="hidden rounded border border-hull-border/70 px-1.5 py-0.5 font-mono text-[9px] text-holo/25 min-[1280px]:inline">
          Alt+1…4
        </span>
      </span>
    </footer>
  )
}

export default DesktopStatusBar
