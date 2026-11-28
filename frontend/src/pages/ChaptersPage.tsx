import {
  ArrowRight,
  BookOpen,
  FileStack,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useState } from 'react'
import { ChapterManagerPanel } from '../components/ChapterManagerPanel'
import { ImportVolumeModal } from '../components/ImportVolumeModal'
import type { NavSection, Series, Volume } from '../types'
import { formatVolumeLabel } from '../types'

interface ChaptersPageProps {
  selectedSeries: Series | null
  selectedVolume: Volume | null
  onBackToDashboard: () => void
  onNavigate: (section: NavSection) => void
  onRefreshVolumes: (
    seriesId: number | null,
    preferredVolumeId?: number | null,
  ) => Promise<void>
}

export function ChaptersPage({
  selectedSeries,
  selectedVolume,
  onBackToDashboard,
  onNavigate,
  onRefreshVolumes,
}: ChaptersPageProps) {
  const [importOpen, setImportOpen] = useState(false)
  const [refreshSignal, setRefreshSignal] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  const notify = useCallback((msg: string) => {
    setToastMsg(msg)
    window.setTimeout(() => {
      setToastMsg((curr) => (curr === msg ? null : curr))
    }, 4500)
  }, [])

  if (!selectedSeries || !selectedVolume) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-4 sm:px-6">
        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 text-center space-y-3 shadow-xs">
          <FileStack className="w-9 h-9 mx-auto text-indigo-500" />
          <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">
            Chọn bộ truyện và tập để mở Kho chương
          </h2>
          <p className="text-sm text-slate-500 dark:text-zinc-400">
            Hãy tạo bộ truyện và thêm ít nhất một tập ở mục Quản lý truyện trước
            khi nhập sách hoặc biên tập danh sách chương.
          </p>
          <button
            type="button"
            onClick={onBackToDashboard}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"
          >
            <BookOpen className="w-4 h-4" />
            Đi tới Quản lý truyện
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-5">
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
              Kho chương
            </h2>
            <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 text-xs font-medium text-slate-700 dark:text-zinc-200">
              {selectedSeries.title} · {formatVolumeLabel(selectedVolume)}
            </span>
          </div>
          <p className="text-sm text-slate-500 dark:text-zinc-400 mt-1">
            Nhập tệp EPUB, TXT hoặc Word, xem trước bản gốc, đổi tên chương,
            tách chương tại vị trí con trỏ và gộp chương dễ dàng.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            Nhập tệp sách
          </button>
          <button
            type="button"
            onClick={() => onNavigate('glossary')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-sm font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-200 cursor-pointer"
          >
            Sang Thuật ngữ
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Banners */}
      {errorMsg && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 text-sm">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="p-1 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {toastMsg && (
        <div className="px-4 py-3 rounded-xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-sm font-medium">
          {toastMsg}
        </div>
      )}

      {/* Full-width Chapter Manager */}
      <ChapterManagerPanel
        volume={selectedVolume}
        refreshSignal={refreshSignal}
        onOpenImportModal={() => setImportOpen(true)}
        onNotify={notify}
        onError={setErrorMsg}
      />

      {importOpen && (
        <ImportVolumeModal
          volume={selectedVolume}
          seriesTitle={selectedSeries.title}
          onClose={() => setImportOpen(false)}
          onImported={(res) => {
            setImportOpen(false)
            notify(
              `Đã nhập ${res.chapters_imported} chương (${res.total_chars.toLocaleString('vi-VN')} ký tự) từ "${res.filename}".`,
            )
            setRefreshSignal((s) => s + 1)
            void onRefreshVolumes(selectedSeries.id, selectedVolume.id)
          }}
        />
      )}
    </div>
  )
}
