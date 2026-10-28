import { lazy, Suspense, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import Header from './components/layout/Header'
import DesktopStatusBar from './components/layout/DesktopStatusBar'
import DesktopNavRail from './components/layout/DesktopNavRail'
import { WORKSPACES, workspaceById, type WorkspaceId } from './components/layout/workspaces'
import SniperView from './components/sniper/SniperView'
import CoinSearch from './components/radar/CoinSearch'
import ErrorBoundary from './components/ErrorBoundary'
import AdvisorPanel from './components/advisor/AdvisorPanel'
import NewsStrip from './components/news/NewsStrip'
import { useMexcScanner } from './hooks/useMexcScanner'
import { useNewsIntelligence } from './hooks/useNewsIntelligence'
import { useRadar141Screener } from './hooks/useRadar141Screener'
import { useTelegramWebApp } from './hooks/useTelegramWebApp'
import { useTelegramAlerts } from './hooks/useTelegramAlerts'
import { useTelegramFavoritesSync } from './hooks/useTelegramFavoritesSync'
import { useSniperSignalFire } from './hooks/useSniperSignalFire'
import { useSignalJournalResolver } from './hooks/useSignalJournalResolver'
import { useDesktopLayout } from './hooks/useDesktopLayout'
import { useAppStore } from './store/useAppStore'

const RadarView = lazy(() => import('./components/radar/RadarView'))
const TradesView = lazy(() => import('./components/trades/TradesView'))
const SignalsView = lazy(() => import('./components/signals/SignalsView'))
const TacticalDrawer = lazy(() => import('./components/tactical/TacticalDrawer'))

const PANEL_MIN = 300
const PANEL_MAX = 560
const PANEL_DEFAULT = 380
const PANEL_WIDTH_KEY = 'enterprise.desktop.panelWidth'
const NAV_RAIL_WIDTH = 76
const DIVIDER_WIDTH = 7
const TERMINAL_MIN = 680

const panelLimitForViewport = () => {
  if (typeof window === 'undefined') return PANEL_MAX
  return Math.min(
    PANEL_MAX,
    Math.max(PANEL_MIN, window.innerWidth - NAV_RAIL_WIDTH - DIVIDER_WIDTH - TERMINAL_MIN)
  )
}

function loadPanelWidth(): number {
  if (typeof window === 'undefined') return PANEL_DEFAULT
  try {
    const saved = Number(window.localStorage.getItem(PANEL_WIDTH_KEY))
    if (Number.isFinite(saved) && saved >= PANEL_MIN && saved <= PANEL_MAX) {
      return saved
    }
  } catch {
    /* localStorage can be blocked */
  }
  return PANEL_DEFAULT
}

function MobileTabBar({
  activeTab,
  onSelect,
}: {
  activeTab: WorkspaceId
  onSelect: (tab: WorkspaceId) => void
}) {
  return (
    <div className="flex gap-1 px-2 py-2">
      {WORKSPACES.map(({ id, label, icon: Icon }) => {
        const active = activeTab === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            className={`flex flex-1 flex-col items-center gap-1 rounded-lg px-1 py-1.5 font-sans text-[10px] font-semibold transition-colors ${
              active
                ? 'bg-matrix/10 text-matrix'
                : 'text-holo/40 hover:bg-white/5 hover:text-holo/70'
            }`}
          >
            <Icon className="h-4 w-4" strokeWidth={2} />
            {label}
          </button>
        )
      })}
    </div>
  )
}

