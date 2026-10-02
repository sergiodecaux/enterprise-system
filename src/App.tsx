import { lazy, Suspense, useEffect, useState } from 'react'
import { Target, Radar as RadarIcon, Activity, Zap } from 'lucide-react'
import Header from './components/layout/Header'
import SniperView from './components/sniper/SniperView'
import ErrorBoundary from './components/ErrorBoundary'
import AdvisorPanel from './components/advisor/AdvisorPanel'
import NewsStrip from './components/news/NewsStrip'
import { useMexcScanner } from './hooks/useMexcScanner'
import { useNewsIntelligence } from './hooks/useNewsIntelligence'
import { useRadar141Screener } from './hooks/useRadar141Screener'
import { useTelegramWebApp } from './hooks/useTelegramWebApp'
import { useTelegramAlerts } from './hooks/useTelegramAlerts'
import { useSignalJournalResolver } from './hooks/useSignalJournalResolver'
import { useDesktopLayout } from './hooks/useDesktopLayout'
import { useAppStore } from './store/useAppStore'

const RadarView = lazy(() => import('./components/radar/RadarView'))
const TradesView = lazy(() => import('./components/trades/TradesView'))
const SignalsView = lazy(() => import('./components/signals/SignalsView'))
const TacticalDrawer = lazy(() => import('./components/tactical/TacticalDrawer'))

type ActiveTab = 'sniper' | 'trades' | 'radar' | 'signals'

function TabBar({
  activeTab,
  onSelect,
}: {
  activeTab: ActiveTab
  onSelect: (tab: ActiveTab) => void
}) {
  const tabs: { id: ActiveTab; label: string; icon: typeof Target; active: string }[] = [
    { id: 'sniper', label: 'Снайпер', icon: Target, active: 'border-matrix text-matrix' },
    { id: 'trades', label: 'Сделки', icon: Activity, active: 'border-matrix text-matrix' },
    { id: 'radar', label: 'Радар', icon: RadarIcon, active: 'border-matrix text-matrix' },
    { id: 'signals', label: 'Сигналы', icon: Zap, active: 'border-amber-400 text-amber-300' },
  ]

  return (
    <div className="flex">
      {tabs.map(({ id, label, icon: Icon, active }) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect(id)}
          className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2.5 font-mono text-[11px] font-bold uppercase transition-colors sm:gap-2 sm:py-3 sm:text-sm ${
            activeTab === id
              ? active
              : 'border-transparent text-holo/40 hover:text-holo/70'
          }`}
        >
          <Icon className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
          {label}
        </button>
      ))}
    </div>
  )
}

function App() {
  useTelegramWebApp()
  useTelegramAlerts()
  useMexcScanner()
  useNewsIntelligence()
  useSignalJournalResolver()

  const isDesktop = useDesktopLayout()
  const [activeTab, setActiveTab] = useState<ActiveTab>('sniper')
  const [radarArmed, setRadarArmed] = useState(false)
  const [drawerMounted, setDrawerMounted] = useState(false)

  useRadar141Screener(radarArmed)

  const isDrawerOpen = useAppStore((s) => s.isDrawerOpen)
  const newsSettings = useAppStore((s) => s.newsSettings)
  const newsItems = useAppStore((s) => s.newsIntel.items)
  const showStrip =
    newsSettings.enabled && newsSettings.showStrip && newsItems.length > 0

  useEffect(() => {
    if (isDrawerOpen || isDesktop) setDrawerMounted(true)
  }, [isDrawerOpen, isDesktop])

  const selectTab = (tab: ActiveTab) => {
    setActiveTab(tab)
    if (tab === 'radar') setRadarArmed(true)
  }

  const views = (
    <>
      {showStrip && <NewsStrip items={newsItems} />}
      {activeTab === 'sniper' && <SniperView />}
      <Suspense fallback={null}>
        {activeTab === 'trades' && <TradesView />}
        {activeTab === 'radar' && <RadarView />}
        {activeTab === 'signals' && <SignalsView />}
      </Suspense>
    </>
  )

  return (
    <ErrorBoundary>
      <div
        className={`bg-space font-mono text-holo ${
          isDesktop ? 'h-dvh overflow-hidden' : 'min-h-screen'
        }`}
      >
        <Header />

        {isDesktop ? (
          <div className="flex h-full pt-14">
            <div className="flex w-[min(420px,36vw)] min-w-[300px] max-w-[460px] flex-col border-r border-hull-border">
              <div className="shrink-0 border-b border-hull-border bg-space/95">
                <TabBar activeTab={activeTab} onSelect={selectTab} />
              </div>
              <main className="min-h-0 flex-1 overflow-y-auto">{views}</main>
            </div>
            <div className="min-h-0 min-w-0 flex-1">
              {drawerMounted && (
                <Suspense fallback={null}>
                  <TacticalDrawer />
                </Suspense>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="sticky top-14 z-20 border-b border-hull-border bg-space/95 backdrop-blur-sm">
              <TabBar activeTab={activeTab} onSelect={selectTab} />
            </div>
            <main className="px-0 pb-20">{views}</main>
            {drawerMounted && (
              <Suspense fallback={null}>
                <TacticalDrawer />
              </Suspense>
            )}
          </>
        )}

        <AdvisorPanel />
      </div>
    </ErrorBoundary>
  )
}

export default App
