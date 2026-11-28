import {
  BookOpen,
  Edit3,
  FileStack,
  FolderPlus,
  Layers,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { ImportVolumeModal } from '../components/ImportVolumeModal'
import {
  createSeries,
  createVolume,
  deleteSeries,
  deleteVolume,
  extractErrorMessage,
  fetchPresets,
  updateSeries,
  updateVolume,
} from '../lib/api'
import type {
  HybridConfig,
  PromptPreset,
  Series,
  SeriesPayload,
  SourceLang,
  TranslationMode,
  Volume,
  VolumeStatus,
} from '../types'
import {
  formatVolumeLabel,
  LANG_META,
  MODE_META,
  VOLUME_STATUS_META,
} from '../types'

interface DashboardPageProps {
  seriesList: Series[]
  volumes: Volume[]
  selectedSeries: Series | null
  selectedVolume: Volume | null
  onSelectSeries: (series: Series | null) => void
  onSelectVolume: (volume: Volume | null) => void
  onRefreshSeries: (preferredSeriesId?: number | null) => Promise<void>
  onRefreshVolumes: (
    seriesId: number | null,
    preferredVolumeId?: number | null,
  ) => Promise<void>
  onOpenChapters: () => void
}

const DEFAULT_HYBRID: HybridConfig = {
  use_glossary: true,
  use_characters: true,
  use_relationships: true,
  use_subarc: false,
  rolling_context_lines: 5,
}

const EMPTY_SERIES_FORM: SeriesPayload = {
  title: '',
  source_lang: 'ja',
  translation_mode: 'ln_vn',
  system_prompt: '',
  master_prompt_file: 'master_prompt_vn.xml',
  hybrid_config: { ...DEFAULT_HYBRID },
}

const VOLUME_LABEL_SUGGESTIONS = [
  'Quyển 1',
  'Tập 1',
  'Chương 1–200',
  'Trọn bộ',
]

export function DashboardPage({
  seriesList,
  volumes,
  selectedSeries,
  selectedVolume,
  onSelectSeries,
  onSelectVolume,
  onRefreshSeries,
  onRefreshVolumes,
  onOpenChapters,
}: DashboardPageProps) {
  const [presets, setPresets] = useState<PromptPreset[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [langFilter, setLangFilter] = useState<'all' | SourceLang>('all')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  // Series modal state
  const [seriesModalOpen, setSeriesModalOpen] = useState(false)
  const [editingSeries, setEditingSeries] = useState<Series | null>(null)
  const [seriesForm, setSeriesForm] = useState<SeriesPayload>(EMPTY_SERIES_FORM)
  const [savingSeries, setSavingSeries] = useState(false)

  // Volume modal state
  const [volumeModalOpen, setVolumeModalOpen] = useState(false)
  const [editingVolume, setEditingVolume] = useState<Volume | null>(null)
  const [volNumber, setVolNumber] = useState<number>(1)
  const [volTitle, setVolTitle] = useState('')
  const [volSummary, setVolSummary] = useState('')
  const [volRtas, setVolRtas] = useState<number>(3.0)
  const [volStatus, setVolStatus] = useState<VolumeStatus>('imported')
  const [savingVolume, setSavingVolume] = useState(false)
  const [importingVolume, setImportingVolume] = useState<Volume | null>(null)

  const notify = (msg: string) => {
    setToastMsg(msg)
    window.setTimeout(() => {
      setToastMsg((curr) => (curr === msg ? null : curr))
    }, 3500)
  }

  useEffect(() => {
    fetchPresets()
      .then(setPresets)
      .catch(() => {})
  }, [])

  const filteredSeries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return seriesList.filter((item) => {
      if (langFilter !== 'all' && item.source_lang !== langFilter) return false
      if (q && !item.title.toLowerCase().includes(q)) return false
      return true
    })
  }, [seriesList, searchQuery, langFilter])

  const openCreateSeriesModal = () => {
    setEditingSeries(null)
    setSeriesForm({
      ...EMPTY_SERIES_FORM,
      hybrid_config: { ...DEFAULT_HYBRID },
    })
    setSeriesModalOpen(true)
  }

  const openEditSeriesModal = (series: Series) => {
    setEditingSeries(series)
    setSeriesForm({
      title: series.title,
      source_lang: series.source_lang,
      translation_mode: series.translation_mode,
      system_prompt: series.system_prompt,
      master_prompt_file: series.master_prompt_file,
      hybrid_config: { ...series.hybrid_config },
    })
    setSeriesModalOpen(true)
  }

  const handleSaveSeries = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!seriesForm.title.trim()) return
    setSavingSeries(true)
    setErrorMsg(null)
    try {
      let saved: Series
      if (editingSeries) {
        saved = await updateSeries(editingSeries.id, seriesForm)
        notify(`Đã cập nhật bộ truyện "${saved.title}".`)
      } else {
        saved = await createSeries(seriesForm)
        notify(`Đã tạo bộ truyện "${saved.title}".`)
      }
      await onRefreshSeries(saved.id)
      setSeriesModalOpen(false)
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setSavingSeries(false)
    }
  }

  const handleDeleteSeries = async (series: Series) => {
    const confirmed = window.confirm(
      `Xóa bộ truyện "${series.title}" và toàn bộ các tập liên quan? Hành động này không thể hoàn tác.`,
    )
    if (!confirmed) return
    setErrorMsg(null)
    try {
      await deleteSeries(series.id)
      await onRefreshSeries(null)
      notify(`Đã xóa bộ truyện "${series.title}".`)
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const openCreateVolumeModal = () => {
    if (!selectedSeries) return
    const nextNum =
      volumes.length > 0
        ? Math.max(...volumes.map((v) => v.volume_number)) + 1
        : 1
    setEditingVolume(null)
    setVolNumber(nextNum)
    setVolTitle('')
    setVolSummary('')
    setVolRtas(3.0)
    setVolStatus('imported')
    setVolumeModalOpen(true)
  }

  const openEditVolumeModal = (volume: Volume) => {
    setEditingVolume(volume)
    setVolNumber(volume.volume_number)
    setVolTitle(volume.title)
    setVolSummary(volume.volume_summary)
    setVolRtas(volume.rtas_baseline)
    setVolStatus(volume.status)
    setVolumeModalOpen(true)
  }

  const handleSaveVolume = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedSeries) return
    setSavingVolume(true)
    setErrorMsg(null)
    try {
      let saved: Volume
      if (editingVolume) {
        saved = await updateVolume(editingVolume.id, {
          volume_number: volNumber,
          title: volTitle.trim(),
          volume_summary: volSummary,
          rtas_baseline: volRtas,
          status: volStatus,
        })
        notify(`Đã cập nhật "${formatVolumeLabel(saved)}".`)
      } else {
        saved = await createVolume(selectedSeries.id, {
          volume_number: volNumber,
          title: volTitle.trim(),
          volume_summary: volSummary,
          rtas_baseline: volRtas,
          status: volStatus,
        })
        notify(`Đã tạo "${formatVolumeLabel(saved)}".`)
      }
      await onRefreshSeries(selectedSeries.id)
      await onRefreshVolumes(selectedSeries.id, saved.id)
      setVolumeModalOpen(false)
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setSavingVolume(false)
    }
  }

  const handleDeleteVolume = async (volume: Volume) => {
    const confirmed = window.confirm(
      `Xóa "${formatVolumeLabel(volume)}" và toàn bộ chương bên trong?`,
    )
    if (!confirmed) return
    setErrorMsg(null)
    try {
      await deleteVolume(volume.id)
      if (selectedSeries) {
        await onRefreshSeries(selectedSeries.id)
        await onRefreshVolumes(selectedSeries.id, null)
      }
      notify(`Đã xóa "${formatVolumeLabel(volume)}".`)
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const applyPresetToForm = (preset: PromptPreset) => {
    setSeriesForm((prev) => ({
      ...prev,
      source_lang:
        preset.source_lang === 'any' ? prev.source_lang : preset.source_lang,
      translation_mode: preset.mode,
      system_prompt: preset.content,
    }))
  }

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
            Quản lý truyện
          </h2>
          <p className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">
            Tạo bộ truyện, chọn phong cách dịch và tổ chức danh sách tập hoặc
            quyển theo ý muốn.
          </p>
        </div>

        <button
          type="button"
          onClick={openCreateSeriesModal}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer"
        >
          <FolderPlus className="w-4 h-4" />
          Tạo bộ truyện mới
        </button>
      </div>

      {/* Feedback Banners */}
      {errorMsg && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 text-sm">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="p-1 hover:opacity-75 cursor-pointer"
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

      {/* Main Split Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Series List */}
        <section className="lg:col-span-4 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-xs">
          <div className="p-4 border-b border-slate-200 dark:border-zinc-800 space-y-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-indigo-500" />
              Danh sách Bộ truyện ({filteredSeries.length})
            </h3>

            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Tìm tên truyện..."
                  className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
              <select
                value={langFilter}
                onChange={(e) =>
                  setLangFilter(e.target.value as 'all' | SourceLang)
                }
                aria-label="Lọc ngôn ngữ"
                className="px-2.5 py-2 text-xs rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-slate-700 dark:text-zinc-200"
              >
                <option value="all">Tất cả</option>
                <option value="ja">Nhật</option>
                <option value="zh">Trung</option>
                <option value="ko">Hàn</option>
              </select>
            </div>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-zinc-800 max-h-[640px] overflow-y-auto">
            {filteredSeries.length === 0 ? (
              <div className="p-10 text-center space-y-3">
                <div className="w-11 h-11 mx-auto rounded-xl bg-slate-100 dark:bg-zinc-800 flex items-center justify-center text-slate-400">
                  <BookOpen className="w-5 h-5" />
                </div>
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  Chưa có bộ truyện nào. Bấm "Tạo bộ truyện mới" để bắt đầu.
                </p>
              </div>
            ) : (
              filteredSeries.map((series) => {
                const isSelected = selectedSeries?.id === series.id
                return (
                  <div
                    key={series.id}
                    onClick={() => onSelectSeries(series)}
                    className={`p-3.5 cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-indigo-50/70 dark:bg-indigo-500/10 border-l-3 border-l-indigo-600'
                        : 'hover:bg-slate-50 dark:hover:bg-zinc-800/50 border-l-3 border-l-transparent'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h4 className="font-semibold text-sm text-slate-900 dark:text-zinc-100 truncate">
                          {series.title}
                        </h4>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded border ${LANG_META[series.source_lang].badgeClass}`}
                          >
                            {LANG_META[series.source_lang].short}
                          </span>
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${MODE_META[series.translation_mode].badgeClass}`}
                          >
                            {MODE_META[series.translation_mode].label}
                          </span>
                          <span className="text-[11px] text-slate-500 dark:text-zinc-400">
                            {series.volume_count} tập
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          title="Chỉnh sửa bộ truyện"
                          onClick={(e) => {
                            e.stopPropagation()
                            openEditSeriesModal(series)
                          }}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-white dark:hover:bg-zinc-800 cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Xóa bộ truyện"
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleDeleteSeries(series)
                          }}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-white dark:hover:bg-zinc-800 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>

        {/* Right: Selected Series Details + Volumes + Chapter Manager */}
        <section className="lg:col-span-8 space-y-5">
          {selectedSeries ? (
            <>
              {/* Series Summary Card */}
              <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 shadow-xs space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-md border ${LANG_META[selectedSeries.source_lang].badgeClass}`}
                      >
                        {LANG_META[selectedSeries.source_lang].label}
                      </span>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-md border ${MODE_META[selectedSeries.translation_mode].badgeClass}`}
                      >
                        {MODE_META[selectedSeries.translation_mode].label}
                      </span>
                    </div>
                    <h3 className="text-xl font-bold text-slate-900 dark:text-zinc-100">
                      {selectedSeries.title}
                    </h3>
                  </div>

                  <button
                    type="button"
                    onClick={() => openEditSeriesModal(selectedSeries)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    Cấu hình truyện
                  </button>
                </div>

                {selectedSeries.system_prompt ? (
                  <p className="text-xs text-slate-600 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800 rounded-xl px-3.5 py-2.5 line-clamp-2 whitespace-pre-wrap">
                    {selectedSeries.system_prompt}
                  </p>
                ) : (
                  <div className="text-xs text-slate-500 dark:text-zinc-400">
                    Tệp lệnh dịch chuẩn:{' '}
                    <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800">
                      {selectedSeries.master_prompt_file}
                    </code>
                  </div>
                )}
              </div>

              {/* Volumes Section */}
              <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-xs">
                <div className="px-4 py-3.5 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
                    <Layers className="w-4 h-4 text-indigo-500" />
                    Danh sách Tập / Quyển ({volumes.length})
                  </h4>
                  <button
                    type="button"
                    onClick={openCreateVolumeModal}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Thêm tập / quyển
                  </button>
                </div>

                {volumes.length === 0 ? (
                  <div className="p-8 text-center space-y-2">
                    <p className="text-xs text-slate-500 dark:text-zinc-400">
                      Bộ truyện này chưa có tập/quyển nào.
                    </p>
                    <button
                      type="button"
                      onClick={openCreateVolumeModal}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" /> Tạo Tập / Quyển đầu tiên
                    </button>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-zinc-800">
                    {volumes.map((vol) => {
                      const activeVol = selectedVolume?.id === vol.id
                      const statusMeta = VOLUME_STATUS_META[vol.status]
                      return (
                        <div
                          key={vol.id}
                          onClick={() => onSelectVolume(vol)}
                          className={`px-4 py-3 flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                            activeVol
                              ? 'bg-indigo-50/60 dark:bg-indigo-500/10 border-l-3 border-l-indigo-600'
                              : 'hover:bg-slate-50 dark:hover:bg-zinc-800/40 border-l-3 border-l-transparent'
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-md text-[11px] font-bold bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
                                #{vol.volume_number}
                              </span>
                              <span className="font-semibold text-sm text-slate-900 dark:text-zinc-100 truncate">
                                {formatVolumeLabel(vol)}
                              </span>
                              <span
                                className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full ${statusMeta.badgeClass}`}
                              >
                                {statusMeta.label}
                              </span>
                            </div>
                            {vol.volume_summary && (
                              <p className="text-xs text-slate-500 dark:text-zinc-400 line-clamp-1 mt-0.5">
                                {vol.volume_summary}
                              </p>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-1 shrink-0">
                            <button
                              type="button"
                              title="Mở Kho chương của tập này"
                              onClick={(e) => {
                                e.stopPropagation()
                                onSelectVolume(vol)
                                onOpenChapters()
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50/70 dark:bg-emerald-500/10 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 cursor-pointer"
                            >
                              <FileStack className="w-3.5 h-3.5" />
                              Kho chương
                            </button>
                            <button
                              type="button"
                              title="Nhập tệp EPUB, TXT hoặc Word"
                              onClick={(e) => {
                                e.stopPropagation()
                                onSelectVolume(vol)
                                setImportingVolume(vol)
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/15 cursor-pointer"
                            >
                              <Upload className="w-3.5 h-3.5" />
                              Nhập sách
                            </button>
                            <button
                              type="button"
                              title="Sửa tập"
                              onClick={(e) => {
                                e.stopPropagation()
                                openEditVolumeModal(vol)
                              }}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-white dark:hover:bg-zinc-800 cursor-pointer"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              title="Xóa tập"
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleDeleteVolume(vol)
                              }}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-white dark:hover:bg-zinc-800 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-300 dark:border-zinc-700 p-12 text-center space-y-3 bg-white/60 dark:bg-zinc-900/40">
              <div className="w-12 h-12 mx-auto rounded-2xl bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                <FolderPlus className="w-6 h-6" />
              </div>
              <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                Bắt đầu dự án dịch đầu tiên
              </h3>
              <p className="text-sm text-slate-500 dark:text-zinc-400 max-w-md mx-auto">
                Tạo một bộ truyện với ngôn ngữ gốc (Nhật, Trung hoặc Hàn) và chế
                độ dịch phù hợp, sau đó thêm Tập / Quyển để bắt đầu.
              </p>
              <button
                type="button"
                onClick={openCreateSeriesModal}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"
              >
                <Plus className="w-4 h-4" /> Tạo bộ truyện ngay
              </button>
            </div>
          )}
        </section>
      </div>

      {/* Create/Edit Series Modal */}
      {seriesModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 dark:text-zinc-100">
                {editingSeries ? 'Chỉnh sửa Bộ truyện' : 'Tạo Bộ truyện mới'}
              </h3>
              <button
                type="button"
                onClick={() => setSeriesModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveSeries} className="p-6 space-y-5">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-200 mb-1.5">
                  Tên bộ truyện *
                </label>
                <input
                  type="text"
                  required
                  value={seriesForm.title}
                  onChange={(e) =>
                    setSeriesForm({ ...seriesForm, title: e.target.value })
                  }
                  placeholder="VD: Mushoku Tensei, Quỷ Bí Chi Chủ, Solo Leveling..."
                  className="w-full px-3.5 py-2.5 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-200 mb-1.5">
                  Ngôn ngữ gốc
                </label>
                <div className="grid grid-cols-3 gap-2.5">
                  {(['ja', 'zh', 'ko'] as SourceLang[]).map((lang) => {
                    const active = seriesForm.source_lang === lang
                    return (
                      <button
                        key={lang}
                        type="button"
                        onClick={() =>
                          setSeriesForm({ ...seriesForm, source_lang: lang })
                        }
                        className={`px-3 py-2.5 rounded-xl border text-sm font-medium transition-all cursor-pointer ${
                          active
                            ? 'border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-400'
                            : 'border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
                        }`}
                      >
                        {LANG_META[lang].label}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-200 mb-1.5">
                  Chế độ dịch
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  {(['ln_vn', 'freeform', 'hybrid'] as TranslationMode[]).map(
                    (mode) => {
                      const active = seriesForm.translation_mode === mode
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() =>
                            setSeriesForm({
                              ...seriesForm,
                              translation_mode: mode,
                            })
                          }
                          className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                            active
                              ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-500/15 dark:border-indigo-400'
                              : 'border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800'
                          }`}
                        >
                          <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                            {MODE_META[mode].label}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-zinc-400 mt-0.5 leading-snug">
                            {MODE_META[mode].desc}
                          </div>
                        </button>
                      )
                    },
                  )}
                </div>
              </div>

              {seriesForm.translation_mode === 'hybrid' && (
                <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950/60 p-4 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-zinc-400">
                    Tùy chọn ngữ cảnh Hybrid
                  </div>
                  <div className="grid grid-cols-2 gap-2.5 text-sm">
                    {(
                      [
                        ['use_glossary', 'Nạp bảng thuật ngữ (Glossary)'],
                        ['use_characters', 'Nạp danh sách nhân vật (Roster)'],
                        ['use_relationships', 'Nạp quan hệ & xưng hô'],
                        ['use_subarc', 'Nạp trạng thái Sub-Arc'],
                      ] as const
                    ).map(([key, label]) => (
                      <label
                        key={key}
                        className="flex items-center gap-2 text-slate-700 dark:text-zinc-300 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={seriesForm.hybrid_config[key]}
                          onChange={(e) =>
                            setSeriesForm({
                              ...seriesForm,
                              hybrid_config: {
                                ...seriesForm.hybrid_config,
                                [key]: e.target.checked,
                              },
                            })
                          }
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-xs">{label}</span>
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 pt-1">
                    <label className="text-xs text-slate-600 dark:text-zinc-400">
                      Số dòng ngữ cảnh nối tiếp (rolling context):
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={50}
                      value={seriesForm.hybrid_config.rolling_context_lines}
                      onChange={(e) =>
                        setSeriesForm({
                          ...seriesForm,
                          hybrid_config: {
                            ...seriesForm.hybrid_config,
                            rolling_context_lines: Math.max(
                              0,
                              Number(e.target.value) || 0,
                            ),
                          },
                        })
                      }
                      className="w-20 px-2.5 py-1 text-xs rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                    />
                  </div>
                </div>
              )}

              {presets.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
                    Nạp nhanh từ Prompt Preset:
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {presets.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => applyPresetToForm(preset)}
                        className="px-2.5 py-1 rounded-lg text-xs border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors cursor-pointer"
                      >
                        {preset.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-zinc-200 mb-1.5">
                  System Prompt / Hướng dẫn văn phong
                </label>
                <textarea
                  rows={5}
                  value={seriesForm.system_prompt}
                  onChange={(e) =>
                    setSeriesForm({
                      ...seriesForm,
                      system_prompt: e.target.value,
                    })
                  }
                  placeholder="Nhập hướng dẫn dịch cho chế độ Dịch Tự Do (Freeform) / Hybrid hoặc ghi chú bổ sung..."
                  className="w-full px-3.5 py-2.5 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => setSeriesModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={savingSeries}
                  className="px-5 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white cursor-pointer"
                >
                  {savingSeries
                    ? 'Đang lưu...'
                    : editingSeries
                      ? 'Lưu thay đổi'
                      : 'Tạo bộ truyện'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create/Edit Volume Modal (Flexible freeform label) */}
      {volumeModalOpen && selectedSeries && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 dark:text-zinc-100">
                {editingVolume
                  ? `Chỉnh sửa ${formatVolumeLabel(editingVolume)}`
                  : `Thêm Tập / Quyển — ${selectedSeries.title}`}
              </h3>
              <button
                type="button"
                onClick={() => setVolumeModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveVolume} className="p-6 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-zinc-200 mb-1">
                    Thứ tự #
                  </label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={volNumber}
                    onChange={(e) =>
                      setVolNumber(Math.max(1, Number(e.target.value) || 1))
                    }
                    className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-700 dark:text-zinc-200 mb-1">
                    Nhãn hiển thị (tùy chọn — để trống tự đặt "Tập {volNumber}")
                  </label>
                  <input
                    type="text"
                    value={volTitle}
                    onChange={(e) => setVolTitle(e.target.value)}
                    placeholder={`VD: Quyển ${volNumber}, Chương 1-200, Full Truyện...`}
                    className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-slate-400">Gợi ý nhanh:</span>
                {VOLUME_LABEL_SUGGESTIONS.map((label) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setVolTitle(label)}
                    className="px-2 py-0.5 rounded-md border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 hover:border-indigo-400 cursor-pointer"
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-zinc-200 mb-1">
                    RTAS nền (1.0 – 5.0)
                  </label>
                  <input
                    type="number"
                    step={0.1}
                    min={1}
                    max={5}
                    value={volRtas}
                    onChange={(e) => setVolRtas(Number(e.target.value) || 3.0)}
                    className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-zinc-200 mb-1">
                    Trạng thái
                  </label>
                  <select
                    value={volStatus}
                    onChange={(e) =>
                      setVolStatus(e.target.value as VolumeStatus)
                    }
                    className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  >
                    {(Object.keys(VOLUME_STATUS_META) as VolumeStatus[]).map(
                      (st) => (
                        <option key={st} value={st}>
                          {VOLUME_STATUS_META[st].label}
                        </option>
                      ),
                    )}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-zinc-200 mb-1">
                  Tóm tắt tập (tùy chọn)
                </label>
                <textarea
                  rows={3}
                  value={volSummary}
                  onChange={(e) => setVolSummary(e.target.value)}
                  placeholder="Ghi chú bối cảnh chính hoặc mạch truyện..."
                  className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => setVolumeModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={savingVolume}
                  className="px-5 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white cursor-pointer"
                >
                  {savingVolume
                    ? 'Đang lưu...'
                    : editingVolume
                      ? 'Lưu thay đổi'
                      : 'Tạo tập / quyển'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import Volume Book Modal */}
      {importingVolume && selectedSeries && (
        <ImportVolumeModal
          volume={importingVolume}
          seriesTitle={selectedSeries.title}
          onClose={() => setImportingVolume(null)}
          onImported={(res) => {
            notify(
              `Đã nhập ${res.chapters_imported} chương (${res.total_chars.toLocaleString('vi-VN')} ký tự) vào ${formatVolumeLabel(importingVolume)}.`,
            )
            void onRefreshVolumes(selectedSeries.id, importingVolume.id)
          }}
        />
      )}
    </div>
  )
}