function App() {
  useTelegramWebApp()
  useTelegramAlerts()
  useTelegramFavoritesSync()
  useSniperSignalFire()
  useMexcScanner()
  useNewsIntelligence()
  useSignalJournalResolver()

  const isDesktop = useDesktopLayout()
  const [activeTab, setActiveTab] = useState<WorkspaceId>('sniper')
  const [radarArmed, setRadarArmed] = useState(false)
  const [drawerMounted, setDrawerMounted] = useState(false)
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth)
  const [panelLimit, setPanelLimit] = useState(panelLimitForViewport)
  const [isResizing, setIsResizing] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const effectivePanelWidth = Math.min(panelWidth, panelLimit)

  useRadar141Screener(radarArmed)

  const isDrawerOpen = useAppStore((s) => s.isDrawerOpen)
  const isScanning = useAppStore((s) => s.isScanning)
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const lastUpdate = useAppStore((s) => s.lastUpdate)
  const newsSettings = useAppStore((s) => s.newsSettings)
  const newsItems = useAppStore((s) => s.newsIntel.items)

  const showStrip =
    newsSettings.enabled && newsSettings.showStrip && newsItems.length > 0
  const meta = workspaceById(activeTab)
  const ActiveIcon = meta.icon

  useEffect(() => {
    if (isDrawerOpen || isDesktop) setDrawerMounted(true)
  }, [isDrawerOpen, isDesktop])

  useEffect(() => {
    if (!isDesktop) return
    try {
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth))
    } catch {
      /* ignore */
    }
  }, [panelWidth, isDesktop])

  useEffect(() => {
    if (!isDesktop) return
    const syncPanelLimit = () => setPanelLimit(panelLimitForViewport())
    syncPanelLimit()
    window.addEventListener('resize', syncPanelLimit)
    return () => window.removeEventListener('resize', syncPanelLimit)
  }, [isDesktop])

  const selectTab = useCallback((tab: WorkspaceId) => {
    setActiveTab(tab)
    if (tab === 'radar') setRadarArmed(true)
  }, [])

  useEffect(() => {
    if (!isDesktop) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        document.getElementById('global-coin-search')?.focus()
        return
      }

      if (typing) return
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        const workspace = WORKSPACES[Number(event.key) - 1]
        if (workspace) {
          event.preventDefault()
          selectTab(workspace.id)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isDesktop, selectTab])

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { startX: event.clientX, startWidth: effectivePanelWidth }
    setIsResizing(true)
  }

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const next =
      dragRef.current.startWidth + event.clientX - dragRef.current.startX
    setPanelWidth(Math.min(panelLimit, Math.max(PANEL_MIN, next)))
  }

  const onResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    setIsResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
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

  const updatedAt = new Date(lastUpdate).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  return (
    <ErrorBoundary>
      <div
        className={`bg-space font-sans text-holo ${
          isDesktop
            ? `desktop-shell flex h-dvh flex-col overflow-hidden ${
                isResizing ? 'cursor-col-resize select-none' : ''
              }`
            : 'min-h-screen'
        }`}
      >
        <Header />

        {isDesktop ? (
          <>
            <div className="flex min-h-0 flex-1 pt-14">
              <DesktopNavRail activeTab={activeTab} onSelect={selectTab} />

              <aside
                style={{ width: effectivePanelWidth }}
                className="flex shrink-0 flex-col border-r border-hull-border/80 bg-hull/25"
              >
                <div className="shrink-0 border-b border-hull-border/70 bg-hull/40 px-3 py-2.5">
                  <div className="mb-2 flex items-center justify-between gap-2 px-0.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <ActiveIcon className="h-3.5 w-3.5 shrink-0 text-matrix/85" />
                      <span className="truncate font-sans text-[10px] font-semibold uppercase tracking-[0.16em] text-holo/45">
                        {meta.label}
                      </span>
                    </div>
                    <span
                      className="flex shrink-0 items-center gap-1.5 font-mono text-[9px] text-holo/30"
                      title={
                        isScanning
                          ? 'Идёт сканирование'
                          : connectionStatus === 'ONLINE'
                            ? 'Данные MEXC в реальном времени'
                            : connectionStatus === 'POLLING'
                              ? 'Резервный опрос MEXC'
                              : 'Нет связи с MEXC'
                      }
                    >
                      {isScanning ? (
                        <>
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                          скан
                        </>
                      ) : (
                        <>
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              connectionStatus === 'ONLINE'
                                ? 'bg-matrix/70'
                                : connectionStatus === 'POLLING'
                                  ? 'bg-amber-300'
                                  : 'bg-alert'
                            }`}
                          />
                          {updatedAt}
                        </>
                      )}
                    </span>
                  </div>
                  {activeTab !== 'signals' && (
                    <CoinSearch
                      className="pb-0"
                      inputId="global-coin-search"
                    />
                  )}
                  {activeTab === 'signals' && (
                    <p className="font-sans text-[10px] leading-relaxed text-holo/35">
                      Выберите стиль и сторону в панели ниже — поиск уже внутри
                      сценария.
                    </p>
                  )}
                </div>

                <main className="min-h-0 flex-1 overflow-y-auto">{views}</main>
              </aside>

              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Изменить ширину панели"
                aria-valuenow={effectivePanelWidth}
                aria-valuemin={PANEL_MIN}
                aria-valuemax={panelLimit}
                onPointerDown={onResizeStart}
                onPointerMove={onResizeMove}
                onPointerUp={onResizeEnd}
                onPointerCancel={onResizeEnd}
                onDoubleClick={() => setPanelWidth(PANEL_DEFAULT)}
                title="Потяните, чтобы изменить ширину · двойной клик — сброс"
                className="group relative z-10 w-[7px] shrink-0 cursor-col-resize"
              >
                <span
                  className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
                    isResizing
                      ? 'bg-matrix/70'
                      : 'bg-hull-border/70 group-hover:bg-matrix/40'
                  }`}
                />
                <span className="absolute left-1/2 top-1/2 flex h-9 w-[3px] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-0.5 rounded-full opacity-0 transition-opacity group-hover:opacity-100">
                  <span className="h-0.5 w-0.5 rounded-full bg-matrix/80" />
                  <span className="h-0.5 w-0.5 rounded-full bg-matrix/80" />
                  <span className="h-0.5 w-0.5 rounded-full bg-matrix/80" />
                </span>
              </div>

              <div className="min-h-0 min-w-0 flex-1">
                {drawerMounted && (
                  <Suspense fallback={null}>
                    <TacticalDrawer />
                  </Suspense>
                )}
              </div>
            </div>
            <DesktopStatusBar />
          </>
        ) : (
          <>
            <div className="sticky top-14 z-20 border-b border-hull-border/70 bg-space/95 backdrop-blur-sm">
              <MobileTabBar activeTab={activeTab} onSelect={selectTab} />
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
