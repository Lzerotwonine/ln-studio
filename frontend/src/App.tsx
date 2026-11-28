import { useCallback, useEffect, useState } from 'react'
import { HelpDrawer } from './components/HelpDrawer'
import { Sidebar } from './components/Sidebar'
import { TopHeader } from './components/TopHeader'
import { fetchHealth, fetchSeriesList, fetchVolumes } from './lib/api'
import {
  type AppearanceSettings,
  applyAppearanceToDom,
  isDarkPreset,
  loadAppearanceSettings,
  saveAppearanceSettings,
} from './lib/appearance'
import { ChaptersPage } from './pages/ChaptersPage'
import { ContinuityTab } from './pages/ContinuityTab'
import { DashboardPage } from './pages/DashboardPage'
import { GlossaryTab } from './pages/GlossaryTab'
import { GuidePage } from './pages/GuidePage'
import { ProofreadTab } from './pages/ProofreadTab'
import { SettingsPage } from './pages/SettingsPage'
import { TranslateTab } from './pages/TranslateTab'
import type { NavSection, Series, Volume } from './types'

const STORAGE_SERIES_KEY = 'ln-studio-active-series-id'
const STORAGE_VOLUME_KEY = 'ln-studio-active-volume-id'

export function App() {
  const [activeSection, setActiveSection] = useState<NavSection>('dashboard')
  const [seriesList, setSeriesList] = useState<Series[]>([])
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [selectedSeries, setSelectedSeries] = useState<Series | null>(null)
  const [selectedVolume, setSelectedVolume] = useState<Volume | null>(null)
  const [backendOnline, setBackendOnline] = useState(true)
  const [helpOpen, setHelpOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [appearance, setAppearance] = useState<AppearanceSettings>(() =>
    loadAppearanceSettings(),
  )

  useEffect(() => {
    applyAppearanceToDom(appearance)
    saveAppearanceSettings(appearance)
  }, [appearance])

  const isDark = isDarkPreset(appearance.themePreset)

  const handleToggleDarkQuick = () => {
    setAppearance((prev) => ({
      ...prev,
      themePreset: isDarkPreset(prev.themePreset) ? 'light' : 'dark',
    }))
  }

  // Load global series catalog
  const refreshSeries = useCallback(async (preferredSeriesId?: number | null) => {
    try {
      const list = await fetchSeriesList()
      setSeriesList(list)
      setSelectedSeries((prev) => {
        if (list.length === 0) return null
        const storedId = Number(
          window.localStorage.getItem(STORAGE_SERIES_KEY) || 0,
        )
        const targetId = preferredSeriesId ?? prev?.id ?? storedId
        return list.find((s) => s.id === targetId) ?? list[0]
      })
    } catch {
      // handled via backendOnline banner
    }
  }, [])

  // Load volumes whenever selectedSeries changes
  const refreshVolumes = useCallback(
    async (seriesId: number | null, preferredVolumeId?: number | null) => {
      if (!seriesId) {
        setVolumes([])
        setSelectedVolume(null)
        return
      }
      try {
        const vList = await fetchVolumes(seriesId)
        setVolumes(vList)
        setSelectedVolume((prev) => {
          if (vList.length === 0) return null
          const storedVolId = Number(
            window.localStorage.getItem(STORAGE_VOLUME_KEY) || 0,
          )
          const sameSeriesPrev =
            prev && prev.series_id === seriesId ? prev.id : null
          const targetId = preferredVolumeId ?? sameSeriesPrev ?? storedVolId
          return vList.find((v) => v.id === targetId) ?? vList[0]
        })
      } catch {
        setVolumes([])
        setSelectedVolume(null)
      }
    },
    [],
  )

  useEffect(() => {
    void refreshSeries()
  }, [refreshSeries])

  useEffect(() => {
    if (selectedSeries) {
      window.localStorage.setItem(STORAGE_SERIES_KEY, String(selectedSeries.id))
      void refreshVolumes(selectedSeries.id)
    } else {
      window.localStorage.removeItem(STORAGE_SERIES_KEY)
      setVolumes([])
      setSelectedVolume(null)
    }
  }, [selectedSeries?.id, refreshVolumes])

  useEffect(() => {
    if (selectedVolume) {
      window.localStorage.setItem(STORAGE_VOLUME_KEY, String(selectedVolume.id))
    } else {
      window.localStorage.removeItem(STORAGE_VOLUME_KEY)
    }
  }, [selectedVolume])

  useEffect(() => {
    let active = true
    const check = async () => {
      try {
        await fetchHealth()
        if (active) setBackendOnline(true)
      } catch {
        if (active) setBackendOnline(false)
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), 15000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const handleSelectSeries = (series: Series | null) => {
    if (series?.id !== selectedSeries?.id) {
      setSelectedVolume(null)
      setVolumes([])
    }
    setSelectedSeries(series)
  }

  return (
    <div className="h-screen flex overflow-hidden bg-slate-50 dark:bg-zinc-950 text-slate-900 dark:text-zinc-100">
      <Sidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        isDark={isDark}
        onToggleTheme={handleToggleDarkQuick}
        backendOnline={backendOnline}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <TopHeader
          seriesList={seriesList}
          volumes={volumes}
          selectedSeries={selectedSeries}
          selectedVolume={selectedVolume}
          onSelectSeries={handleSelectSeries}
          onSelectVolume={setSelectedVolume}
          onOpenHelp={() => setHelpOpen(true)}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
        />

        <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          {activeSection === 'dashboard' && (
            <DashboardPage
              seriesList={seriesList}
              volumes={volumes}
              selectedSeries={selectedSeries}
              selectedVolume={selectedVolume}
              onSelectSeries={handleSelectSeries}
              onSelectVolume={setSelectedVolume}
              onRefreshSeries={refreshSeries}
              onRefreshVolumes={refreshVolumes}
              onOpenChapters={() => setActiveSection('chapters')}
            />
          )}

          {activeSection === 'chapters' && (
            <ChaptersPage
              selectedSeries={selectedSeries}
              selectedVolume={selectedVolume}
              onBackToDashboard={() => setActiveSection('dashboard')}
              onNavigate={setActiveSection}
              onRefreshVolumes={refreshVolumes}
            />
          )}

          {activeSection === 'glossary' && (
            <GlossaryTab
              selectedSeries={selectedSeries}
              selectedVolume={selectedVolume}
              onBackToDashboard={() => setActiveSection('dashboard')}
            />
          )}

          {activeSection === 'characters' && (
            <ContinuityTab
              selectedSeries={selectedSeries}
              selectedVolume={selectedVolume}
              onBackToDashboard={() => setActiveSection('dashboard')}
            />
          )}

          {activeSection === 'translate' && (
            <TranslateTab
              selectedSeries={selectedSeries}
              selectedVolume={selectedVolume}
              onBackToDashboard={() => setActiveSection('dashboard')}
            />
          )}

          {activeSection === 'proofread' && (
            <ProofreadTab
              selectedSeries={selectedSeries}
              selectedVolume={selectedVolume}
              onBackToDashboard={() => setActiveSection('dashboard')}
            />
          )}

          {activeSection === 'settings' && (
            <SettingsPage
              selectedSeries={selectedSeries}
              appearance={appearance}
              onChangeAppearance={setAppearance}
            />
          )}

          {activeSection === 'guide' && (
            <GuidePage onNavigate={setActiveSection} />
          )}
        </main>
      </div>

      <HelpDrawer
        open={helpOpen}
        activeSection={activeSection}
        onClose={() => setHelpOpen(false)}
        onOpenFullGuide={() => setActiveSection('guide')}
      />
    </div>
  )
}

export default App
