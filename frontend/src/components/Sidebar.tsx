import {
  BookMarked,
  BookOpen,
  CheckCheck,
  HelpCircle,
  Languages,
  Moon,
  Settings,
  Sun,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react'
import type { NavSection } from '../types'

interface SidebarProps {
  activeSection: NavSection
  onSelectSection: (section: NavSection) => void
  isDark: boolean
  onToggleTheme: () => void
  backendOnline: boolean
}

const NAV_ITEMS: Array<{
  id: NavSection
  label: string
  icon: typeof BookOpen
}> = [
  { id: 'dashboard', label: 'Quản lý Truyện', icon: BookOpen },
  { id: 'glossary', label: 'Thuật ngữ', icon: BookMarked },
  { id: 'characters', label: 'Nhân vật & Xưng hô', icon: Users },
  { id: 'translate', label: 'Dịch thuật', icon: Languages },
  { id: 'proofread', label: 'Hiệu đính', icon: CheckCheck },
  { id: 'settings', label: 'Cài đặt', icon: Settings },
  { id: 'guide', label: 'Hướng dẫn tổng quan', icon: HelpCircle },
]

export function Sidebar({
  activeSection,
  onSelectSection,
  isDark,
  onToggleTheme,
  backendOnline,
}: SidebarProps) {
  return (
    <aside className="w-60 shrink-0 border-r border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/95 flex flex-col justify-between select-none">
      <div>
        {/* Brand */}
        <div className="h-14 px-5 flex items-center gap-3 border-b border-slate-200 dark:border-zinc-800">
          <div className="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shadow-xs">
            LN
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-slate-900 dark:text-zinc-100 leading-tight truncate">
              LN-Studio
            </h1>
            <p className="text-[11px] text-slate-500 dark:text-zinc-400 truncate">
              Light Novel Workbench
            </p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="px-3 py-4 space-y-1" aria-label="Điều hướng chính">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = activeSection === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectSection(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
                  active
                    ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-zinc-800/80 dark:hover:text-zinc-100'
                }`}
              >
                <Icon
                  className={`w-4 h-4 shrink-0 ${
                    active
                      ? 'text-indigo-600 dark:text-indigo-400'
                      : 'text-slate-400 dark:text-zinc-500'
                  }`}
                />
                <span className="truncate">{item.label}</span>
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
