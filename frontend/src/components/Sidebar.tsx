import {
  BookMarked,
  BookOpen,
  CheckCheck,
  FileStack,
  HelpCircle,
  Languages,
  Moon,
  Settings,
  Sun,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import type { NavSection } from '../types'

interface SidebarProps {
  activeSection: NavSection
  onSelectSection: (section: NavSection) => void
  isDark: boolean
  onToggleTheme: () => void
  backendOnline: boolean
  mobileOpen: boolean
  onCloseMobile: () => void
}

const NAV_ITEMS: Array<{
  id: NavSection
  label: string
  icon: typeof BookOpen
}> = [
  { id: 'dashboard', label: 'Quản lý truyện', icon: BookOpen },
  { id: 'chapters', label: 'Kho chương', icon: FileStack },
  { id: 'glossary', label: 'Thuật ngữ', icon: BookMarked },
  { id: 'characters', label: 'Nhân vật và Xưng hô', icon: Users },
  { id: 'translate', label: 'Dịch thuật', icon: Languages },
  { id: 'proofread', label: 'Hiệu đính', icon: CheckCheck },
  { id: 'settings', label: 'Cài đặt', icon: Settings },
  { id: 'guide', label: 'Hướng dẫn', icon: HelpCircle },
]

export function Sidebar({
  activeSection,
  onSelectSection,
  isDark,
  onToggleTheme,
  backendOnline,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const handleSelect = (id: NavSection) => {
    onSelectSection(id)
    onCloseMobile()
  }

  const content = (
    <aside className="w-64 shrink-0 h-full border-r border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/95 flex flex-col justify-between select-none">
      <div>
        {/* Brand */}
        <div className="h-14 px-5 flex items-center justify-between gap-3 border-b border-slate-200 dark:border-zinc-800">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shadow-xs shrink-0">
              LN
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-bold text-slate-900 dark:text-zinc-100 leading-tight truncate">
                LN-Studio
              </h1>
              <p className="text-[11px] text-slate-500 dark:text-zinc-400 truncate">
                Không gian dịch truyện
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Đóng thanh điều hướng"
            className="lg:hidden p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation: 8 mục thuần Việt */}
        <nav className="px-3 py-4 space-y-1" aria-label="Điều hướng chính">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = activeSection === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelect(item.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
                  active
                    ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300 font-semibold'
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
        <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 dark:bg-zinc-950/70 text-xs">
          <span className="flex items-center gap-1.5 text-slate-600 dark:text-zinc-400">
            {backendOnline ? (
              <Wifi className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-rose-500" />
            )}
            Máy chủ API
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
            {isDark ? 'Chuyển nền Sáng' : 'Chuyển nền Tối'}
          </span>
          <span className="text-[11px] text-slate-400 dark:text-zinc-500">
            {isDark ? 'Tối' : 'Sáng'}
          </span>
        </button>
      </div>
    </aside>
  )

  return (
    <>
      {/* Desktop persistent sidebar (>= 1024px) */}
      <div className="hidden lg:flex h-full shrink-0">{content}</div>

      {/* Mobile / Tablet Slide-over Drawer (< 1024px) */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            onClick={onCloseMobile}
            aria-hidden="true"
            className="fixed inset-0 bg-slate-950/50 backdrop-blur-xs"
          />
          <div className="relative z-10 h-full shadow-2xl">{content}</div>
        </div>
      )}
    </>
  )
}
