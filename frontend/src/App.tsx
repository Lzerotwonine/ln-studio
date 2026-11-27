import { useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { fetchHealth } from './lib/api'
import { ContinuityTab } from './pages/ContinuityTab'
import { DashboardPage } from './pages/DashboardPage'
import { GlossaryTab } from './pages/GlossaryTab'
import { ProofreadTab } from './pages/ProofreadTab'
import { SettingsPage } from './pages/SettingsPage'
import { TranslateTab } from './pages/TranslateTab'
import type { NavSection, Series, Volume } from './types'

export function App() {
  const [activeSection, setActiveSection] = useState<NavSection>('dashboard')
  const [selectedSeries, setSelectedSeries] = useState<Series | null>(null)
  const [selectedVolume, setSelectedVolume] = useState<Volume | null>(null)
  const [backendOnline, setBackendOnline] = useState(true)
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    const stored = window.localStorage.getItem('ln-studio-theme')
    if (stored === 'dark') return true
    if (stored === 'light') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    const root = document.documentElement
    if (isDark) {
      root.classList.add('dark')
      window.localStorage.setItem('ln-studio-theme', 'dark')
    } else {
      root.classList.remove('dark')
      window.localStorage.setItem('ln-studio-theme', 'light')
    }
  }, [isDark])

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

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-zinc-950 text-slate-900 dark:text-zinc-100">
      <Sidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        selectedSeries={selectedSeries}
        selectedVolume={selectedVolume}
        isDark={isDark}
        onToggleTheme={() => setIsDark((prev) => !prev)}
        backendOnline={backendOnline}
      />

      <main className="flex-1 min-w-0 overflow-y-auto">
        {activeSection === 'dashboard' && (
          <DashboardPage
            selectedSeries={selectedSeries}
            selectedVolume={selectedVolume}
            onSelectSeries={setSelectedSeries}
            onSelectVolume={setSelectedVolume}
          />
        )}

        {activeSection === 'glossary' && (
          <GlossaryTab
            selectedSeries={selectedSeries}
            selectedVolume={selectedVolume}
            onSelectSeries={setSelectedSeries}
            onSelectVolume={setSelectedVolume}
            onBackToDashboard={() => setActiveSection('dashboard')}
          />
        )}

        {activeSection === 'characters' && (
          <ContinuityTab
            selectedSeries={selectedSeries}
            selectedVolume={selectedVolume}
            onSelectSeries={setSelectedSeries}
            onSelectVolume={setSelectedVolume}
            onBackToDashboard={() => setActiveSection('dashboard')}
          />
        )}

        {activeSection === 'translate' && (
          <TranslateTab
            selectedSeries={selectedSeries}
            selectedVolume={selectedVolume}
            onSelectSeries={setSelectedSeries}
            onSelectVolume={setSelectedVolume}
            onBackToDashboard={() => setActiveSection('dashboard')}
          />
        )}

        {activeSection === 'proofread' && (
          <ProofreadTab
            selectedSeries={selectedSeries}
            selectedVolume={selectedVolume}
            onSelectSeries={setSelectedSeries}
            onSelectVolume={setSelectedVolume}
            onBackToDashboard={() => setActiveSection('dashboard')}
          />
        )}

        {activeSection === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}

export default App
