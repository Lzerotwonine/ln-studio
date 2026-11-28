import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Ban,
  BookMarked,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  FilterX,
  MoreHorizontal,
  Plus,
  ScanSearch,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionMenu } from '../components/ActionMenu'
import { GlossaryImportModal } from '../components/GlossaryImportModal'
import { ImportVolumeModal } from '../components/ImportVolumeModal'
import { TaskModelSelector } from '../components/TaskModelSelector'
import {
  bulkDeleteGlossaryTerms,
  bulkUpdateGlossaryStatus,
  bulkUpdateGlossaryType,
  createGlossaryTerm,
  deleteGlossaryTerm,
  extractErrorMessage,
  extractVolumeGlossary,
  fetchGlossary,
  getGlossaryExportUrl,
  translateNewGlossaryTerms,
  translateSelectedGlossaryTerms,
  updateGlossaryTerm,
} from '../lib/api'
import type {
  GlossaryBulkSelectionPayload,
  GlossaryFilterCriteria,
  GlossarySortBy,
  GlossaryStatus,
  GlossaryTerm,
  Series,
  SortDir,
  Volume,
} from '../types'
import {
  formatFirstSeenVol,
  formatVolumeLabel,
  GLOSSARY_STATUS_META,
  TERM_TYPES,
} from '../types'

interface GlossaryTabProps {
  selectedSeries: Series | null
  selectedVolume: Volume | null
  onBackToDashboard: () => void
}

type ScopeMode = 'volume' | 'series'
type PageSizeOption = 100 | 500 | 1000 | 0

const ROW_HEIGHT = 46
const VIRTUAL_OVERSCAN = 14
const VIRTUAL_THRESHOLD = 200

