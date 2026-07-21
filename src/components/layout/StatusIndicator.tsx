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
          color: 'bg-matrix text-matrix',
          pulse: 'pulse-dot',
          text: t('status_online'),
        }
      case 'POLLING':
        return {
          color: 'bg-yellow-500 text-yellow-500',
          pulse: 'pulse-dot-slow',
          text: marketContext?.dailyBias
            ? `MEXC · ${biasKey(marketContext.dailyBias)}`
            : t('status_polling'),
        }
      case 'OFFLINE':
      default:
        return {
          color: 'bg-alert text-alert',
          pulse: 'pulse-dot-slow',
          text: t('status_offline'),
        }
    }
  }

  const config = getStatusConfig()

  return (
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full ${config.color} ${config.pulse}`} />
      <span className={`text-xs font-mono uppercase tracking-widest ${config.color}`}>
        {config.text}
      </span>
    </div>
  )
}

export default StatusIndicator
