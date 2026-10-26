import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'

const StatusIndicator = () => {
  const { t } = useTranslation()
  const connectionStatus = useAppStore((state) => state.connectionStatus)
  const marketContext = useAppStore((state) => state.marketContext)

  const biasKey = (bias: string) => {
    if (bias === 'BULLISH') return t('bias_bullish')
    if (bias === 'BEARISH') return t('bias_bearish')
    return t('bias_neutral')
  }

  const getStatusConfig = () => {
    switch (connectionStatus) {
      case 'ONLINE':
        return {
          dot: 'bg-matrix',
          text: 'text-matrix',
          pulse: 'pulse-dot',
          label: t('status_online'),
        }
      case 'POLLING':
        return {
          dot: 'bg-yellow-400',
          text: 'text-yellow-300',
          pulse: 'pulse-dot-slow',
          label: marketContext?.dailyBias
            ? `MEXC · ${biasKey(marketContext.dailyBias)}`
            : t('status_polling'),
        }
      case 'OFFLINE':
      default:
        return {
          dot: 'bg-alert',
          text: 'text-alert',
          pulse: 'pulse-dot-slow',
          label: t('status_offline'),
        }
    }
  }

  const config = getStatusConfig()

  return (
    <div className="flex shrink-0 items-center gap-2 rounded-full border border-hull-border bg-black/30 px-3 py-1">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${config.dot} ${config.pulse}`}
      />
      <span
        className={`whitespace-nowrap font-mono text-[10px] font-bold uppercase tracking-widest ${config.text}`}
      >
        {config.label}
      </span>
    </div>
  )
}

export default StatusIndicator
