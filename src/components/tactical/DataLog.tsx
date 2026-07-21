import { useState, useEffect } from 'react'
import { Terminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CoinSignal } from '../../engine/types'

interface DataLogProps {
  signal: CoinSignal
}

const DataLog = ({ signal }: DataLogProps) => {
  const { t } = useTranslation()
  const [visibleLines, setVisibleLines] = useState(0)

  const lines: string[] = []

  if (signal.probabilityPct > 0 || signal.hasActiveSetup) {
    lines.push(`> ${t('log_score')}: ${signal.score}/10`)
    lines.push(`> ${t('log_probability')}: ${signal.probabilityPct}%`)
    if (signal.direction) {
      lines.push(
        `> ${t('log_direction')}: ${
          signal.direction === 'LONG' ? t('signal_long') : t('signal_short')
        }`
      )
    }
    if (signal.currentRSI !== null) {
      lines.push(`> RSI(14): ${signal.currentRSI.toFixed(1)}`)
    }
    if (signal.zones.length) {
      lines.push(`> ${t('log_zones')}: ${signal.zones.join(' | ')}`)
    }
    if (signal.btcDivergence && signal.btcDivergence.type !== 'NONE') {
      lines.push(`> BTC Div: ${signal.btcDivergence.label}`)
    }
    if (signal.sl != null) {
      lines.push(`> SL: ${signal.sl}`)
    }
    if (signal.tp1 != null) {
      lines.push(`> TP1: ${signal.tp1} | TP2: ${signal.tp2}`)
    }
    if (signal.dailyPattern) {
      lines.push(`> ${t('log_daily')}: ${signal.dailyPattern}`)
    }
    if (signal.hasActiveSetup) {
      lines.push(`> ${t('log_status_active')}`)
    }
  } else {
    lines.push(`> ${t('tactical_no_data')}`)
  }

  useEffect(() => {
    setVisibleLines(0)
    const timers: ReturnType<typeof setTimeout>[] = []

    lines.forEach((_, index) => {
      const timer = setTimeout(() => {
        setVisibleLines(index + 1)
      }, index * 200)
      timers.push(timer)
    })

    return () => {
      timers.forEach((timer) => clearTimeout(timer))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal.symbol, signal.score, signal.probabilityPct])

  return (
    <div className="bg-hull border border-hull-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <Terminal className="w-4 h-4 text-holo/40" />
        <span className="text-xs text-holo/40 font-mono uppercase tracking-widest">
          {t('tactical_log_title')}
        </span>
      </div>

      <div className="space-y-1 font-mono text-sm text-matrix/80">
        {lines.map((line, index) => (
          <div
            key={index}
            className={`${
              index < visibleLines ? 'opacity-100' : 'opacity-0'
            } transition-opacity duration-100`}
          >
            {line}
            {index === visibleLines - 1 && index === lines.length - 1 && (
              <span className="inline-block w-2 h-4 bg-matrix/80 ml-1 animate-pulse" />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default DataLog
