import { useState } from 'react'
import { BarChart2, Layers, TrendingUp, Activity, Clock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import Button from '../ui/Button'
import Modal from '../ui/Modal'
import Sheet from '../ui/Sheet'
import SegmentedControl from '../ui/SegmentedControl'
import { useDesktopLayout } from '../../hooks/useDesktopLayout'
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
      { key: 'orderBlocks' as const, labelKey: 'zone_ob', color: '#2DD4BF' },
      { key: 'fvg' as const, labelKey: 'zone_fvg', color: '#A78BFA' },
      { key: 'fibonacci' as const, labelKey: 'zone_fib', color: '#F5B942' },
      { key: 'dailyLevels' as const, labelKey: 'zone_daily', color: '#94A0B2' },
    ],
  },
  {
    id: 'volume_profile',
    labelKey: 'chart_group_vp',
    icon: BarChart2,
    items: [
      { key: 'poc' as const, labelKey: 'zone_poc', color: '#F5B942' },
      { key: 'valueArea' as const, labelKey: 'zone_va', color: '#94A0B2' },
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
    aria-pressed={enabled}
    className={`flex min-h-10 w-full items-center justify-between gap-3 rounded-md border px-2.5 py-2 text-left transition-colors ${
      enabled
        ? 'border-border-active bg-bg-elevated'
        : 'border-border-subtle bg-bg-base/40 hover:border-border'
    }`}
  >
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: color, opacity: enabled ? 1 : 0.35 }}
      />
      <span
        className={`truncate font-sans text-[12px] leading-4 ${
          enabled ? 'text-text-primary' : 'text-text-secondary'
        }`}
      >
        {label}
      </span>
    </span>
    <span
      aria-hidden
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
        enabled ? 'bg-brand' : 'bg-bg-surface'
      }`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${
          enabled ? 'translate-x-3.5' : 'translate-x-0.5'
        }`}
      />
    </span>
  </button>
)

const GroupHeading = ({
  icon: Icon,
  label,
}: {
  icon: typeof TrendingUp
  label: string
}) => (
  <div className="mb-1.5 flex items-center gap-1.5">
    <Icon className="h-3.5 w-3.5 text-text-muted" />
    <span className="font-sans text-[11px] font-medium leading-4 text-text-muted">
      {label}
    </span>
  </div>
)

