import { BookOpen, HelpCircle, Layers, Menu } from 'lucide-react'
import type { Series, Volume } from '../types'
import { formatVolumeLabel, LANG_META, MODE_META } from '../types'

interface TopHeaderProps {
  seriesList: Series[]
  volumes: Volume[]
  selectedSeries: Series | null
  selectedVolume: Volume | null
  onSelectSeries: (series: Series | null) => void
  onSelectVolume: (volume: Volume | null) => void
  onOpenHelp: () => void
  onOpenMobileMenu: () => void
}

export function TopHeader({
  seriesList,
  volumes,
  selectedSeries,
  selectedVolume,
  onSelectSeries,
  onSelectVolume,
  onOpenHelp,
  onOpenMobileMenu,
}: TopHeaderProps) {
  return (
    <header className="min-h-14 shrink-0 border-b border-slate-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xs px-3 sm:px-5 py-2 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2 z-20">
      {/* Row 1 (Mobile) / Left group (Desktop) */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Mobile Drawer Menu button (< 1024px) */}
          <button
            type="button"
            onClick={onOpenMobileMenu}
            aria-label="Mở trình đơn điều hướng"
            className="lg:hidden inline-flex items-center justify-center p-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 shrink-0 cursor-pointer"
          >
            <Menu className="w-4 h-4" />
          </button>

          {/* Global Series Selector */}
          <div className="flex items-center gap-1.5 min-w-0 flex-1 sm:flex-initial">
            <BookOpen className="w-4 h-4 text-indigo-500 shrink-0 hidden sm:block" />
            <label
              htmlFor="global-series-select"
              className="text-xs font-medium text-slate-500 dark:text-zinc-400 hidden md:inline shrink-0"
            >
              Truyện:
            </label>
            <select
              id="global-series-select"
              aria-label="Truyện đang làm việc"
              value={selectedSeries?.id ?? ''}
              onChange={(e) => {
                const found = seriesList.find(
                  (s) => s.id === Number(e.target.value),
                )
                onSelectSeries(found ?? null)
              }}
              disabled={seriesList.length === 0}
              className="w-full sm:w-auto px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 sm:max-w-[230px] truncate focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
            >
              {seriesList.length === 0 ? (
                <option value="">Chưa có truyện</option>
              ) : (
                seriesList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))
              )}
            </select>
          </div>

          <span className="text-slate-300 dark:text-zinc-700 hidden lg:inline">
            /
          </span>

          {/* Desktop Volume Selector inline */}
          <div className="hidden lg:flex items-center gap-1.5 min-w-0">
            <Layers className="w-4 h-4 text-slate-400 shrink-0" />
            <label
              htmlFor="global-volume-select-desktop"
              className="text-xs font-medium text-slate-500 dark:text-zinc-400 shrink-0"
            >
              Tập:
            </label>
            <select
              id="global-volume-select-desktop"
              aria-label="Tập đang làm việc"
              value={selectedVolume?.id ?? ''}
              onChange={(e) => {
                const found = volumes.find(
                  (v) => v.id === Number(e.target.value),
                )
                onSelectVolume(found ?? null)
              }}
              disabled={volumes.length === 0}
              className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-slate-800 dark:text-zinc-100 max-w-[240px] truncate focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
            >
              {volumes.length === 0 ? (
                <option value="">Chưa có tập</option>
              ) : (
                volumes.map((v) => (
                  <option key={v.id} value={v.id}>
                    #{v.volume_number} · {formatVolumeLabel(v)}
                  </option>
                ))
              )}
            </select>
          </div>
        </div>

        {/* Mobile Help Button on Row 1 */}
        <button
          type="button"
          onClick={onOpenHelp}
          className="lg:hidden inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-slate-700 dark:text-zinc-200 hover:bg-indigo-50 dark:hover:bg-indigo-500/15 shrink-0 cursor-pointer"
          title="Mở hướng dẫn thao tác cho màn hình hiện tại"
        >
          <HelpCircle className="w-3.5 h-3.5 text-indigo-500" />
          <span className="hidden xs:inline sm:inline">Hướng dẫn</span>
        </button>
      </div>

      {/* Row 2 on Mobile/Tablet (< 1024px): Volume Selector + Badges */}
      <div className="flex lg:hidden items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <Layers className="w-4 h-4 text-slate-400 shrink-0" />
          <select
            id="global-volume-select-mobile"
            aria-label="Tập đang làm việc"
            value={selectedVolume?.id ?? ''}
            onChange={(e) => {
              const found = volumes.find((v) => v.id === Number(e.target.value))
              onSelectVolume(found ?? null)
            }}
            disabled={volumes.length === 0}
            className="w-full px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-slate-800 dark:text-zinc-100 truncate focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
          >
            {volumes.length === 0 ? (
              <option value="">Chưa có tập</option>
            ) : (
              volumes.map((v) => (
                <option key={v.id} value={v.id}>
                  #{v.volume_number} · {formatVolumeLabel(v)}
                </option>
              ))
            )}
          </select>
        </div>

        {selectedSeries && (
          <div className="flex items-center gap-1 shrink-0">
            <span
              className={`inline-flex items-center px-2 py-0.5 text-[11px] font-semibold rounded-md border ${LANG_META[selectedSeries.source_lang].badgeClass}`}
            >
              {LANG_META[selectedSeries.source_lang].short}
            </span>
          </div>
        )}
      </div>

      {/* Desktop Right metadata pills + Contextual Help button */}
      <div className="hidden lg:flex items-center gap-2 shrink-0">
        {selectedSeries && (
          <div className="flex items-center gap-1.5">
            <span
              className={`inline-flex items-center px-2 py-0.5 text-[11px] font-semibold rounded-md border ${LANG_META[selectedSeries.source_lang].badgeClass}`}
            >
              {LANG_META[selectedSeries.source_lang].label}
            </span>
            <span
              className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-md border ${MODE_META[selectedSeries.translation_mode].badgeClass}`}
            >
              {MODE_META[selectedSeries.translation_mode].label}
            </span>
          </div>
        )}

        <button
          type="button"
          onClick={onOpenHelp}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-slate-700 dark:text-zinc-200 hover:bg-indigo-50 dark:hover:bg-indigo-500/15 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors cursor-pointer"
          title="Mở hướng dẫn thao tác cho màn hình hiện tại"
        >
          <HelpCircle className="w-3.5 h-3.5 text-indigo-500" />
          <span>Hướng dẫn</span>
        </button>
      </div>
    </header>
  )
}