export function GlossaryTab({
  selectedSeries,
  selectedVolume,
  onBackToDashboard,
}: GlossaryTabProps) {
  // Scope & Filters
  const [scope, setScope] = useState<ScopeMode>(
    selectedVolume ? 'volume' : 'series',
  )
  const hadVolumeOnceRef = useRef<boolean>(selectedVolume !== null)
  const [statusFilter, setStatusFilter] = useState<'all' | GlossaryStatus>(
    'all',
  )
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [minFreq, setMinFreq] = useState<string>('')
  const [maxFreq, setMaxFreq] = useState<string>('')
  const [missingVi, setMissingVi] = useState<boolean>(false)
  const [missingHanViet, setMissingHanViet] = useState<boolean>(false)
  const [firstSeenVolFilter, setFirstSeenVolFilter] = useState<string>('all')
  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Sorting & Pagination
  const [sortBy, setSortBy] = useState<GlossarySortBy>('freq')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [pageSize, setPageSize] = useState<PageSizeOption>(100)
  const [page, setPage] = useState<number>(1)

  // Data
  const [terms, setTerms] = useState<GlossaryTerm[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [totalInScope, setTotalInScope] = useState(0)
  const [distinctFirstSeenVols, setDistinctFirstSeenVols] = useState<number[]>(
    [],
  )
  const [statusCounts, setStatusCounts] = useState<
    Record<GlossaryStatus, number>
  >({
    new: 0,
    translated: 0,
    approved: 0,
    ignored: 0,
  })
  const [loading, setLoading] = useState(false)
  const loadSeqRef = useRef(0)

  // Excel / Explorer Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null)
  const [selectAllMatching, setSelectAllMatching] = useState<boolean>(false)
  const [excludedIds, setExcludedIds] = useState<Set<number>>(new Set())
  const [savingTermId, setSavingTermId] = useState<number | null>(null)

  // Virtual scroll state (active when terms.length > VIRTUAL_THRESHOLD)
  const tableContainerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(520)

  // Operations & Modals
  const [modelOverride, setModelOverride] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [translatingSelected, setTranslatingSelected] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [importBookModalOpen, setImportBookModalOpen] = useState(false)
  const [importTsvModalOpen, setImportTsvModalOpen] = useState(false)
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [newTermForm, setNewTermForm] = useState({
    source_term: '',
    vi_term: '',
    reading: '',
    han_viet: '',
    english_meaning: '',
    term_type: 'Concept',
    status: 'approved' as GlossaryStatus,
    first_seen_vol: 0,
  })

  // Feedback
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  const notify = (msg: string) => {
    setToastMsg(msg)
    window.setTimeout(() => {
      setToastMsg((curr) => (curr === msg ? null : curr))
    }, 5000)
  }

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setAnchorIndex(null)
    setSelectAllMatching(false)
    setExcludedIds(new Set())
  }, [])

  // Auto-select volume scope once selectedVolume hydrates after initial mount
  useEffect(() => {
    if (selectedVolume && !hadVolumeOnceRef.current) {
      hadVolumeOnceRef.current = true
      setScope('volume')
    } else if (!selectedVolume && scope === 'volume') {
      setScope('series')
    }
  }, [selectedVolume, scope])

  // Debounce instant search
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchInput)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  // Reset to page 1 & clear selection whenever filters/scope/series/volume/sort change
  const seriesId = selectedSeries?.id ?? null
  const volumeId = selectedVolume?.id ?? null
  const effectiveVolumeId = scope === 'volume' && volumeId ? volumeId : null

  const parsedMinFreq = minFreq.trim() ? Math.max(1, Number(minFreq) || 1) : null
  const parsedMaxFreq = maxFreq.trim() ? Math.max(1, Number(maxFreq) || 1) : null
  const parsedFirstSeenVol =
    firstSeenVolFilter !== 'all' ? Number(firstSeenVolFilter) : null

  const activeFilterCriteria = useMemo<GlossaryFilterCriteria>(
    () => ({
      volume_id: effectiveVolumeId,
      status: statusFilter === 'all' ? null : statusFilter,
      term_type: typeFilter === 'all' ? null : typeFilter,
      min_freq: parsedMinFreq,
      max_freq: parsedMaxFreq,
      missing_vi: missingVi,
      missing_han_viet: missingHanViet,
      first_seen_vol: parsedFirstSeenVol,
      search: debouncedSearch.trim() || null,
    }),
    [
      effectiveVolumeId,
      statusFilter,
      typeFilter,
      parsedMinFreq,
      parsedMaxFreq,
      missingVi,
      missingHanViet,
      parsedFirstSeenVol,
      debouncedSearch,
    ],
  )

  useEffect(() => {
    setPage(1)
    clearSelection()
    if (tableContainerRef.current) {
      tableContainerRef.current.scrollTop = 0
      setScrollTop(0)
    }
  }, [
    seriesId,
    effectiveVolumeId,
    statusFilter,
    typeFilter,
    parsedMinFreq,
    parsedMaxFreq,
    missingVi,
    missingHanViet,
    parsedFirstSeenVol,
    debouncedSearch,
    sortBy,
    sortDir,
    pageSize,
    clearSelection,
  ])

  const loadGlossary = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!seriesId) {
      setTerms([])
      setTotalCount(0)
      setTotalInScope(0)
      setDistinctFirstSeenVols([])
      return
    }
    setLoading(true)
    setErrorMsg(null)
    try {
      const offset = pageSize > 0 ? (page - 1) * pageSize : 0
      const res = await fetchGlossary(seriesId, {
        volume_id: effectiveVolumeId,
        status: statusFilter === 'all' ? null : statusFilter,
        term_type: typeFilter === 'all' ? null : typeFilter,
        min_freq: parsedMinFreq,
        max_freq: parsedMaxFreq,
        missing_vi: missingVi,
        missing_han_viet: missingHanViet,
        first_seen_vol: parsedFirstSeenVol,
        search: debouncedSearch,
        sort_by: sortBy,
        sort_dir: sortDir,
        limit: pageSize,
        offset,
      })
      if (seq !== loadSeqRef.current) return
      setTerms(res.items)
      setTotalCount(res.total_count ?? res.total_filtered)
      setTotalInScope(res.total_in_scope)
      setStatusCounts(res.status_counts)
      setDistinctFirstSeenVols(res.distinct_first_seen_vols ?? [])
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      setErrorMsg(extractErrorMessage(err))
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false)
      }
    }
  }, [
    seriesId,
    effectiveVolumeId,
    statusFilter,
    typeFilter,
    parsedMinFreq,
    parsedMaxFreq,
    missingVi,
    missingHanViet,
    parsedFirstSeenVol,
    debouncedSearch,
    sortBy,
    sortDir,
    pageSize,
    page,
  ])

  useEffect(() => {
    void loadGlossary()
  }, [loadGlossary])

  // Track viewport height of scroll container for Virtual List
  useEffect(() => {
    const el = tableContainerRef.current
    if (!el) return
    const updateHeight = () => {
      if (el.clientHeight > 0) setViewportHeight(el.clientHeight)
    }
    updateHeight()
    const ro = new ResizeObserver(updateHeight)
    ro.observe(el)
    return () => ro.disconnect()
  }, [terms.length])

  // ---------- Selection Logic (Excel / Windows Explorer style) ----------

  const isRowSelected = useCallback(
    (termId: number): boolean => {
      if (selectAllMatching) return !excludedIds.has(termId)
      return selectedIds.has(termId)
    },
    [selectAllMatching, excludedIds, selectedIds],
  )

  const effectiveSelectedCount = selectAllMatching
    ? Math.max(0, totalCount - excludedIds.size)
    : selectedIds.size

  const allOnPageSelected =
    terms.length > 0 && terms.every((t) => isRowSelected(t.id))

  const buildBulkSelectionPayload = (): GlossaryBulkSelectionPayload => {
    if (selectAllMatching) {
      return {
        series_id: seriesId,
        apply_to_filter: true,
        filter: activeFilterCriteria,
        exclude_ids: Array.from(excludedIds),
      }
    }
    return {
      series_id: seriesId,
      term_ids: Array.from(selectedIds),
      apply_to_filter: false,
    }
  }

  const applyRangeSelect = (
    idx: number,
    additive: boolean,
  ) => {
    const startAnchor = anchorIndex ?? idx
    const lo = Math.min(startAnchor, idx)
    const hi = Math.max(startAnchor, idx)
    const rangeIds = terms.slice(lo, hi + 1).map((t) => t.id)

    if (selectAllMatching) {
      if (additive) {
        setExcludedIds((prev) => {
          const next = new Set(prev)
          rangeIds.forEach((id) => next.delete(id))
          return next
        })
      } else {
        setSelectAllMatching(false)
        setExcludedIds(new Set())
        setSelectedIds(new Set(rangeIds))
      }
      return
    }

    if (additive) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        rangeIds.forEach((id) => next.add(id))
        return next
      })
    } else {
      setSelectedIds(new Set(rangeIds))
    }
  }

  const toggleSingleId = (id: number, idx: number) => {
    setAnchorIndex(idx)
    if (selectAllMatching) {
      setExcludedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      return
    }
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleRowClick = (
    e: React.MouseEvent<HTMLTableRowElement>,
    idx: number,
    termId: number,
  ) => {
    const target = e.target as HTMLElement
    // Do not hijack clicks inside inline inputs, selects, buttons, or checkboxes
    if (target.closest('input, select, button, a, label')) return

    const isCtrl = e.ctrlKey || e.metaKey
    const isShift = e.shiftKey

    if (isShift && isCtrl) {
      // Ctrl + Shift + Click: keep old regions + add new contiguous range
      window.getSelection()?.removeAllRanges()
      applyRangeSelect(idx, true)
    } else if (isShift) {
      // Shift + Click: select contiguous range from anchor
      window.getSelection()?.removeAllRanges()
      applyRangeSelect(idx, false)
    } else if (isCtrl) {
      // Ctrl + Click: toggle single row
      toggleSingleId(termId, idx)
    } else {
      // Plain Click: select single row + set anchor
      setSelectAllMatching(false)
      setExcludedIds(new Set())
      setSelectedIds(new Set([termId]))
      setAnchorIndex(idx)
    }
  }

  const handleCheckboxClick = (
    e: React.MouseEvent<HTMLInputElement>,
    idx: number,
    termId: number,
  ) => {
    e.stopPropagation()
    const isCtrl = e.ctrlKey || e.metaKey
    const isShift = e.shiftKey

    if (isShift && isCtrl) {
      applyRangeSelect(idx, true)
    } else if (isShift) {
      applyRangeSelect(idx, false)
    } else {
      toggleSingleId(termId, idx)
    }
  }

  const handleToggleSelectPage = () => {
    if (allOnPageSelected) {
      clearSelection()
    } else {
      setSelectAllMatching(false)
      setExcludedIds(new Set())
      setSelectedIds(new Set(terms.map((t) => t.id)))
      setAnchorIndex(0)
    }
  }

  const handleSelectAllMatchingFilter = () => {
    setSelectAllMatching(true)
    setExcludedIds(new Set())
    setSelectedIds(new Set(terms.map((t) => t.id)))
  }

  // ---------- Sorting ----------

  const handleSortClick = (col: GlossarySortBy) => {
    if (sortBy === col) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(col)
      setSortDir(col === 'freq' ? 'desc' : 'asc')
    }
  }

  const renderSortIcon = (col: GlossarySortBy) => {
    if (sortBy !== col) {
      return <ArrowUpDown className="w-3 h-3 text-slate-400/70 shrink-0" />
    }
    return sortDir === 'asc' ? (
      <ArrowUp className="w-3 h-3 text-indigo-600 dark:text-indigo-400 shrink-0" />
    ) : (
      <ArrowDown className="w-3 h-3 text-indigo-600 dark:text-indigo-400 shrink-0" />
    )
  }

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
        `Đã đếm xong ${res.total_extracted} thuật ngữ cho ${formatVolumeLabel(selectedVolume)}: +${res.new_terms} từ mới, ${res.existing_terms} từ đã có trong Master DB.`,
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
      const res = await translateNewGlossaryTerms(selectedSeries.id, {
        volume_id: effectiveVolumeId,
        batch_size: 400,
        max_rounds: 3,
        model_override: modelOverride || null,
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

  const handleTranslateSelected = async () => {
    if (!selectedSeries || effectiveSelectedCount === 0) return
    setTranslatingSelected(true)
    setErrorMsg(null)
    try {
      const sel = buildBulkSelectionPayload()
      const res = await translateSelectedGlossaryTerms(selectedSeries.id, {
        term_ids: sel.term_ids,
        apply_to_filter: sel.apply_to_filter,
        filter: sel.filter,
        exclude_ids: sel.exclude_ids,
        batch_size: 400,
        max_rounds: 3,
        model_override: modelOverride || null,
      })
      notify(
        `Đã dịch lại bằng AI ${res.translated_count}/${res.total_new_found} thuật ngữ đã chọn qua ${res.rounds_used} vòng${res.missing_count > 0 ? ` (còn thiếu ${res.missing_count} từ)` : ''}.`,
      )
      clearSelection()
      await loadGlossary()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setTranslatingSelected(false)
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
    if (effectiveSelectedCount === 0) return
    setBulkBusy(true)
    setErrorMsg(null)
    try {
      const res = await bulkUpdateGlossaryStatus(
        buildBulkSelectionPayload(),
        nextStatus,
      )
      notify(
        `Đã chuyển ${res.updated.toLocaleString('vi-VN')} thuật ngữ sang "${GLOSSARY_STATUS_META[nextStatus].label}".`,
      )
      clearSelection()
      await loadGlossary()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setBulkBusy(false)
    }
  }

  const handleBulkType = async (nextType: string) => {
    if (!nextType || effectiveSelectedCount === 0) return
    setBulkBusy(true)
    setErrorMsg(null)
    try {
      const res = await bulkUpdateGlossaryType(
        buildBulkSelectionPayload(),
        nextType,
      )
      notify(
        `Đã đổi loại ${res.updated.toLocaleString('vi-VN')} thuật ngữ sang "${nextType}".`,
      )
      clearSelection()
      await loadGlossary()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setBulkBusy(false)
    }
  }

  const handleBulkDelete = async () => {
    if (effectiveSelectedCount === 0) return
    const scopeHint = selectAllMatching
      ? `TẤT CẢ ${effectiveSelectedCount.toLocaleString('vi-VN')} thuật ngữ khớp bộ lọc hiện tại`
      : `${effectiveSelectedCount.toLocaleString('vi-VN')} thuật ngữ đã chọn`
    if (!window.confirm(`Xóa vĩnh viễn ${scopeHint}?`)) {
      return
    }
    setBulkBusy(true)
    setErrorMsg(null)
    try {
      const res = await bulkDeleteGlossaryTerms(buildBulkSelectionPayload())
      notify(`Đã xóa ${res.deleted.toLocaleString('vi-VN')} thuật ngữ.`)
      clearSelection()
      await loadGlossary()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setBulkBusy(false)
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
        first_seen_vol: selectedVolume ? selectedVolume.volume_number : 0,
      })
      notify('Đã thêm thuật ngữ mới vào Master Glossary.')
      await loadGlossary()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const hasAdvancedFilters =
    statusFilter !== 'all' ||
    typeFilter !== 'all' ||
    minFreq.trim() !== '' ||
    maxFreq.trim() !== '' ||
    missingVi ||
    missingHanViet ||
    firstSeenVolFilter !== 'all' ||
    searchInput.trim() !== ''

  const resetAllFilters = () => {
    setStatusFilter('all')
    setTypeFilter('all')
    setMinFreq('')
    setMaxFreq('')
    setMissingVi(false)
    setMissingHanViet(false)
    setFirstSeenVolFilter('all')
    setSearchInput('')
    setDebouncedSearch('')
  }

  if (!selectedSeries) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-6">
        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 text-center space-y-3">
          <BookMarked className="w-8 h-8 mx-auto text-indigo-500" />
          <h2 className="text-lg font-bold text-slate-900 dark:text-zinc-100">
            Chưa có bộ truyện nào được chọn
          </h2>
          <p className="text-sm text-slate-500 dark:text-zinc-400">
            Hãy tạo hoặc chọn một bộ truyện ở Quản lý truyện để bắt đầu xây dựng
            Kho thuật ngữ.
          </p>
          <button
            type="button"
            onClick={onBackToDashboard}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"
          >
            Đi tới Quản lý truyện
          </button>
        </div>
      </div>
    )
  }

  // Pagination & Virtual List window calculations
  const totalPages =
    pageSize > 0 ? Math.max(1, Math.ceil(totalCount / pageSize)) : 1
  const showingFrom =
    totalCount === 0 ? 0 : pageSize > 0 ? (page - 1) * pageSize + 1 : 1
  const showingTo =
    totalCount === 0
      ? 0
      : pageSize > 0
        ? Math.min(totalCount, (page - 1) * pageSize + terms.length)
        : terms.length

  const isVirtualized = terms.length > VIRTUAL_THRESHOLD
  const startIdx = isVirtualized
    ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - VIRTUAL_OVERSCAN)
    : 0
  const endIdx = isVirtualized
    ? Math.min(
        terms.length,
        Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + VIRTUAL_OVERSCAN,
      )
    : terms.length
  const visibleSlice = terms.slice(startIdx, endIdx)
  const topSpacerHeight = isVirtualized ? startIdx * ROW_HEIGHT : 0
  const bottomSpacerHeight = isVirtualized
    ? Math.max(0, (terms.length - endIdx) * ROW_HEIGHT)
    : 0

  return (
    <div className="max-w-[1640px] mx-auto p-5 pb-20 space-y-4">
      {/* Header + 2 Primary Actions + Compact Dropdown */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
              Kho thuật ngữ
            </h2>
            <span
              className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${
                effectiveVolumeId
                  ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
                  : 'bg-slate-200/80 text-slate-700 dark:bg-zinc-800 dark:text-zinc-300'
              }`}
            >
              {effectiveVolumeId && selectedVolume
                ? `Riêng ${formatVolumeLabel(selectedVolume)}`
                : 'Toàn bộ truyện'}
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
            Đếm từ theo từng tập, dịch hàng loạt bằng AI, chọn nhiều dòng nhanh
            và nhập kho thuật ngữ từ bảng tính.
          </p>
        </div>

        {/* 2 Primary Actions + Quick Model Override + Secondary Dropdown */}
        <div className="flex flex-wrap items-center gap-2">
          <TaskModelSelector
            taskKey="glossary_translate"
            value={modelOverride}
            onChange={setModelOverride}
          />
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
              : `Dịch từ mới (${statusCounts.new.toLocaleString('vi-VN')})`}
          </button>

          <ActionMenu
            label="Nhập / Xuất"
            icon={<MoreHorizontal className="w-3.5 h-3.5" />}
            items={[
              {
                label: 'Thêm thuật ngữ thủ công',
                icon: <Plus className="w-3.5 h-3.5 text-indigo-500" />,
                onClick: () => {
                  setNewTermForm((prev) => ({
                    ...prev,
                    first_seen_vol: selectedVolume
                      ? selectedVolume.volume_number
                      : 0,
                  }))
                  setAddModalOpen(true)
                },
              },
              {
                label: 'Nhập tệp truyện (.epub/.txt/.docx)',
                icon: <Upload className="w-3.5 h-3.5 text-indigo-500" />,
                disabled: !selectedVolume,
                onClick: () => setImportBookModalOpen(true),
              },
              {
                label: 'Import TSV / CSV từ Excel (2 bước)',
                icon: <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />,
                dividerBefore: true,
                onClick: () => setImportTsvModalOpen(true),
              },
              {
                label: 'Export TSV (Excel — toàn bộ bộ lọc)',
                icon: <Download className="w-3.5 h-3.5" />,
                href: getGlossaryExportUrl(
                  selectedSeries.id,
                  'tsv',
                  activeFilterCriteria,
                ),
              },
              {
                label: 'Export CSV (toàn bộ bộ lọc)',
                icon: <Download className="w-3.5 h-3.5" />,
                href: getGlossaryExportUrl(
                  selectedSeries.id,
                  'csv',
                  activeFilterCriteria,
                ),
              },
            ]}
          />
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
                ? `Chỉ ${formatVolumeLabel(selectedVolume)}`
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
              Tất cả ({totalInScope.toLocaleString('vi-VN')})
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
                  {GLOSSARY_STATUS_META[st].label} (
                  {(statusCounts[st] ?? 0).toLocaleString('vi-VN')})
                </button>
              ),
            )}
          </div>
        </div>

        {/* Search + Advanced Filters Row */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Tìm tức thì theo từ gốc, nghĩa Việt, phiên âm, Hán-Việt, tiếng Anh..."
              className="w-full pl-9 pr-3 py-1.5 text-xs rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
            />
          </div>

          <select
            aria-label="Lọc theo loại thuật ngữ"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
          >
            <option value="all">Mọi loại</option>
            {TERM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <select
            aria-label="Lọc theo tập đầu xuất hiện"
            value={firstSeenVolFilter}
            onChange={(e) => setFirstSeenVolFilter(e.target.value)}
            className="px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
          >
            <option value="all">Mọi tập đầu</option>
            {distinctFirstSeenVols.map((vNum) => (
              <option key={vNum} value={String(vNum)}>
                {vNum <= 0 ? 'Gốc (0)' : `Tập ${vNum}`}
              </option>
            ))}
          </select>

          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-xs text-slate-600 dark:text-zinc-300">
            <span>Tần suất</span>
            <input
              type="number"
              min={1}
              aria-label="Tần suất tối thiểu"
              placeholder="Từ"
              value={minFreq}
              onChange={(e) => setMinFreq(e.target.value)}
              className="w-12 px-1.5 py-0.5 text-xs rounded bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-center"
            />
            <span>–</span>
            <input
              type="number"
              min={1}
              aria-label="Tần suất tối đa"
              placeholder="Đến"
              value={maxFreq}
              onChange={(e) => setMaxFreq(e.target.value)}
              className="w-12 px-1.5 py-0.5 text-xs rounded bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-center"
            />
          </div>

          <button
            type="button"
            onClick={() => setMissingVi((prev) => !prev)}
            className={`px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-colors cursor-pointer ${
              missingVi
                ? 'border-amber-500 bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300'
                : 'border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
            }`}
          >
            Chưa dịch Việt
          </button>

          <button
            type="button"
            onClick={() => setMissingHanViet((prev) => !prev)}
            className={`px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-colors cursor-pointer ${
              missingHanViet
                ? 'border-amber-500 bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300'
                : 'border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
            }`}
          >
            Chưa có Hán-Việt
          </button>

          {hasAdvancedFilters && (
            <button
              type="button"
              onClick={resetAllFilters}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 cursor-pointer"
            >
              <FilterX className="w-3.5 h-3.5" />
              Xóa lọc
            </button>
          )}
        </div>
      </div>

      {/* Gmail/Excel-style Select All Matching Banner */}
      {allOnPageSelected && totalCount > terms.length && (
        <div className="flex flex-wrap items-center justify-center gap-2 px-4 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-500/15 border border-indigo-200 dark:border-indigo-500/30 text-xs text-indigo-900 dark:text-indigo-200">
          {selectAllMatching ? (
            <>
              <span>
                Đang chọn{' '}
                <strong>
                  tất cả {effectiveSelectedCount.toLocaleString('vi-VN')} từ
                </strong>{' '}
                khớp bộ lọc hiện tại.
              </span>
              <button
                type="button"
                onClick={clearSelection}
                className="font-semibold underline hover:text-indigo-600 cursor-pointer"
              >
                Bỏ chọn tất cả
              </button>
            </>
          ) : (
            <>
              <span>
                Đã chọn <strong>{terms.length.toLocaleString('vi-VN')}</strong>{' '}
                từ trên trang này.
              </span>
              <button
                type="button"
                onClick={handleSelectAllMatchingFilter}
                className="font-bold text-indigo-700 dark:text-indigo-300 underline hover:text-indigo-900 cursor-pointer"
              >
                Chọn tất cả {totalCount.toLocaleString('vi-VN')} từ khớp bộ lọc
                hiện tại
              </button>
            </>
          )}
        </div>
      )}

      {/* Spreadsheet Table (with Virtual List when >200 rows) */}
      <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-xs">
        <div
          ref={tableContainerRef}
          onScroll={(e) => {
            if (isVirtualized) {
              setScrollTop(e.currentTarget.scrollTop)
            }
          }}
          className="overflow-x-auto max-h-[62vh] overflow-y-auto"
        >
          <table className="w-full text-left border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-zinc-950 text-slate-600 dark:text-zinc-400 uppercase text-[11px] border-b border-slate-200 dark:border-zinc-800 select-none">
              <tr>
                <th className="w-9 px-3 py-2.5 text-center">
                  <input
                    type="checkbox"
                    aria-label="Chọn tất cả trang này"
                    checked={allOnPageSelected}
                    onChange={handleToggleSelectPage}
                    className="rounded border-slate-300 text-indigo-600 cursor-pointer"
                  />
                </th>
                <th className="px-3 py-2.5 font-semibold min-w-[155px]">
                  <button
                    type="button"
                    onClick={() => handleSortClick('source_term')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-zinc-100 cursor-pointer uppercase"
                  >
                    Từ gốc {renderSortIcon('source_term')}
                  </button>
                </th>
                <th className="px-2 py-2.5 font-semibold text-center w-20">
                  <button
                    type="button"
                    onClick={() => handleSortClick('first_seen_vol')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-zinc-100 cursor-pointer uppercase"
                  >
                    Tập đầu {renderSortIcon('first_seen_vol')}
                  </button>
                </th>
                <th className="px-2 py-2.5 font-semibold text-center w-20">
                  <button
                    type="button"
                    onClick={() => handleSortClick('freq')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-zinc-100 cursor-pointer uppercase"
                  >
                    Tần suất {renderSortIcon('freq')}
                  </button>
                </th>
                <th className="px-2.5 py-2.5 font-semibold min-w-[175px]">
                  <button
                    type="button"
                    onClick={() => handleSortClick('vi_term')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-zinc-100 cursor-pointer uppercase"
                  >
                    Bản dịch Việt {renderSortIcon('vi_term')}
                  </button>
                </th>
                <th className="px-2.5 py-2.5 font-semibold min-w-[130px]">
                  Phiên âm
                </th>
                <th className="px-2.5 py-2.5 font-semibold min-w-[115px]">
                  Hán-Việt
                </th>
                <th className="px-2.5 py-2.5 font-semibold min-w-[135px]">
                  Nghĩa Anh
                </th>
                <th className="px-2.5 py-2.5 font-semibold w-32">
                  <button
                    type="button"
                    onClick={() => handleSortClick('term_type')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-zinc-100 cursor-pointer uppercase"
                  >
                    Loại {renderSortIcon('term_type')}
                  </button>
                </th>
                <th className="px-2.5 py-2.5 font-semibold w-32">
                  <button
                    type="button"
                    onClick={() => handleSortClick('status')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-zinc-100 cursor-pointer uppercase"
                  >
                    Trạng thái {renderSortIcon('status')}
                  </button>
                </th>
                <th className="w-9 px-2 py-2.5 text-center" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-zinc-800/80">
              {loading ? (
                <tr>
                  <td
                    colSpan={11}
                    className="p-10 text-center text-sm text-slate-400"
                  >
                    Đang tải bảng thuật ngữ...
                  </td>
                </tr>
              ) : terms.length === 0 ? (
                <tr>
                  <td
                    colSpan={11}
                    className="p-12 text-center text-sm text-slate-500 dark:text-zinc-400"
                  >
                    {effectiveVolumeId
                      ? 'Không có thuật ngữ nào xuất hiện trong tập này khớp bộ lọc. Hãy bấm "Đếm từ cho Tập này" hoặc chuyển sang "Toàn Series".'
                      : 'Chưa có thuật ngữ nào khớp bộ lọc. Hãy bấm "Đếm từ cho Tập này" hoặc "Import TSV / CSV từ Excel".'}
                  </td>
                </tr>
              ) : (
                <>
                  {topSpacerHeight > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={11} style={{ height: `${topSpacerHeight}px`, padding: 0 }} />
                    </tr>
                  )}
                  {visibleSlice.map((term, localIdx) => {
                    const rowIdx = startIdx + localIdx
                    const checked = isRowSelected(term.id)
                    const freqValue =
                      effectiveVolumeId !== null && term.volume_freq !== null
                        ? term.volume_freq
                        : term.total_freq
                    return (
                      <tr
                        key={term.id}
                        style={
                          isVirtualized ? { height: `${ROW_HEIGHT}px` } : undefined
                        }
                        onClick={(e) => handleRowClick(e, rowIdx, term.id)}
                        className={`group transition-colors select-none ${
                          checked
                            ? 'bg-indigo-50/80 dark:bg-indigo-500/15'
                            : 'hover:bg-slate-50/80 dark:hover:bg-zinc-800/40'
                        } ${savingTermId === term.id ? 'opacity-70' : ''}`}
                      >
                        <td className="px-3 py-1.5 text-center">
                          <input
                            type="checkbox"
                            aria-label={`Chọn ${term.source_term}`}
                            checked={checked}
                            onChange={() => {}}
                            onClick={(e) =>
                              handleCheckboxClick(e, rowIdx, term.id)
                            }
                            className="rounded border-slate-300 text-indigo-600 cursor-pointer"
                          />
                        </td>

                        <td className="px-3 py-1.5 font-semibold text-sm text-slate-900 dark:text-zinc-100 cursor-pointer">
                          {term.source_term}
                        </td>

                        <td className="px-2 py-1.5 text-center">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-semibold ${
                              term.first_seen_vol <= 0
                                ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'
                                : 'bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400'
                            }`}
                          >
                            {formatFirstSeenVol(term.first_seen_vol)}
                          </span>
                        </td>

                        <td className="px-2 py-1.5 text-center font-mono font-semibold text-slate-700 dark:text-zinc-300">
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
                            aria-label={`Loại của ${term.source_term}`}
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
                            aria-label={`Trạng thái của ${term.source_term}`}
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
                  })}
                  {bottomSpacerHeight > 0 && (
                    <tr aria-hidden="true">
                      <td
                        colSpan={11}
                        style={{ height: `${bottomSpacerHeight}px`, padding: 0 }}
                      />
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="px-4 py-2.5 border-t border-slate-200 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-950/60 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 dark:text-zinc-400">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              Hiển thị{' '}
              <strong>
                {showingFrom.toLocaleString('vi-VN')}–
                {showingTo.toLocaleString('vi-VN')}
              </strong>{' '}
              / <strong>{totalCount.toLocaleString('vi-VN')}</strong> kết quả
              {isVirtualized && (
                <span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[10px] font-semibold">
                  Virtual List
                </span>
              )}
            </span>

            {totalCount > 0 && !selectAllMatching && (
              <button
                type="button"
                onClick={handleSelectAllMatchingFilter}
                className="text-indigo-600 dark:text-indigo-400 hover:underline font-semibold cursor-pointer"
              >
                Chọn tất cả {totalCount.toLocaleString('vi-VN')} từ khớp bộ lọc
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center gap-1.5">
              <span>Hiển thị:</span>
              <select
                aria-label="Số dòng mỗi trang"
                value={pageSize}
                onChange={(e) =>
                  setPageSize(Number(e.target.value) as PageSizeOption)
                }
                className="px-2 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 font-medium text-xs"
              >
                <option value={100}>100 / trang</option>
                <option value={500}>500 / trang</option>
                <option value={1000}>1.000 / trang</option>
                <option value={0}>Tất cả (Virtual List)</option>
              </select>
            </div>

            {pageSize > 0 && (
              <div className="inline-flex items-center gap-1">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 disabled:opacity-35 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                  title="Trang trước"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="px-2 font-mono font-semibold text-slate-800 dark:text-zinc-200">
                  Trang {page} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 disabled:opacity-35 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                  title="Trang sau"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Floating Bottom Bulk Action Bar */}
      {effectiveSelectedCount > 0 && (
        <div className="sticky bottom-3 z-30 flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-2xl bg-slate-900/95 dark:bg-zinc-900/95 text-white border border-slate-700/80 shadow-2xl backdrop-blur-sm text-xs">
          <div className="flex items-center gap-2 font-semibold">
            <span className="px-2.5 py-1 rounded-lg bg-indigo-600 text-white font-mono">
              {effectiveSelectedCount.toLocaleString('vi-VN')}
            </span>
            <span>
              {selectAllMatching
                ? 'từ khớp bộ lọc hiện tại đang chọn'
                : 'thuật ngữ đang chọn'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Bulk Status */}
            <button
              type="button"
              disabled={bulkBusy || translatingSelected}
              onClick={() => void handleBulkStatus('approved')}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-45 cursor-pointer"
            >
              <CheckCheck className="w-3.5 h-3.5" />
              Duyệt
            </button>
            <button
              type="button"
              disabled={bulkBusy || translatingSelected}
              onClick={() => void handleBulkStatus('translated')}
              className="px-2.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold disabled:opacity-45 cursor-pointer"
            >
              Đã dịch
            </button>
            <button
              type="button"
              disabled={bulkBusy || translatingSelected}
              onClick={() => void handleBulkStatus('ignored')}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white font-semibold disabled:opacity-45 cursor-pointer"
            >
              <Ban className="w-3.5 h-3.5" />
              Bỏ qua
            </button>
            <button
              type="button"
              disabled={bulkBusy || translatingSelected}
              onClick={() => void handleBulkStatus('new')}
              className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white disabled:opacity-45 cursor-pointer"
            >
              Chưa dịch
            </button>

            {/* Bulk Type */}
            <select
              aria-label="Đổi loại hàng loạt"
              disabled={bulkBusy || translatingSelected}
              value=""
              onChange={(e) => {
                if (e.target.value) void handleBulkType(e.target.value)
              }}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-xs font-medium cursor-pointer disabled:opacity-45"
            >
              <option value="">Đổi loại...</option>
              {TERM_TYPES.map((t) => (
                <option key={t} value={t}>
                  → {t}
                </option>
              ))}
            </select>

            {/* Re-translate selected with AI */}
            <button
              type="button"
              disabled={bulkBusy || translatingSelected}
              onClick={() => void handleTranslateSelected()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold disabled:opacity-45 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {translatingSelected ? 'Đang dịch AI...' : 'Dịch lại AI'}
            </button>

            {/* Bulk Delete */}
            <button
              type="button"
              disabled={bulkBusy || translatingSelected}
              onClick={() => void handleBulkDelete()}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold disabled:opacity-45 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Xóa
            </button>

            <button
              type="button"
              onClick={clearSelection}
              className="px-2 py-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer"
            >
              Bỏ chọn
            </button>
          </div>
        </div>
      )}

      {/* Import Volume Book Modal */}
      {importBookModalOpen && selectedVolume && (
        <ImportVolumeModal
          volume={selectedVolume}
          seriesTitle={selectedSeries.title}
          onClose={() => setImportBookModalOpen(false)}
          onImported={(res) => {
            notify(
              `Đã nhập ${res.chapters_imported} chương vào ${formatVolumeLabel(selectedVolume)}. Bạn có thể bấm "Đếm từ cho Tập này" ngay.`,
            )
          }}
        />
      )}

      {/* 2-Step Historical TSV / CSV Import Modal */}
      {importTsvModalOpen && (
        <GlossaryImportModal
          series={selectedSeries}
          selectedVolume={selectedVolume}
          onClose={() => setImportTsvModalOpen(false)}
          onImported={(res) => {
            notify(
              `Đã nhập TSV/CSV: +${res.imported.toLocaleString('vi-VN')} từ mới, cập nhật ${res.updated.toLocaleString('vi-VN')} từ${res.skipped > 0 ? `, bỏ qua ${res.skipped.toLocaleString('vi-VN')} từ` : ''}.`,
            )
            void loadGlossary()
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

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="col-span-2 sm:col-span-1">
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
                    Tập đầu (0=Gốc)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={newTermForm.first_seen_vol}
                    onChange={(e) =>
                      setNewTermForm({
                        ...newTermForm,
                        first_seen_vol: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-center"
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
      className="w-full px-2 py-1 rounded-md border border-transparent hover:border-slate-200 dark:hover:border-zinc-700 focus:border-indigo-500 bg-transparent focus:bg-white dark:focus:bg-zinc-950 text-xs text-slate-800 dark:text-zinc-100 placeholder:text-slate-300 dark:placeholder:text-zinc-600 focus:outline-none select-text"
    />
  )
}