const ChartSettings = ({ isOpen, onClose }: Props) => {
  const { t } = useTranslation()
  const isDesktop = useDesktopLayout()
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

  const content = (
    <div className="space-y-4">
      <SegmentedControl
        value={activeTab}
        onChange={setActiveTab}
        options={[
          {
            value: 'indicators' as const,
            label: (
              <span className="flex items-center gap-1.5">
                {t('chart_indicators')}
                {activeIndicators > 0 && (
                  <span className="tnum font-mono text-[11px] text-text-muted">
                    {activeIndicators}
                  </span>
                )}
              </span>
            ),
          },
          {
            value: 'zones' as const,
            label: (
              <span className="flex items-center gap-1.5">
                {t('chart_zones')}
                {activeZones > 0 && (
                  <span className="tnum font-mono text-[11px] text-text-muted">
                    {activeZones}
                  </span>
                )}
              </span>
            ),
          },
          {
            value: 'sessions' as const,
            label: (
              <span className="flex items-center gap-1.5">
                {t('session_tab')}
                {sessionSettings.enabled && (
                  <span className="h-1.5 w-1.5 rounded-full bg-brand" />
                )}
              </span>
            ),
          },
        ]}
        stretch
        ariaLabel="Разделы настроек графика"
        className="w-full"
      />

      {activeTab === 'indicators' && (
        <>
          {INDICATOR_GROUPS.map((group) => (
            <div key={group.id}>
              <GroupHeading icon={group.icon} label={t(group.labelKey)} />
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
          ))}

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="font-sans text-[11px] font-medium leading-4 text-text-muted">
                {t('chart_opacity')}
              </span>
              <span className="tnum font-mono text-[11px] leading-4 text-text-secondary">
                {chartPreferences.opacity}%
              </span>
            </div>
            <input
              type="range"
              min={10}
              max={100}
              value={chartPreferences.opacity}
              onChange={(e) =>
                setChartPreferences({ opacity: Number(e.target.value) })
              }
              className="h-1 w-full accent-brand"
            />
          </div>
        </>
      )}

      {activeTab === 'zones' && (
        <>
          {ZONE_GROUPS.map((group) => (
            <div key={group.id}>
              <GroupHeading icon={group.icon} label={t(group.labelKey)} />
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
          ))}

          <ToggleItem
            label={t('chart_show_labels')}
            color="#6EA8FE"
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
            color="#6EA8FE"
            enabled={sessionSettings.enabled}
            onToggle={() =>
              setSessionSettings({ enabled: !sessionSettings.enabled })
            }
          />

          {sessionSettings.enabled && (
            <>
              <div>
                <GroupHeading icon={Clock} label={t('session_tab')} />
                <div className="space-y-1.5">
                  {(
                    [
                      {
                        key: 'showAsia' as const,
                        label: 'Азия (00:00–09:00 UTC)',
                        color: '#6EA8FE',
                      },
                      {
                        key: 'showLondon' as const,
                        label: 'Лондон (07:00–16:00 UTC)',
                        color: '#F5B942',
                      },
                      {
                        key: 'showNewYork' as const,
                        label: 'Нью-Йорк (13:00–22:00 UTC)',
                        color: '#2DD4BF',
                      },
                      {
                        key: 'showOverlap' as const,
                        label: 'Overlap LDN+NY (13–16 UTC)',
                        color: '#FB7185',
                      },
                      {
                        key: 'showWeekends' as const,
                        label: t('session_weekends'),
                        color: '#5F6B7C',
                      },
                      {
                        key: 'showSessionLines' as const,
                        label: t('session_lines'),
                        color: '#94A0B2',
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
                <div className="mb-1.5 font-sans text-[11px] font-medium leading-4 text-text-muted">
                  {t('session_news')}
                </div>
                <ToggleItem
                  label={t('session_news')}
                  color="#FB7185"
                  enabled={sessionSettings.showNews}
                  onToggle={() =>
                    setSessionSettings({
                      showNews: !sessionSettings.showNews,
                    })
                  }
                />
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-sans text-[11px] font-medium leading-4 text-text-muted">
                    {t('session_opacity')}
                  </span>
                  <span className="tnum font-mono text-[11px] leading-4 text-text-secondary">
                    {sessionSettings.opacity}%
                  </span>
                </div>
                <input
                  type="range"
                  min={20}
                  max={150}
                  value={sessionSettings.opacity}
                  onChange={(e) =>
                    setSessionSettings({ opacity: Number(e.target.value) })
                  }
                  className="h-1 w-full accent-brand"
                />
                <div className="mt-1 flex justify-between font-sans text-[11px] leading-4 text-text-muted">
                  <span>Тихо</span>
                  <span>Ярко</span>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )

  const footer = (
    <div className="flex w-full items-center gap-2">
      <Button variant="ghost" size="sm" onClick={resetAll}>
        {t('chart_reset_all')}
      </Button>
      <Button
        variant="primary"
        size="md"
        onClick={onClose}
        className="ml-auto"
      >
        {t('chart_apply')}
      </Button>
    </div>
  )

  if (isDesktop) {
    return (
      <Modal
        open={isOpen}
        onClose={onClose}
        title={t('chart_settings')}
        footer={footer}
        size="sm"
      >
        {content}
      </Modal>
    )
  }

  return (
    <Sheet
      open={isOpen}
      onClose={onClose}
      title={t('chart_settings')}
      footer={footer}
    >
      {content}
    </Sheet>
  )
}

export default ChartSettings
