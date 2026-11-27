import { BookOpen, Layers } from 'lucide-react'
import type { Series, Volume } from '../types'
import { formatVolumeLabel, LANG_META, MODE_META } from '../types'

interface TopHeaderProps {
  seriesList: Series[]
  volumes: Volume[]
  selectedSeries: Series | null
  selectedVolume: Volume | null
  onSelectSeries: (series: Series | null) => void
  onSelectVolume: (volume: Volume | null) => void
}

export function TopHeader({
  seriesList,
  volumes,
  selectedSeries,
  selectedVolume,
  onSelectSeries,
  onSelectVolume,
}: TopHeaderProps) {
  return (
    <header className="h-14 shrink-0 border-b border-slate-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xs px-5 flex items-center justify-between gap-4 z-20">
      <div className="flex flex-wrap items-center gap-3 min-w-0">
        {/* Global Series Selector */}
        <div className="flex items-center gap-2 min-w-0">
          <BookOpen className="w-4 h-4 text-indigo-500 shrink-0" />
          <label
            htmlFor="global-series-select"
            className="text-xs font-medium text-slate-500 dark:text-zinc-400 hidden sm:inline shrink-0"
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
            className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 max-w-[230px] truncate focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
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

        <span className="text-slate-300 dark:text-zinc-700">/</span>

        {/* Global Volume Selector */}
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="w-4 h-4 text-slate-400 shrink-0" />
          <label
            htmlFor="global-volume-select"
            className="text-xs font-medium text-slate-500 dark:text-zinc-400 hidden sm:inline shrink-0"
          >
            Tập / Quyển:
          </label>
          <select
            id="global-volume-select"
            aria-label="Tập / Quyển đang làm việc"
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

      {/* Right metadata pills */}
      {selectedSeries && (
        <div className="hidden md:flex items-center gap-1.5 shrink-0">
          <span
            className={`inline-flex items-center px-2 py-0.5 text-[11px] font-semibold rounded-md border ${LANG_META[selectedSeries.source_lang].badgeClass}`}
          >
            {LANG_META[selectedSeries.source_lang].short}
          </span>
          <span
            className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-md border ${MODE_META[selectedSeries.translation_mode].badgeClass}`}
          >
            {MODE_META[selectedSeries.translation_mode].label}
          </span>
        </div>
      )}
    </header>
  )
}
