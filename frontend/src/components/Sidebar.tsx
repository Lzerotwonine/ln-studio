import {
  BookMarked,
  BookOpen,
  CheckCheck,
  Languages,
  Moon,
  Settings,
  Sun,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react'
import type { NavSection, Series, Volume } from '../types'
import { LANG_META } from '../types'

interface SidebarProps {
  activeSection: NavSection
  onSelectSection: (section: NavSection) => void
  selectedSeries: Series | null
  selectedVolume: Volume | null
  isDark: boolean
  onToggleTheme: () => void
  backendOnline: boolean
}

const NAV_ITEMS: Array<{
  id: NavSection
  label: string
  icon: typeof BookOpen
  phaseTag?: string
}> = [
  { id: 'dashboard', label: 'Quản lý Truyện', icon: BookOpen },
  { id: 'glossary', label: 'Thuật ngữ', icon: BookMarked },
  { id: 'characters', label: 'Nhân vật & Xưng hô', icon: Users },
  { id: 'translate', label: 'Dịch thuật', icon: Languages, phaseTag: 'P4' },
  { id: 'proofread', label: 'Hiệu đính', icon: CheckCheck, phaseTag: 'P5' },
  { id: 'settings', label: 'Cài đặt', icon: Settings },
]

export function Sidebar({
  activeSection,
  onSelectSection,
  selectedSeries,
  selectedVolume,
  isDark,
  onToggleTheme,
  backendOnline,
}: SidebarProps) {
  return (
    <aside className="w-64 shrink-0 border-r border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/95 flex flex-col justify-between select-none">
      <div>
        {/* Brand */}
        <div className="h-16 px-5 flex items-center gap-3 border-b border-slate-200 dark:border-zinc-800">
          <div className="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold text-sm shadow-sm">
            LN
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 leading-tight truncate">
              LN-Studio
            </h1>
            <p className="text-xs text-slate-500 dark:text-zinc-400 truncate">
              Light Novel Workbench
            </p>
          </div>
        </div>

        {/* Active Context Card */}
        <div className="px-3 pt-4 pb-2">
          <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950/60 p-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400 dark:text-zinc-500 mb-1">
              Ngữ cảnh làm việc
            </div>
            {selectedSeries ? (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded border ${LANG_META[selectedSeries.source_lang].badgeClass}`}
                  >
                    {LANG_META[selectedSeries.source_lang].short}
                  </span>
                  <span className="text-xs font-semibold text-slate-800 dark:text-zinc-100 truncate">
                    {selectedSeries.title}
                  </span>
                </div>
                <div className="text-xs text-slate-500 dark:text-zinc-400 truncate">
                  {selectedVolume
                    ? `Tập ${selectedVolume.volume_number}: ${selectedVolume.title}`
                    : 'Chưa chọn tập cụ thể'}
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500 dark:text-zinc-400">
                Chọn hoặc tạo bộ truyện ở Dashboard
              </p>
            )}
          </div>
        </div>

        {/* Navigation */}
        <nav className="px-3 py-2 space-y-1" aria-label="Điều hướng chính">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = activeSection === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectSection(item.id)}
                className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                  active
                    ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-zinc-800/80 dark:hover:text-zinc-100'
                }`}
              >
                <span className="flex items-center gap-2.5 truncate">
                  <Icon
                    className={`w-4 h-4 shrink-0 ${
                      active
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : 'text-slate-400 dark:text-zinc-500'
                    }`}
                  />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.phaseTag && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-500">
                    {item.phaseTag}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      </div>

      {/* Footer status & theme toggle */}
      <div className="p-3 border-t border-slate-200 dark:border-zinc-800 space-y-2">
        <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-zinc-950/70 text-xs">
          <span className="flex items-center gap-1.5 text-slate-600 dark:text-zinc-400">
            {backendOnline ? (
              <Wifi className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-rose-500" />
            )}
            Backend API
          </span>
          <span
            className={`font-medium ${
              backendOnline
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-rose-600 dark:text-rose-400'
            }`}
          >
            {backendOnline ? 'Sẵn sàng' : 'Mất kết nối'}
          </span>
        </div>

        <button
          type="button"
          onClick={onToggleTheme}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-2">
            {isDark ? (
              <Sun className="w-4 h-4 text-amber-400" />
            ) : (
              <Moon className="w-4 h-4 text-slate-500" />
            )}
            {isDark ? 'Giao diện Sáng' : 'Giao diện Tối'}
          </span>
          <span className="text-[11px] text-slate-400 dark:text-zinc-500">
            {isDark ? 'Dark' : 'Light'}
          </span>
        </button>
      </div>
    </aside>
  )
}
