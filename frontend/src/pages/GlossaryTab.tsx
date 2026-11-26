import {
  Ban,
  BookMarked,
  CheckCheck,
  Download,
  FileSpreadsheet,
  Plus,
  ScanSearch,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ImportVolumeModal } from '../components/ImportVolumeModal'
import {
  bulkDeleteGlossaryTerms,
  bulkUpdateGlossaryStatus,
  createGlossaryTerm,
  deleteGlossaryTerm,
  extractErrorMessage,
  extractVolumeGlossary,
  fetchGlossary,
  fetchSeriesList,
  fetchVolumes,
  getGlossaryExportUrl,
  importGlossaryFile,
  translateNewGlossaryTerms,
  updateGlossaryTerm,
} from '../lib/api'
import type {
  GlossaryStatus,
  GlossaryTerm,
  Series,
  Volume,
} from '../types'
import { GLOSSARY_STATUS_META, LANG_META, TERM_TYPES } from '../types'

interface GlossaryTabProps {
  selectedSeries: Series | null
  selectedVolume: Volume | null
  onSelectSeries: (series: Series | null) => void
  onSelectVolume: (volume: Volume | null) => void
  onBackToDashboard: () => void
}

type ScopeMode = 'volume' | 'series'

export function GlossaryTab({
  selectedSeries,
  selectedVolume,
  onSelectSeries,
  onSelectVolume,
  onBackToDashboard,
}: GlossaryTabProps) {
  const [seriesList, setSeriesList] = useState<Series[]>([])
  const [volumes, setVolumes] = useState<Volume[]>([])

  // Filters
  const [scope, setScope] = useState<ScopeMode>(
    selectedVolume ? 'volume' : 'series',
  )
  const [statusFilter, setStatusFilter] = useState<'all' | GlossaryStatus>(
    'all',
  )
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [minFreq, setMinFreq] = useState<number>(1)
  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Data
  const [terms, setTerms] = useState<GlossaryTerm[]>([])
  const [totalFiltered, setTotalFiltered] = useState(0)
  const [totalInScope, setTotalInScope] = useState(0)
  const [statusCounts, setStatusCounts] = useState<
    Record<GlossaryStatus, number>
  >({
    new: 0,
    translated: 0,
    approved: 0,
    ignored: 0,
  })
  const [loading, setLoading] = useState(false)

  // Selection & inline editing state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [savingTermId, setSavingTermId] = useState<number | null>(null)

  // Operations
  const [extracting, setExtracting] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [importingTsv, setImportingTsv] = useState(false)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [newTermForm, setNewTermForm] = useState({
    source_term: '',
    vi_term: '',
    reading: '',
    han_viet: '',
    english_meaning: '',
    term_type: 'Concept',
    status: 'approved' as GlossaryStatus,
  })

  // Feedback
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const tsvInputRef = useRef<HTMLInputElement | null>(null)

  const notify = (msg: string) => {
    setToastMsg(msg)
    window.setTimeout(() => {
      setToastMsg((curr) => (curr === msg ? null : curr))
    }, 4500)
  }

  // Load series list for quick switching
  useEffect(() => {
    fetchSeriesList()
      .then((list) => {
        setSeriesList(list)
        if (!selectedSeries && list.length > 0) {
          onSelectSeries(list[0])
        }
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load volumes when series changes
  useEffect(() => {
    if (!selectedSeries) {
      setVolumes([])
      return
    }
    fetchVolumes(selectedSeries.id)
      .then((vList) => {
        setVolumes(vList)
        if (
          vList.length > 0 &&
          (!selectedVolume || selectedVolume.series_id !== selectedSeries.id)
        ) {
          onSelectVolume(vList[0])
        }
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSeries?.id])

  // Debounce instant search
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchInput)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const loadGlossary = useCallback(async () => {
    if (!selectedSeries) {
      setTerms([])
      return
    }
    setLoading(true)
    setErrorMsg(null)
    try {
      const effectiveVolId =
        scope === 'volume' && selectedVolume ? selectedVolume.id : null
      const res = await fetchGlossary(selectedSeries.id, {
        volume_id: effectiveVolId,
        status: statusFilter === 'all' ? null : statusFilter,
        term_type: typeFilter === 'all' ? null : typeFilter,
        min_freq: minFreq,
        search: debouncedSearch,
        limit: 1000,
      })
      setTerms(res.items)
      setTotalFiltered(res.total_filtered)
      setTotalInScope(res.total_in_scope)
      setStatusCounts(res.status_counts)
      setSelectedIds((prev) => {
        const currentIds = new Set(res.items.map((i) => i.id))
        const next = new Set<number>()
        prev.forEach((id) => {
          if (currentIds.has(id)) next.add(id)
        })
        return next
      })
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [
    selectedSeries,
    selectedVolume,
    scope,
    statusFilter,
    typeFilter,
    minFreq,
    debouncedSearch,
  ])

  useEffect(() => {
    void loadGlossary()
  }, [loadGlossary])

  // ---------- Actions ----------

  const handleExtractForVolume = async () => {
    if (!selectedVolume) {
      setErrorMsg('Hãy chọn một tập trước khi đếm từ.')
      return
    }
    setExtracting(true)
    setErrorMsg(null)
    try {
      const res = await extractVolumeGlossary(selectedVolume.id, 1)
      notify(
        `Đã đếm xong ${res.total_extracted} thuật ngữ cho Tập ${selectedVolume.volume_number}: +${res.new_terms} từ mới, ${res.existing_terms} từ đã có trong Master DB.`,
      )
      setScope('volume')
      await loadGlossary()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setExtracting(false)
    }
  }

  const handleTranslateNew = async () => {
    if (!selectedSeries) return
    setTranslating(true)
    setErrorMsg(null)
    try {
      const effectiveVolId =
        scope === 'volume' && selectedVolume ? selectedVolume.id : null
      const res = await translateNewGlossaryTerms(selectedSeries.id, {
        volume_id: effectiveVolId,
        batch_size: 400,
        max_rounds: 3,
      })
      if (res.total_new_found === 0) {
        notify('Không có từ nào ở trạng thái "Chưa dịch" trong phạm vi hiện tại.')
      } else {
        notify(
          `Đã dịch ${res.translated_count}/${res.total_new_found} từ mới qua ${res.rounds_used} vòng${res.missing_count > 0 ? ` (còn thiếu ${res.missing_count} từ)` : ''}.`,
        )
      }
      await loadGlossary()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setTranslating(false)
    }
  }

  const handleImportTsv = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !selectedSeries) return
    setImportingTsv(true)
    setErrorMsg(null)
    try {
      const res = await importGlossaryFile(selectedSeries.id, file, 'approved')
      notify(
        `Đã nhập TSV/CSV: +${res.imported} từ mới, cập nhật ${res.updated} từ${res.skipped > 0 ? `, bỏ qua ${res.skipped} dòng` : ''}.`,
      )
      await loadGlossary()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setImportingTsv(false)
    }
  }

  const handleInlinePatch = async (
    term: GlossaryTerm,
    patch: Partial<
      Pick<
        GlossaryTerm,
        | 'vi_term'
        | 'reading'
        | 'han_viet'
        | 'english_meaning'
        | 'term_type'
        | 'status'
      >
    >,
  ) => {
    const changed = (
      Object.keys(patch) as Array<keyof typeof patch>
    ).some((k) => patch[k] !== term[k])
    if (!changed) return

    setSavingTermId(term.id)
    setErrorMsg(null)
    // Optimistic update
    setTerms((prev) =>
      prev.map((item) => (item.id === term.id ? { ...item, ...patch } : item)),
    )
    try {
      const updated = await updateGlossaryTerm(term.id, patch)
      setTerms((prev) =>
        prev.map((item) =>
          item.id === updated.id
            ? { ...updated, volume_freq: item.volume_freq }
            : item,
        ),
      )
      if (patch.status && patch.status !== term.status) {
        setStatusCounts((prev) => ({
          ...prev,
          [term.status]: Math.max(0, (prev[term.status] ?? 0) - 1),
          [patch.status!]: (prev[patch.status!] ?? 0) + 1,
        }))
      }
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
      await loadGlossary()
    } finally {
      setSavingTermId((curr) => (curr === term.id ? null : curr))
    }
  }

  const handleBulkStatus = async (nextStatus: GlossaryStatus) => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setErrorMsg(null)
    try {
      const res = await bulkUpdateGlossaryStatus(ids, nextStatus)
      notify(
        `Đã chuyển ${res.updated} thuật ngữ sang "${GLOSSARY_STATUS_META[nextStatus].label}".`,
      )
      setSelectedIds(new Set())
      await loadGlossary()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    if (!window.confirm(`Xóa vĩnh viễn ${ids.length} thuật ngữ đã chọn?`)) {
      return
    }
    setErrorMsg(null)
    try {
      const res = await bulkDeleteGlossaryTerms(ids)
      notify(`Đã xóa ${res.deleted} thuật ngữ.`)
      setSelectedIds(new Set())
      await loadGlossary()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleDeleteOne = async (term: GlossaryTerm) => {
    if (!window.confirm(`Xóa thuật ngữ "${term.source_term}"?`)) return
    setErrorMsg(null)
    try {
      await deleteGlossaryTerm(term.id)
      setTerms((prev) => prev.filter((t) => t.id !== term.id))
      setSelectedIds((prev) => {
        const next = new Set(prev)
        next.delete(term.id)
        return next
      })
      notify(`Đã xóa "${term.source_term}".`)
      await loadGlossary()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleCreateTerm = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedSeries || !newTermForm.source_term.trim()) return
    setErrorMsg(null)
    try {
      await createGlossaryTerm(selectedSeries.id, newTermForm)
      setAddModalOpen(false)
      setNewTermForm({
        source_term: '',
        vi_term: '',
        reading: '',
        han_viet: '',
        english_meaning: '',
        term_type: 'Concept',
        status: 'approved',
      })
      notify('Đã thêm thuật ngữ mới vào Master Glossary.')
      await loadGlossary()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === terms.length && terms.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(terms.map((t) => t.id)))
    }
  }

  const toggleRow = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (!selectedSeries) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-6">
        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 text-center space-y-3">
          <BookMarked className="w-8 h-8 mx-auto text-indigo-500" />
          <h2 className="text-lg font-bold text-slate-900 dark:text-zinc-100">
            Chưa có Bộ truyện nào được chọn
          </h2>
          <p className="text-sm text-slate-500 dark:text-zinc-400">
            Hãy tạo hoặc chọn một bộ truyện ở Quản lý Truyện để bắt đầu nhập
            file và xây dựng bảng Master Glossary.
          </p>
          <button
            type="button"
            onClick={onBackToDashboard}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"
          >
            Đi tới Quản lý Truyện
          </button>
        </div>
      </div>
    )
  }

  const allSelected = terms.length > 0 && selectedIds.size === terms.length
  const effectiveExportVol =
    scope === 'volume' && selectedVolume ? selectedVolume.id : null
  const effectiveExportStatus = statusFilter === 'all' ? null : statusFilter

  return (
    <div className="max-w-[1600px] mx-auto p-5 space-y-4">
      {/* Header + Series/Volume selector + Primary actions */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
              Master Glossary
            </h2>
            <span
              className={`px-2 py-0.5 text-xs font-semibold rounded-md border ${LANG_META[selectedSeries.source_lang].badgeClass}`}
            >
              {LANG_META[selectedSeries.source_lang].label}
            </span>
          </div>

          {/* Quick context switchers */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select
              aria-label="Chọn bộ truyện"
              value={selectedSeries.id}
              onChange={(e) => {
                const found = seriesList.find(
                  (s) => s.id === Number(e.target.value),
                )
                if (found) onSelectSeries(found)
              }}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-800 dark:text-zinc-200 font-medium"
            >
              {seriesList.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>

            <select
              aria-label="Chọn tập truyện"
              value={selectedVolume?.id ?? ''}
              onChange={(e) => {
                const found = volumes.find(
                  (v) => v.id === Number(e.target.value),
                )
                onSelectVolume(found ?? null)
              }}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-800 dark:text-zinc-200"
            >
              {volumes.length === 0 ? (
                <option value="">(Chưa có tập)</option>
              ) : (
                volumes.map((v) => (
                  <option key={v.id} value={v.id}>
                    Tập {v.volume_number}: {v.title}
                  </option>
                ))
              )}
            </select>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!selectedVolume}
            onClick={() => setImportModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 disabled:opacity-45 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 text-indigo-500" />
            Nhập truyện
          </button>

          <button
            type="button"
            disabled={!selectedVolume || extracting}
            onClick={() => void handleExtractForVolume()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-900 hover:bg-slate-800 dark:bg-zinc-100 dark:hover:bg-zinc-200 dark:text-zinc-900 text-white disabled:opacity-45 cursor-pointer"
          >
            <ScanSearch className="w-3.5 h-3.5" />
            {extracting ? 'Đang đếm từ...' : 'Đếm từ cho Tập này'}
          </button>

          <button
            type="button"
            disabled={translating || statusCounts.new === 0}
            onClick={() => void handleTranslateNew()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-45 cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {translating
              ? 'Đang dịch bằng Gemini...'
              : `Dịch các từ mới (${statusCounts.new})`}
          </button>

          <button
            type="button"
            disabled={importingTsv}
            onClick={() => tsvInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
            {importingTsv ? 'Đang nhập...' : 'Import TSV/CSV'}
          </button>
          <input
            ref={tsvInputRef}
            type="file"
            accept=".tsv,.csv,.txt"
            className="hidden"
            onChange={(e) => void handleImportTsv(e)}
          />

          <a
            href={getGlossaryExportUrl(
              selectedSeries.id,
              'tsv',
              effectiveExportVol,
              effectiveExportStatus,
            )}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800"
          >
            <Download className="w-3.5 h-3.5" />
            TSV
          </a>

          <a
            href={getGlossaryExportUrl(
              selectedSeries.id,
              'csv',
              effectiveExportVol,
              effectiveExportStatus,
            )}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800"
          >
            <Download className="w-3.5 h-3.5" />
            CSV
          </a>

          <button
            type="button"
            onClick={() => setAddModalOpen(true)}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Thêm từ
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

      {/* Filter Toolbar */}
      <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-3 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Scope switch */}
          <div className="inline-flex rounded-xl bg-slate-100 dark:bg-zinc-950 p-1 text-xs font-medium">
            <button
              type="button"
              disabled={!selectedVolume}
              onClick={() => setScope('volume')}
              className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer disabled:opacity-40 ${
                scope === 'volume'
                  ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 shadow-xs'
                  : 'text-slate-500 dark:text-zinc-400'
              }`}
            >
              {selectedVolume
                ? `Tập ${selectedVolume.volume_number}`
                : 'Theo tập'}
            </button>
            <button
              type="button"
              onClick={() => setScope('series')}
              className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                scope === 'series'
                  ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 shadow-xs'
                  : 'text-slate-500 dark:text-zinc-400'
              }`}
            >
              Toàn Series
            </button>
          </div>

          {/* Status filter pills */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <button
              type="button"
              onClick={() => setStatusFilter('all')}
              className={`px-2.5 py-1.5 rounded-lg font-medium transition-colors cursor-pointer ${
                statusFilter === 'all'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 hover:bg-slate-200 dark:hover:bg-zinc-700'
              }`}
            >
              Tất cả ({totalInScope})
            </button>
            {(['new', 'translated', 'approved', 'ignored'] as GlossaryStatus[]).map(
              (st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`px-2.5 py-1.5 rounded-lg font-medium transition-colors cursor-pointer ${
                    statusFilter === st
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 hover:bg-slate-200 dark:hover:bg-zinc-700'
                  }`}
                >
                  {GLOSSARY_STATUS_META[st].label} ({statusCounts[st] ?? 0})
                </button>
              ),
            )}
          </div>
        </div>

        {/* Search + Type + Min Freq */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Tìm tức thì theo từ gốc, nghĩa Việt, phiên âm, Hán-Việt, tiếng Anh..."
              className="w-full pl-9 pr-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
            />
          </div>

          <select
            aria-label="Lọc theo loại thuật ngữ"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
          >
            <option value="all">Mọi loại (term_type)</option>
            {TERM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-xs text-slate-600 dark:text-zinc-300">
            <span>Tần suất ≥</span>
            <input
              type="number"
              min={1}
              max={9999}
              value={minFreq}
              onChange={(e) =>
                setMinFreq(Math.max(1, Number(e.target.value) || 1))
              }
              className="w-14 px-1.5 py-0.5 text-sm rounded bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-center"
            />
          </label>

          <div className="text-xs text-slate-500 dark:text-zinc-400 ml-auto">
            Hiển thị <strong>{terms.length}</strong> / {totalFiltered} kết quả
          </div>
        </div>
      </div>

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-indigo-600 text-white shadow-md text-xs font-medium">
          <span>Đã chọn {selectedIds.size} thuật ngữ</span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleBulkStatus('approved')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-semibold cursor-pointer"
            >
              <CheckCheck className="w-3.5 h-3.5" />
              Duyệt hàng loạt
            </button>
            <button
              type="button"
              onClick={() => void handleBulkStatus('ignored')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900/60 hover:bg-slate-900/80 text-white font-semibold cursor-pointer"
            >
              <Ban className="w-3.5 h-3.5" />
              Bỏ qua hàng loạt
            </button>
            <button
              type="button"
              onClick={() => void handleBulkStatus('new')}
              className="px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 cursor-pointer"
            >
              Đặt Chưa dịch
            </button>
            <button
              type="button"
              onClick={() => void handleBulkDelete()}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-600 text-white cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Xóa
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="px-2 py-1.5 rounded-lg hover:bg-white/15 cursor-pointer"
            >
              Bỏ chọn
            </button>
          </div>
        </div>
      )}

      {/* Spreadsheet Table */}
      <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-xs">
        <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-zinc-950 text-slate-600 dark:text-zinc-400 uppercase text-[11px] border-b border-slate-200 dark:border-zinc-800">
              <tr>
                <th className="w-9 px-3 py-2.5 text-center">
                  <input
                    type="checkbox"
                    aria-label="Chọn tất cả"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="rounded border-slate-300 text-indigo-600 cursor-pointer"
                  />
                </th>
                <th className="px-3 py-2.5 font-semibold min-w-[150px]">
                  Từ gốc
                </th>
                <th className="px-2.5 py-2.5 font-semibold text-center w-20">
                  Tần suất
                </th>
                <th className="px-2.5 py-2.5 font-semibold min-w-[180px]">
                  Bản dịch Việt
                </th>
                <th className="px-2.5 py-2.5 font-semibold min-w-[140px]">
                  Phiên âm
                </th>
                <th className="px-2.5 py-2.5 font-semibold min-w-[120px]">
                  Hán-Việt
                </th>
                <th className="px-2.5 py-2.5 font-semibold min-w-[150px]">
                  Nghĩa Anh
                </th>
                <th className="px-2.5 py-2.5 font-semibold w-32">Loại</th>
                <th className="px-2.5 py-2.5 font-semibold w-32">Trạng thái</th>
                <th className="w-10 px-2 py-2.5 text-center" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-zinc-800/80">
              {loading ? (
                <tr>
                  <td
                    colSpan={10}
                    className="p-10 text-center text-sm text-slate-400"
                  >
                    Đang tải bảng thuật ngữ...
                  </td>
                </tr>
              ) : terms.length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    className="p-12 text-center text-sm text-slate-500 dark:text-zinc-400 space-y-2"
                  >
                    <div>
                      Chưa có thuật ngữ nào khớp bộ lọc. Hãy bấm{' '}
                      <strong>Nhập truyện</strong> rồi{' '}
                      <strong>Đếm từ cho Tập này</strong> hoặc{' '}
                      <strong>Import TSV/CSV</strong>.
                    </div>
                  </td>
                </tr>
              ) : (
                terms.map((term) => {
                  const checked = selectedIds.has(term.id)
                  const freqValue =
                    scope === 'volume' && term.volume_freq !== null
                      ? term.volume_freq
                      : term.total_freq
                  return (
                    <tr
                      key={term.id}
                      className={`group transition-colors ${
                        checked
                          ? 'bg-indigo-50/60 dark:bg-indigo-500/10'
                          : 'hover:bg-slate-50/80 dark:hover:bg-zinc-800/40'
                      } ${savingTermId === term.id ? 'opacity-70' : ''}`}
                    >
                      <td className="px-3 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleRow(term.id)}
                          className="rounded border-slate-300 text-indigo-600 cursor-pointer"
                        />
                      </td>

                      <td className="px-3 py-1.5">
                        <div className="font-semibold text-sm text-slate-900 dark:text-zinc-100">
                          {term.source_term}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          Vol {term.first_seen_vol}
                        </div>
                      </td>

                      <td className="px-2.5 py-1.5 text-center font-mono font-semibold text-slate-700 dark:text-zinc-300">
                        {freqValue}
                      </td>

                      <td className="px-1.5 py-1">
                        <InlineCellInput
                          value={term.vi_term}
                          placeholder="Nhập nghĩa Việt..."
                          onCommit={(v) =>
                            void handleInlinePatch(term, { vi_term: v })
                          }
                        />
                      </td>

                      <td className="px-1.5 py-1">
                        <InlineCellInput
                          value={term.reading}
                          placeholder="Romaji/Pinyin..."
                          onCommit={(v) =>
                            void handleInlinePatch(term, { reading: v })
                          }
                        />
                      </td>

                      <td className="px-1.5 py-1">
                        <InlineCellInput
                          value={term.han_viet}
                          placeholder="Hán-Việt..."
                          onCommit={(v) =>
                            void handleInlinePatch(term, { han_viet: v })
                          }
                        />
                      </td>

                      <td className="px-1.5 py-1">
                        <InlineCellInput
                          value={term.english_meaning}
                          placeholder="English..."
                          onCommit={(v) =>
                            void handleInlinePatch(term, {
                              english_meaning: v,
                            })
                          }
                        />
                      </td>

                      <td className="px-1.5 py-1">
                        <select
                          value={term.term_type}
                          onChange={(e) =>
                            void handleInlinePatch(term, {
                              term_type: e.target.value,
                            })
                          }
                          className="w-full px-2 py-1 rounded-md border border-transparent hover:border-slate-200 dark:hover:border-zinc-700 focus:border-indigo-500 bg-transparent focus:bg-white dark:focus:bg-zinc-950 text-xs focus:outline-none"
                        >
                          {TERM_TYPES.map((t) => (
                            <option
                              key={t}
                              value={t}
                              className="bg-white dark:bg-zinc-900"
                            >
                              {t}
                            </option>
                          ))}
                        </select>
                      </td>

                      <td className="px-1.5 py-1">
                        <select
                          value={term.status}
                          onChange={(e) =>
                            void handleInlinePatch(term, {
                              status: e.target.value as GlossaryStatus,
                            })
                          }
                          className={`w-full px-2 py-1 rounded-full text-[11px] font-medium border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500/40 ${GLOSSARY_STATUS_META[term.status].badgeClass}`}
                        >
                          {(
                            [
                              'new',
                              'translated',
                              'approved',
                              'ignored',
                            ] as GlossaryStatus[]
                          ).map((st) => (
                            <option
                              key={st}
                              value={st}
                              className="bg-white text-slate-900 dark:bg-zinc-900 dark:text-zinc-100"
                            >
                              {GLOSSARY_STATUS_META[st].label}
                            </option>
                          ))}
                        </select>
                      </td>

                      <td className="px-2 py-1 text-center">
                        <button
                          type="button"
                          title="Xóa thuật ngữ"
                          onClick={() => void handleDeleteOne(term)}
                          className="p-1 rounded text-slate-300 dark:text-zinc-600 group-hover:text-slate-400 hover:!text-rose-600 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Import Volume Book Modal */}
      {importModalOpen && selectedVolume && (
        <ImportVolumeModal
          volume={selectedVolume}
          seriesTitle={selectedSeries.title}
          onClose={() => setImportModalOpen(false)}
          onImported={(res) => {
            notify(
              `Đã nhập ${res.chapters_imported} chương vào Tập ${selectedVolume.volume_number}. Bạn có thể bấm "Đếm từ cho Tập này" ngay.`,
            )
          }}
        />
      )}

      {/* Manual Add Term Modal */}
      {addModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">
                Thêm thuật ngữ thủ công
              </h3>
              <button
                type="button"
                onClick={() => setAddModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateTerm} className="p-6 space-y-3.5 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Từ gốc *
                  </label>
                  <input
                    type="text"
                    required
                    value={newTermForm.source_term}
                    onChange={(e) =>
                      setNewTermForm({
                        ...newTermForm,
                        source_term: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Bản dịch Việt
                  </label>
                  <input
                    type="text"
                    value={newTermForm.vi_term}
                    onChange={(e) =>
                      setNewTermForm({
                        ...newTermForm,
                        vi_term: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Phiên âm
                  </label>
                  <input
                    type="text"
                    value={newTermForm.reading}
                    onChange={(e) =>
                      setNewTermForm({
                        ...newTermForm,
                        reading: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Hán-Việt
                  </label>
                  <input
                    type="text"
                    value={newTermForm.han_viet}
                    onChange={(e) =>
                      setNewTermForm({
                        ...newTermForm,
                        han_viet: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Nghĩa Anh
                  </label>
                  <input
                    type="text"
                    value={newTermForm.english_meaning}
                    onChange={(e) =>
                      setNewTermForm({
                        ...newTermForm,
                        english_meaning: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Loại
                  </label>
                  <select
                    value={newTermForm.term_type}
                    onChange={(e) =>
                      setNewTermForm({
                        ...newTermForm,
                        term_type: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  >
                    {TERM_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Trạng thái
                  </label>
                  <select
                    value={newTermForm.status}
                    onChange={(e) =>
                      setNewTermForm({
                        ...newTermForm,
                        status: e.target.value as GlossaryStatus,
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  >
                    {(
                      ['new', 'translated', 'approved', 'ignored'] as GlossaryStatus[]
                    ).map((st) => (
                      <option key={st} value={st}>
                        {GLOSSARY_STATUS_META[st].label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => setAddModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"
                >
                  Lưu thuật ngữ
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

interface InlineCellInputProps {
  value: string
  placeholder: string
  onCommit: (nextValue: string) => void
}

function InlineCellInput({
  value,
  placeholder,
  onCommit,
}: InlineCellInputProps) {
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          setDraft(value)
          e.currentTarget.blur()
        }
      }}
      className="w-full px-2 py-1.5 rounded-md border border-transparent hover:border-slate-200 dark:hover:border-zinc-700 focus:border-indigo-500 bg-transparent focus:bg-white dark:focus:bg-zinc-950 text-xs text-slate-800 dark:text-zinc-100 placeholder:text-slate-300 dark:placeholder:text-zinc-600 focus:outline-none"
    />
  )
}
