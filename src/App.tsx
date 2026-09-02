import { lazy, Suspense, useEffect, useState } from 'react'
import { Target, Radar as RadarIcon, Activity, Zap } from 'lucide-react'
import Header from './components/layout/Header'
import SniperView from './components/sniper/SniperView'
import ErrorBoundary from './components/ErrorBoundary'
import NewsStrip from './components/news/NewsStrip'
import { useMexcScanner } from './hooks/useMexcScanner'
import { useNewsIntelligence } from './hooks/useNewsIntelligence'
import { useRadar141Screener } from './hooks/useRadar141Screener'
import { useTelegramWebApp } from './hooks/useTelegramWebApp'
import { useTelegramAlerts } from './hooks/useTelegramAlerts'
import { useSignalJournalResolver } from './hooks/useSignalJournalResolver'
import { useAppStore } from './store/useAppStore'

const RadarView = lazy(() => import('./components/radar/RadarView'))
const TradesView = lazy(() => import('./components/trades/TradesView'))
const SignalsView = lazy(() => import('./components/signals/SignalsView'))
const TacticalDrawer = lazy(() => import('./components/tactical/TacticalDrawer'))

type ActiveTab = 'sniper' | 'trades' | 'radar' | 'signals'

function App() {
  useTelegramWebApp()
  useTelegramAlerts()
  useMexcScanner()
  useNewsIntelligence()
  useSignalJournalResolver()

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
    if (isDrawerOpen) setDrawerMounted(true)
  }, [isDrawerOpen])

  const selectTab = (tab: ActiveTab) => {
    setActiveTab(tab)
    if (tab === 'radar') setRadarArmed(true)
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-space font-mono text-holo">
        <Header />

        <div className="sticky top-14 z-20 border-b border-hull-border bg-space/95 backdrop-blur-sm">
          <div className="flex">
            <button
              type="button"
              onClick={() => selectTab('sniper')}
              className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2.5 font-mono text-[11px] font-bold uppercase transition-colors sm:gap-2 sm:py-3 sm:text-sm ${
                activeTab === 'sniper'
                  ? 'border-matrix text-matrix'
                  : 'border-transparent text-holo/40 hover:text-holo/70'
              }`}
            >
              <Target className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              Снайпер
            </button>

            <button
              type="button"
              onClick={() => selectTab('trades')}
              className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2.5 font-mono text-[11px] font-bold uppercase transition-colors sm:gap-2 sm:py-3 sm:text-sm ${
                activeTab === 'trades'
                  ? 'border-matrix text-matrix'
                  : 'border-transparent text-holo/40 hover:text-holo/70'
              }`}
            >
              <Activity className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              Сделки
            </button>

            <button
              type="button"
              onClick={() => selectTab('radar')}
              className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2.5 font-mono text-[11px] font-bold uppercase transition-colors sm:gap-2 sm:py-3 sm:text-sm ${
                activeTab === 'radar'
                  ? 'border-matrix text-matrix'
                  : 'border-transparent text-holo/40 hover:text-holo/70'
              }`}
            >
              <RadarIcon className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              Радар
            </button>

            <button
              type="button"
              onClick={() => selectTab('signals')}
              className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2.5 font-mono text-[11px] font-bold uppercase transition-colors sm:gap-2 sm:py-3 sm:text-sm ${
                activeTab === 'signals'
                  ? 'border-amber-400 text-amber-300'
                  : 'border-transparent text-holo/40 hover:text-holo/70'
              }`}
            >
              <Zap className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              Сигналы
            </button>
          </div>
        </div>

        <main className="px-0 pb-20">
          {showStrip && <NewsStrip items={newsItems} />}
          {activeTab === 'sniper' && <SniperView />}
          <Suspense fallback={null}>
            {activeTab === 'trades' && <TradesView />}
            {activeTab === 'radar' && <RadarView />}
            {activeTab === 'signals' && <SignalsView />}
          </Suspense>
        </main>

        {drawerMounted && (
          <Suspense fallback={null}>
            <TacticalDrawer />
          </Suspense>
        )}
      </div>
    </ErrorBoundary>
  )
}

export default App
