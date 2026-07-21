import { useState } from 'react'
import { X, BarChart2, Layers, TrendingUp, Activity, Clock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import type { ChartPreferences } from '../../engine/indicators/types'
import { DEFAULT_CHART_PREFERENCES } from '../../engine/indicators/types'
import type { SessionSettings } from '../../engine/sessions/types'

interface Props {
  isOpen: boolean
  onClose: () => void
}

const INDICATOR_GROUPS = [
  {
    id: 'trend',
    labelKey: 'chart_group_trend',
    icon: TrendingUp,
    items: [
      { key: 'ema20' as const, labelKey: 'indicator_ema20', color: '#3b82f6' },
      { key: 'ema50' as const, labelKey: 'indicator_ema50', color: '#f59e0b' },
      { key: 'ema200' as const, labelKey: 'indicator_ema200', color: '#ef4444' },
      { key: 'sma9' as const, label: 'SMA 9', color: '#8b5cf6' },
      { key: 'sma21' as const, label: 'SMA 21', color: '#06b6d4' },
      { key: 'sma50' as const, label: 'SMA 50', color: '#10b981' },
      { key: 'bollingerBands' as const, labelKey: 'indicator_bb', color: '#64748b' },
      { key: 'vwap' as const, labelKey: 'indicator_vwap', color: '#f97316' },
    ],
  },
  {
    id: 'oscillators',
    labelKey: 'chart_group_oscillators',
    icon: Activity,
    items: [
      { key: 'rsi' as const, labelKey: 'indicator_rsi', color: '#a855f7' },
      { key: 'macd' as const, labelKey: 'indicator_macd', color: '#22d3ee' },
      { key: 'stochastic' as const, labelKey: 'indicator_stoch', color: '#84cc16' },
    ],
  },
  {
    id: 'volume',
    labelKey: 'chart_group_volume',
    icon: BarChart2,
    items: [
      { key: 'volume' as const, labelKey: 'indicator_volume', color: '#64748b' },
      { key: 'atr' as const, labelKey: 'indicator_atr', color: '#94a3b8' },
    ],
  },
]

const ZONE_GROUPS = [
  {
    id: 'smc',
    labelKey: 'chart_group_smc',
    icon: Layers,
    items: [
      { key: 'orderBlocks' as const, labelKey: 'zone_ob', color: '#22c55e' },
      { key: 'fvg' as const, labelKey: 'zone_fvg', color: '#3b82f6' },
      { key: 'fibonacci' as const, labelKey: 'zone_fib', color: '#f59e0b' },
      { key: 'dailyLevels' as const, labelKey: 'zone_daily', color: '#e2e8f0' },
    ],
  },
  {
    id: 'volume_profile',
    labelKey: 'chart_group_vp',
    icon: BarChart2,
    items: [
      { key: 'poc' as const, labelKey: 'zone_poc', color: '#f97316' },
      { key: 'valueArea' as const, labelKey: 'zone_va', color: '#94a3b8' },
    ],
  },
]

interface ToggleItemProps {
  label: string
  color: string
  enabled: boolean
  onToggle: () => void
}

const ToggleItem = ({ label, color, enabled, onToggle }: ToggleItemProps) => (
  <button
    type="button"
    onClick={onToggle}
    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-all duration-150 ${
      enabled
        ? 'bg-hull-light/60 ring-1 ring-inset ring-white/10'
        : 'bg-hull/30 opacity-50 hover:opacity-70'
    }`}
  >
    <div className="flex items-center gap-2">
      <div
        className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
        style={{ backgroundColor: color, opacity: enabled ? 1 : 0.4 }}
      />
      <span className="font-mono text-xs text-holo/90">{label}</span>
    </div>
    <div
      className={`relative h-4 w-8 flex-shrink-0 rounded-full transition-colors duration-200 ${
        enabled ? 'bg-holo/60' : 'bg-hull-border'
      }`}
    >
      <div
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform duration-200 ${
          enabled ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </div>
  </button>
)

const ChartSettings = ({ isOpen, onClose }: Props) => {
  const { t } = useTranslation()
  const chartPreferences = useAppStore((s) => s.chartPreferences)
  const setChartPreferences = useAppStore((s) => s.setChartPreferences)
  const sessionSettings = useAppStore((s) => s.sessionSettings)
  const setSessionSettings = useAppStore((s) => s.setSessionSettings)
  const [activeTab, setActiveTab] = useState<'indicators' | 'zones' | 'sessions'>(
    'indicators'
  )

  const toggleIndicator = (key: keyof ChartPreferences['indicators']) => {
    setChartPreferences({
      indicators: {
        ...chartPreferences.indicators,
        [key]: !chartPreferences.indicators[key],
      },
    })
  }

  const toggleZone = (key: keyof ChartPreferences['zones']) => {
    setChartPreferences({
      zones: {
        ...chartPreferences.zones,
        [key]: !chartPreferences.zones[key],
      },
    })
  }

  const resetAll = () => {
    const indicators = { ...DEFAULT_CHART_PREFERENCES.indicators }
    const zones = { ...DEFAULT_CHART_PREFERENCES.zones }
    ;(Object.keys(indicators) as Array<keyof ChartPreferences['indicators']>).forEach(
      (k) => {
        indicators[k] = false
      }
    )
    ;(Object.keys(zones) as Array<keyof ChartPreferences['zones']>).forEach((k) => {
      zones[k] = false
    })
    setChartPreferences({
      indicators,
      zones,
      opacity: DEFAULT_CHART_PREFERENCES.opacity,
      showLabels: DEFAULT_CHART_PREFERENCES.showLabels,
    })
  }

  if (!isOpen) return null

  const activeIndicators = Object.values(chartPreferences.indicators).filter(Boolean).length
  const activeZones = Object.values(chartPreferences.zones).filter(Boolean).length

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      <div
        className="fixed inset-x-4 top-16 bottom-16 z-50 mx-auto flex max-w-sm flex-col
                   overflow-hidden rounded-2xl border border-hull-border bg-space shadow-2xl"
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-hull-border/50 px-4 py-3">
          <h2 className="font-mono text-sm font-bold uppercase tracking-wider text-holo">
            {t('chart_settings')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 transition-colors hover:bg-hull-light/40"
          >
            <X className="h-4 w-4 text-holo/60" />
          </button>
        </div>

        <div className="flex flex-shrink-0 border-b border-hull-border/50">
          {(
            [
              { id: 'indicators' as const, label: t('chart_indicators'), badge: activeIndicators },
              { id: 'zones' as const, label: t('chart_zones'), badge: activeZones },
              {
                id: 'sessions' as const,
                label: t('session_tab'),
                badge: sessionSettings.enabled ? 1 : 0,
              },
            ]
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex flex-1 items-center justify-center gap-2 py-2.5 font-mono text-xs transition-colors ${
                activeTab === tab.id
                  ? 'border-b-2 border-holo text-holo'
                  : 'text-holo/50 hover:text-holo/70'
              }`}
            >
              {tab.label}
              {tab.badge > 0 && (
                <span className="rounded-full bg-holo/20 px-1.5 py-0.5 text-[10px] font-bold text-holo">
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-3">
          {activeTab === 'indicators' && (
            <>
              {INDICATOR_GROUPS.map((group) => {
                const Icon = group.icon
                return (
                  <div key={group.id}>
                    <div className="mb-2 flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 text-holo/50" />
                      <span className="font-mono text-[10px] uppercase tracking-widest text-holo/50">
                        {t(group.labelKey)}
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {group.items.map((item) => (
                        <ToggleItem
                          key={item.key}
                          label={
                            'labelKey' in item && item.labelKey
                              ? t(item.labelKey)
                              : (item as { label?: string }).label ?? item.key
                          }
                          color={item.color}
                          enabled={chartPreferences.indicators[item.key]}
                          onToggle={() => toggleIndicator(item.key)}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}

              <div>
                <div className="mb-2 font-mono text-[10px] uppercase text-holo/50">
                  {t('chart_opacity')}
                </div>
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={chartPreferences.opacity}
                  onChange={(e) =>
                    setChartPreferences({ opacity: Number(e.target.value) })
                  }
                  className="h-1 w-full accent-holo"
                />
                <div className="mt-1 text-right text-[10px] text-holo/50">
                  {chartPreferences.opacity}%
                </div>
              </div>
            </>
          )}

          {activeTab === 'zones' && (
            <>
              {ZONE_GROUPS.map((group) => {
                const Icon = group.icon
                return (
                  <div key={group.id}>
                    <div className="mb-2 flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 text-holo/50" />
                      <span className="font-mono text-[10px] uppercase tracking-widest text-holo/50">
                        {t(group.labelKey)}
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {group.items.map((item) => (
                        <ToggleItem
                          key={item.key}
                          label={t(item.labelKey)}
                          color={item.color}
                          enabled={chartPreferences.zones[item.key]}
                          onToggle={() => toggleZone(item.key)}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}

              <ToggleItem
                label={t('chart_show_labels')}
                color="#64c8ff"
                enabled={chartPreferences.showLabels}
                onToggle={() =>
                  setChartPreferences({ showLabels: !chartPreferences.showLabels })
                }
              />
            </>
          )}

          {activeTab === 'sessions' && (
            <div className="space-y-4">
              <ToggleItem
                label={t('sessions_title')}
                color="#64c8ff"
                enabled={sessionSettings.enabled}
                onToggle={() =>
                  setSessionSettings({ enabled: !sessionSettings.enabled })
                }
              />

              {sessionSettings.enabled && (
                <>
                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <Clock className="h-3.5 w-3.5 text-holo/50" />
                      <span className="font-mono text-[10px] uppercase tracking-widest text-holo/50">
                        {t('session_tab')}
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {(
                        [
                          {
                            key: 'showAsia' as const,
                            label: 'Азия (00:00–09:00 UTC)',
                            color: '#6366f1',
                          },
                          {
                            key: 'showLondon' as const,
                            label: 'Лондон (07:00–16:00 UTC)',
                            color: '#f59e0b',
                          },
                          {
                            key: 'showNewYork' as const,
                            label: 'Нью-Йорк (13:00–22:00 UTC)',
                            color: '#22c55e',
                          },
                          {
                            key: 'showOverlap' as const,
                            label: 'Overlap LDN+NY (13–16 UTC)',
                            color: '#ef4444',
                          },
                          {
                            key: 'showWeekends' as const,
                            label: t('session_weekends'),
                            color: '#64748b',
                          },
                          {
                            key: 'showSessionLines' as const,
                            label: t('session_lines'),
                            color: '#94a3b8',
                          },
                        ] satisfies Array<{
                          key: keyof SessionSettings
                          label: string
                          color: string
                        }>
                      ).map((item) => (
                        <ToggleItem
                          key={item.key}
                          label={item.label}
                          color={item.color}
                          enabled={Boolean(sessionSettings[item.key])}
                          onToggle={() =>
                            setSessionSettings({
                              [item.key]: !sessionSettings[item.key],
                            })
                          }
                        />
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-holo/50">
                      {t('session_news')}
                    </div>
                    <ToggleItem
                      label={t('session_news')}
                      color="#ef4444"
                      enabled={sessionSettings.showNews}
                      onToggle={() =>
                        setSessionSettings({
                          showNews: !sessionSettings.showNews,
                        })
                      }
                    />
                  </div>

                  <div>
                    <div className="mb-2 font-mono text-[10px] uppercase text-holo/50">
                      {t('session_opacity')}
                    </div>
                    <input
                      type="range"
                      min={20}
                      max={150}
                      value={sessionSettings.opacity}
                      onChange={(e) =>
                        setSessionSettings({ opacity: Number(e.target.value) })
                      }
                      className="h-1 w-full accent-holo"
                    />
                    <div className="mt-1 flex justify-between text-[10px] text-holo/40">
                      <span>Тихо</span>
                      <span>{sessionSettings.opacity}%</span>
                      <span>Ярко</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-hull-border/50 px-4 py-3">
          <button
            type="button"
            onClick={resetAll}
            className="rounded-lg px-3 py-1.5 font-mono text-xs text-holo/50 transition-colors hover:bg-alert/10 hover:text-alert"
          >
            {t('chart_reset_all')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg bg-holo/20 py-2 font-mono text-xs font-bold text-holo transition-colors hover:bg-holo/30"
          >
            {t('chart_apply')}
          </button>
        </div>
      </div>
    </>
  )
}

export default ChartSettings
