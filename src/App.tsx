import { useState } from 'react'
import { Target, Radar as RadarIcon, Activity, Flame } from 'lucide-react'
import Header from './components/layout/Header'
import RadarView from './components/radar/RadarView'
import SniperView from './components/sniper/SniperView'
import TradesView from './components/trades/TradesView'
import MemePulseView from './components/meme/MemePulseView'
import TacticalDrawer from './components/tactical/TacticalDrawer'
import ErrorBoundary from './components/ErrorBoundary'
import NewsStrip from './components/news/NewsStrip'
import { useMexcScanner } from './hooks/useMexcScanner'
import { useNewsIntelligence } from './hooks/useNewsIntelligence'
import { useTelegramWebApp } from './hooks/useTelegramWebApp'
import { useAppStore } from './store/useAppStore'

type ActiveTab = 'sniper' | 'meme' | 'trades' | 'radar'

function App() {
  useTelegramWebApp()
  useMexcScanner()
  useNewsIntelligence()

  const [activeTab, setActiveTab] = useState<ActiveTab>('sniper')

  const newsSettings = useAppStore((s) => s.newsSettings)
  const newsItems = useAppStore((s) => s.newsIntel.items)
  const showStrip =
    newsSettings.enabled && newsSettings.showStrip && newsItems.length > 0

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-space font-mono text-holo">
        <Header />

        <div className="sticky top-14 z-20 border-b border-hull-border bg-space/95 backdrop-blur-sm">
          <div className="flex">
            <button
              type="button"
              onClick={() => setActiveTab('sniper')}
              className={`flex flex-1 items-center justify-center gap-2 border-b-2 py-3 font-mono text-sm font-bold uppercase transition-colors ${
                activeTab === 'sniper'
                  ? 'border-matrix text-matrix'
                  : 'border-transparent text-holo/40 hover:text-holo/70'
              }`}
            >
              <Target className="h-4 w-4" />
              Снайпер
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('meme')}
              className={`flex flex-1 items-center justify-center gap-2 border-b-2 py-3 font-mono text-sm font-bold uppercase transition-colors ${
                activeTab === 'meme'
                  ? 'border-alert text-alert'
                  : 'border-transparent text-holo/40 hover:text-holo/70'
              }`}
            >
              <Flame className="h-4 w-4" />
              Мемы
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('trades')}
              className={`flex flex-1 items-center justify-center gap-2 border-b-2 py-3 font-mono text-sm font-bold uppercase transition-colors ${
                activeTab === 'trades'
                  ? 'border-matrix text-matrix'
                  : 'border-transparent text-holo/40 hover:text-holo/70'
              }`}
            >
              <Activity className="h-4 w-4" />
              Сделки
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('radar')}
              className={`flex flex-1 items-center justify-center gap-2 border-b-2 py-3 font-mono text-sm font-bold uppercase transition-colors ${
                activeTab === 'radar'
                  ? 'border-matrix text-matrix'
                  : 'border-transparent text-holo/40 hover:text-holo/70'
              }`}
            >
              <RadarIcon className="h-4 w-4" />
              Радар
            </button>
          </div>
        </div>

        <main className="px-0 pb-20">
          {showStrip && <NewsStrip items={newsItems} />}
          {activeTab === 'sniper' && <SniperView />}
          {activeTab === 'meme' && <MemePulseView />}
          {activeTab === 'trades' && <TradesView />}
          {activeTab === 'radar' && <RadarView />}
        </main>

        <TacticalDrawer />
      </div>
    </ErrorBoundary>
  )
}

export default App
