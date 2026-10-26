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
      ? { dot: 'bg-matrix', text: `MEXC · ${biasRu(marketContext?.dailyBias)}`, tone: 'text-matrix' }
      : connectionStatus === 'POLLING'
        ? { dot: 'bg-yellow-400', text: `MEXC · ${biasRu(marketContext?.dailyBias)}`, tone: 'text-yellow-300' }
        : { dot: 'bg-alert', text: 'НЕТ СВЯЗИ', tone: 'text-alert' }

  const scanText = isScanning
    ? marketContext?.scanProgress || 'Сканирование рынка…'
    : marketContext?.lastScanAt
      ? `Готово — ${setupCount} сетапов · ${clock(marketContext.lastScanAt)}`
      : 'Ожидание первого скана'

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-hull-border bg-hull/60 px-3 font-mono text-[10px] uppercase tracking-wide text-holo/45">
      <span className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dot} ${
            isScanning ? 'pulse-dot' : ''
          }`}
        />
        <span className={status.tone}>{status.text}</span>
      </span>

      <span className="flex min-w-0 items-center gap-1.5">
        {isScanning && (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />
        )}
        <span className="truncate text-holo/55">{scanText}</span>
      </span>

      <span className="ml-auto flex items-center gap-3">
        <span className="text-matrix/80">ЛОНГ {longCount}</span>
        <span className="text-alert/80">ШОРТ {shortCount}</span>
        <span className="text-holo/40">ПАР {tracked}</span>
        <span className="text-holo/25">ОБН {clock(lastUpdate)}</span>
      </span>
    </footer>
  )
}

export default DesktopStatusBar
