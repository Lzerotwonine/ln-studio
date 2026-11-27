import {
  BookOpen,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Download,
  Edit3,
  Eye,
  FileText,
  MoreHorizontal,
  Replace,
  Save,
  Sparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionMenu } from '../components/ActionMenu'
import { MarkdownPreview } from '../components/MarkdownPreview'
import { TaskModelSelector } from '../components/TaskModelSelector'
import {
  extractErrorMessage,
  fetchChapterProofread,
  fetchVolumeChapters,
  findReplaceVolume,
  getVolumeDocxExportUrl,
  getVolumeEpubExportUrl,
  retranslateChapterSelection,
  saveChapterTranslation,
} from '../lib/api'
import type {
  ChapterProofreadData,
  ChapterSummary,
  FindReplaceResponse,
  GlossaryHighlightItem,
  Series,
  Volume,
} from '../types'
import { formatVolumeLabel } from '../types'

interface ProofreadTabProps {
  selectedSeries: Series | null
  selectedVolume: Volume | null
  onBackToDashboard: () => void
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface RawSegment {
  text: string
  term: GlossaryHighlightItem | null
}

function tokenizeRawWithGlossary(
  rawText: string,
  highlights: GlossaryHighlightItem[],
): RawSegment[] {
  if (!rawText || highlights.length === 0) {
    return [{ text: rawText, term: null }]
  }

  // Sort longest terms first and deduplicate by source_term
  const termMap = new Map<string, GlossaryHighlightItem>()
  const uniqueTerms: string[] = []
  const sorted = [...highlights].sort(
    (a, b) => b.source_term.length - a.source_term.length,
  )
  for (const item of sorted) {
    const key = item.source_term
    if (!key || termMap.has(key)) continue
    termMap.set(key, item)
    uniqueTerms.push(escapeRegExp(key))
    if (uniqueTerms.length >= 400) break
  }

  if (uniqueTerms.length === 0) {
    return [{ text: rawText, term: null }]
  }

  const regex = new RegExp(`(${uniqueTerms.join('|')})`, 'g')
  const parts = rawText.split(regex)
  return parts
    .filter((p) => p.length > 0)
    .map((p) => ({
      text: p,
      term: termMap.get(p) ?? null,
    }))
}

export function ProofreadTab({
  selectedSeries,
  selectedVolume,
  onBackToDashboard,
}: ProofreadTabProps) {
  const [chapters, setChapters] = useState<ChapterSummary[]>([])
  const [activeChapterId, setActiveChapterId] = useState<number | null>(null)
  const [chapterData, setChapterData] = useState<ChapterProofreadData | null>(
    null,
  )
  const [loadingChapter, setLoadingChapter] = useState(false)
  const chapterLoadSeqRef = useRef(0)

  // Editor & Auto-save state
  const [draftText, setDraftText] = useState('')
  const [savedText, setSavedText] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [fontSize, setFontSize] = useState<number>(15)
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit')
  const [retransModelOverride, setRetransModelOverride] = useState<string>('')

  // Hover tooltip state for Raw glossary highlights
  const [hoveredTerm, setHoveredTerm] = useState<{
    term: GlossaryHighlightItem
    x: number
    y: number
  } | null>(null)

  // Selection state for "Dịch lại đoạn đang bôi đen"
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const [selectionInfo, setSelectionInfo] = useState<{
    text: string
    side: 'raw' | 'translated'
    start: number
    end: number
  } | null>(null)
  const [retransModalOpen, setRetransModalOpen] = useState(false)
  const [retransInstruction, setRetransInstruction] = useState('')
  const [retransLoading, setRetransLoading] = useState(false)
  const [retransResult, setRetransResult] = useState<string | null>(null)
  const [retransSlot, setRetransSlot] = useState<string | null>(null)

  // Find & Replace Modal state
  const [frModalOpen, setFrModalOpen] = useState(false)
  const [frFind, setFrFind] = useState('')
  const [frReplace, setFrReplace] = useState('')
  const [frRegex, setFrRegex] = useState(false)
  const [frCaseSensitive, setFrCaseSensitive] = useState(true)
  const [frBusy, setFrBusy] = useState(false)
  const [frPreview, setFrPreview] = useState<FindReplaceResponse | null>(null)

  // Feedback
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  const notify = (msg: string) => {
    setToastMsg(msg)
    window.setTimeout(() => {
      setToastMsg((curr) => (curr === msg ? null : curr))
    }, 4000)
  }

  const volumeId = selectedVolume?.id ?? null

  // Reset all state & reload chapters cleanly whenever active volume changes
  useEffect(() => {
    chapterLoadSeqRef.current += 1
    setChapters([])
    setActiveChapterId(null)
    setChapterData(null)
    setDraftText('')
    setSavedText('')
    setSaveState('saved')
    setSelectionInfo(null)
    setHoveredTerm(null)
    setFrPreview(null)
    setErrorMsg(null)

    if (!volumeId) return

    let cancelled = false
    fetchVolumeChapters(volumeId)
      .then((list) => {
        if (cancelled) return
        setChapters(list)
        setActiveChapterId(list.length > 0 ? list[0].id : null)
      })
      .catch((err) => {
        if (!cancelled) setErrorMsg(extractErrorMessage(err))
      })

    return () => {
      cancelled = true
    }
  }, [volumeId])

  const loadChapterData = useCallback(async (chapterId: number) => {
    const seq = ++chapterLoadSeqRef.current
    setLoadingChapter(true)
    setErrorMsg(null)
    setSelectionInfo(null)
    setHoveredTerm(null)
    try {
      const data = await fetchChapterProofread(chapterId)
      if (seq !== chapterLoadSeqRef.current) return
      setChapterData(data)
      setDraftText(data.translated_text)
      setSavedText(data.translated_text)
      setSaveState('saved')
    } catch (err) {
      if (seq !== chapterLoadSeqRef.current) return
      setErrorMsg(extractErrorMessage(err))
    } finally {
      if (seq === chapterLoadSeqRef.current) {
        setLoadingChapter(false)
      }
    }
  }, [])

  useEffect(() => {
    if (activeChapterId !== null) {
      void loadChapterData(activeChapterId)
    }
  }, [activeChapterId, loadChapterData])

  // Persist helper
  const commitSave = useCallback(
    async (chapterId: number, textToSave: string) => {
      setSaveState('saving')
      try {
        const res = await saveChapterTranslation(chapterId, textToSave)
        setSavedText(textToSave)
        setSaveState('saved')
        setChapterData((prev) =>
          prev && prev.id === chapterId
            ? {
                ...prev,
                translated_text: textToSave,
                char_ratio: res.char_ratio,
                status: res.status as ChapterProofreadData['status'],
              }
            : prev,
        )
      } catch (err) {
        setSaveState('error')
        setErrorMsg(extractErrorMessage(err))
      }
    },
    [],
  )

  // Debounced auto-save after 1.5s of idle typing
  useEffect(() => {
    if (activeChapterId === null) return
    if (draftText === savedText) return

    setSaveState('dirty')
    const timer = window.setTimeout(() => {
      void commitSave(activeChapterId, draftText)
    }, 1500)

    return () => window.clearTimeout(timer)
  }, [draftText, savedText, activeChapterId, commitSave])

  // Keyboard Ctrl+S instant save
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (activeChapterId !== null && draftText !== savedText) {
          e.preventDefault()
          void commitSave(activeChapterId, draftText)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeChapterId, draftText, savedText, commitSave])

  const rawSegments = useMemo(() => {
    if (!chapterData) return []
    return tokenizeRawWithGlossary(
      chapterData.raw_text,
      chapterData.glossary_highlights,
    )
  }, [chapterData])

  const activeIndexInList = chapters.findIndex((c) => c.id === activeChapterId)

  const handleSwitchChapter = async (nextChapterId: number) => {
    if (activeChapterId !== null && draftText !== savedText) {
      await commitSave(activeChapterId, draftText)
    }
    setActiveChapterId(nextChapterId)
  }

  // Capture selection in translation textarea
  const captureEditorSelection = () => {
    const el = editorRef.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const selected = el.value.slice(start, end).trim()
    if (selected.length >= 2) {
      setSelectionInfo({ text: selected, side: 'translated', start, end })
    }
  }

  // Capture selection in Raw pane
  const captureRawSelection = () => {
    const sel = window.getSelection()?.toString().trim() ?? ''
    if (sel.length >= 2) {
      setSelectionInfo({ text: sel, side: 'raw', start: -1, end: -1 })
    }
  }

  const openRetranslateModal = () => {
    if (!selectionInfo) {
      setErrorMsg(
        'Hãy bôi đen một đoạn văn bản ở cột Raw hoặc cột Bản dịch trước khi bấm "Dịch lại đoạn đang bôi đen".',
      )
      return
    }
    setRetransResult(null)
    setRetransSlot(null)
    setRetransInstruction('')
    setRetransModalOpen(true)
  }

  const handleRunSelectionRetranslate = async () => {
    if (!activeChapterId || !selectionInfo) return
    setRetransLoading(true)
    setErrorMsg(null)
    try {
      const res = await retranslateChapterSelection(activeChapterId, {
        selected_text: selectionInfo.text,
        source_side: selectionInfo.side,
        instruction: retransInstruction,
        temperature: 0.5,
        model_override: retransModelOverride || null,
      })
      setRetransResult(res.retranslated_text)
      setRetransSlot(res.used_slot)
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setRetransLoading(false)
    }
  }

  const handleApplyRetranslatedSelection = () => {
    if (!retransResult || !selectionInfo) return
    if (
      selectionInfo.side === 'translated' &&
      selectionInfo.start >= 0 &&
      selectionInfo.end > selectionInfo.start
    ) {
      const updated =
        draftText.slice(0, selectionInfo.start) +
        retransResult +
        draftText.slice(selectionInfo.end)
      setDraftText(updated)
      notify('Đã thay thế đoạn bôi đen trong bản dịch (sẽ tự lưu sau 1.5s).')
    } else {
      // If selected from Raw, append or copy to clipboard & insert at cursor
      const el = editorRef.current
      if (el) {
        const pos = el.selectionStart ?? draftText.length
        const updated =
          draftText.slice(0, pos) + retransResult + draftText.slice(pos)
        setDraftText(updated)
        notify('Đã chèn đoạn dịch mới vào vị trí con trỏ.')
      }
    }
    setRetransModalOpen(false)
  }

  // Find & Replace across Volume
  const handleFindReplace = async (dryRun: boolean) => {
    if (!selectedVolume || !frFind) return
    setFrBusy(true)
    setErrorMsg(null)
    try {
      // Flush pending edit on current chapter before applying volume-wide replace
      if (!dryRun && activeChapterId !== null && draftText !== savedText) {
        await commitSave(activeChapterId, draftText)
      }
      const res = await findReplaceVolume(selectedVolume.id, {
        find_text: frFind,
        replace_text: frReplace,
        use_regex: frRegex,
        case_sensitive: frCaseSensitive,
        dry_run: dryRun,
      })
      setFrPreview(res)
      if (!dryRun) {
        notify(
          `Đã thay thế ${res.total_matches} vị trí trên ${res.chapters_affected} chương của ${formatVolumeLabel(selectedVolume)}.`,
        )
        if (activeChapterId !== null) {
          await loadChapterData(activeChapterId)
        }
      }
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setFrBusy(false)
    }
  }

  if (!selectedSeries || !selectedVolume) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-6">
        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 text-center space-y-3">
          <CheckCheck className="w-8 h-8 mx-auto text-indigo-500" />
          <h2 className="text-lg font-bold text-slate-900 dark:text-zinc-100">
            Chọn Bộ truyện & Tập để Hiệu đính và Xuất bản
          </h2>
          <p className="text-sm text-slate-500 dark:text-zinc-400">
            Hãy chọn một bộ truyện và tập đã nhập/dịch ở Dashboard để mở không
            gian hiệu đính song song và xuất file `.docx` / `.epub`.
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

  const liveRatio =
    chapterData && chapterData.raw_text.trim().length > 0
      ? draftText.trim().length / chapterData.raw_text.trim().length
      : 0

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Top Toolbar */}
      <header className="shrink-0 border-b border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-5 py-2.5 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Chapter Nav */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-sm text-slate-900 dark:text-zinc-100">
              Hiệu đính
            </span>
            <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 font-medium">
              {formatVolumeLabel(selectedVolume)}
            </span>

            {/* Chapter Switcher */}
            {chapters.length > 0 && (
              <div className="inline-flex items-center gap-1 ml-1">
                <button
                  type="button"
                  disabled={activeIndexInList <= 0}
                  onClick={() =>
                    void handleSwitchChapter(chapters[activeIndexInList - 1].id)
                  }
                  title="Chương trước"
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 disabled:opacity-35 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>

                <select
                  aria-label="Chọn chương"
                  value={activeChapterId ?? ''}
                  onChange={(e) =>
                    void handleSwitchChapter(Number(e.target.value))
                  }
                  className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 font-medium max-w-[260px]"
                >
                  {chapters.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      #{ch.chapter_index} — {ch.title || `Chương ${ch.chapter_index}`}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  disabled={
                    activeIndexInList < 0 ||
                    activeIndexInList >= chapters.length - 1
                  }
                  onClick={() =>
                    void handleSwitchChapter(chapters[activeIndexInList + 1].id)
                  }
                  title="Chương sau"
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 disabled:opacity-35 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {/* Primary Actions + Export/Tools Menu */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Save badge */}
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium ${
                saveState === 'saved'
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                  : saveState === 'saving'
                    ? 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300'
                    : saveState === 'dirty'
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
                      : 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
              }`}
            >
              <Save className="w-3 h-3" />
              {saveState === 'saved'
                ? 'Đã lưu'
                : saveState === 'saving'
                  ? 'Đang lưu...'
                  : saveState === 'dirty'
                    ? 'Tự lưu sau 1.5s...'
                    : 'Lỗi lưu'}
            </span>

            <button
              type="button"
              disabled={!activeChapterId}
              onClick={openRetranslateModal}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer disabled:opacity-45 ${
                selectionInfo
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs'
                  : 'border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              Dịch lại đoạn đang bôi đen
            </button>

            <ActionMenu
              label="Xuất bản & Công cụ"
              icon={<MoreHorizontal className="w-3.5 h-3.5" />}
              items={[
                {
                  label: 'Tìm & Thay thế toàn tập',
                  icon: <Replace className="w-3.5 h-3.5 text-indigo-500" />,
                  disabled: chapters.length === 0,
                  onClick: () => {
                    setFrPreview(null)
                    setFrModalOpen(true)
                  },
                },
                {
                  label: 'Tải .docx (Times New Roman)',
                  icon: <FileText className="w-3.5 h-3.5 text-sky-600" />,
                  dividerBefore: true,
                  href: getVolumeDocxExportUrl(
                    selectedVolume.id,
                    'Times New Roman',
                  ),
                },
                {
                  label: 'Tải .docx (Cambria)',
                  icon: <FileText className="w-3.5 h-3.5 text-sky-600" />,
                  href: getVolumeDocxExportUrl(selectedVolume.id, 'Cambria'),
                },
                {
                  label: 'Tải .epub (Sách điện tử)',
                  icon: <Download className="w-3.5 h-3.5 text-emerald-600" />,
                  href: getVolumeEpubExportUrl(selectedVolume.id),
                },
              ]}
            />
          </div>
        </div>

        {/* Feedback banners inside header */}
        {errorMsg && (
          <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-500/30 text-xs">
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {toastMsg && (
          <div className="px-3 py-2 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/30 text-xs font-medium">
            {toastMsg}
          </div>
        )}
      </header>

      {/* Main 2-Column Side-by-Side Workspace */}
      {chapters.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center space-y-2 text-sm text-slate-500 dark:text-zinc-400">
            <BookOpen className="w-8 h-8 mx-auto text-slate-300 dark:text-zinc-600" />
            <p>
              Tập này chưa có chương nào. Hãy nhập tệp `.epub`/`.txt`/`.docx`
              trước.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-zinc-800">
          {/* LEFT COLUMN: RAW TEXT WITH MASTER GLOSSARY HIGHLIGHTS */}
          <section className="flex flex-col min-h-0 bg-slate-50/70 dark:bg-zinc-950/70">
            <div className="shrink-0 px-4 py-2 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between text-xs bg-white/70 dark:bg-zinc-900/70">
              <div className="font-semibold text-slate-700 dark:text-zinc-200">
                Văn bản gốc (Raw)
                {chapterData && (
                  <span className="ml-2 font-normal text-slate-400">
                    {chapterData.raw_text.length.toLocaleString('vi-VN')} ký tự ·{' '}
                    <span className="text-amber-600 dark:text-amber-400 font-medium">
                      {chapterData.glossary_highlights.length} thuật ngữ Glossary
                    </span>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <span>Rê chuột vào từ tô sáng để xem nghĩa</span>
              </div>
            </div>

            <div
              onMouseUp={captureRawSelection}
              style={{ fontSize: `${fontSize}px` }}
              className="flex-1 overflow-y-auto p-6 leading-relaxed whitespace-pre-wrap text-slate-800 dark:text-zinc-200 font-serif select-text"
            >
              {loadingChapter ? (
                <div className="text-sm text-slate-400 font-sans">
                  Đang tải nội dung chương...
                </div>
              ) : (
                rawSegments.map((seg, idx) =>
                  seg.term ? (
                    <mark
                      key={idx}
                      onMouseEnter={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect()
                        setHoveredTerm({
                          term: seg.term!,
                          x: Math.min(window.innerWidth - 310, Math.max(12, rect.left)),
                          y: rect.bottom + 8,
                        })
                      }}
                      onMouseLeave={() => setHoveredTerm(null)}
                      className="rounded px-0.5 bg-amber-200/60 dark:bg-amber-500/25 text-inherit border-b border-amber-500/70 cursor-help transition-colors hover:bg-amber-300/80 dark:hover:bg-amber-500/40"
                    >
                      {seg.text}
                    </mark>
                  ) : (
                    <span key={idx}>{seg.text}</span>
                  ),
                )
              )}
            </div>
          </section>

          {/* RIGHT COLUMN: TRANSLATION EDITOR WITH 1.5s AUTO-SAVE */}
          <section className="flex flex-col min-h-0 bg-white dark:bg-zinc-900">
            <div className="shrink-0 px-4 py-2 border-b border-slate-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="font-semibold text-slate-700 dark:text-zinc-200">
                Bản dịch tiếng Việt
                <span className="ml-2 font-mono font-normal text-slate-400">
                  {draftText.length.toLocaleString('vi-VN')} ký tự · Ratio{' '}
                  {liveRatio.toFixed(2)}
                </span>
              </div>

              <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-zinc-400">
                <div className="inline-flex rounded-lg bg-slate-100 dark:bg-zinc-950 p-0.5 font-medium">
                  <button
                    type="button"
                    onClick={() => setViewMode('edit')}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md cursor-pointer ${
                      viewMode === 'edit'
                        ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 shadow-xs'
                        : 'text-slate-500 dark:text-zinc-400'
                    }`}
                  >
                    <Edit3 className="w-3 h-3" />
                    Soạn thảo
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('preview')}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md cursor-pointer ${
                      viewMode === 'preview'
                        ? 'bg-white dark:bg-zinc-800 text-indigo-700 dark:text-indigo-300 shadow-xs'
                        : 'text-slate-500 dark:text-zinc-400'
                    }`}
                  >
                    <Eye className="w-3 h-3" />
                    Đọc xem trước
                  </button>
                </div>

                <span>Cỡ chữ:</span>
                <button
                  type="button"
                  onClick={() => setFontSize((s) => Math.max(13, s - 1))}
                  className="px-1.5 py-0.5 rounded border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  A-
                </button>
                <span className="font-mono w-5 text-center">{fontSize}</span>
                <button
                  type="button"
                  onClick={() => setFontSize((s) => Math.min(22, s + 1))}
                  className="px-1.5 py-0.5 rounded border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  A+
                </button>
              </div>
            </div>

            {viewMode === 'preview' ? (
              <div className="flex-1 overflow-y-auto">
                <MarkdownPreview
                  content={draftText}
                  fontSize={fontSize}
                  emptyPlaceholder="Chưa có bản dịch tiếng Việt. Chuyển sang chế độ Soạn thảo để nhập nội dung."
                />
              </div>
            ) : (
              <textarea
                ref={editorRef}
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                onSelect={captureEditorSelection}
                onMouseUp={captureEditorSelection}
                onKeyUp={captureEditorSelection}
                placeholder="Bản dịch tiếng Việt của chương sẽ hiển thị tại đây. Bạn có thể chỉnh sửa trực tiếp — hệ thống tự động lưu sau 1.5 giây ngừng gõ (hoặc Ctrl+S)."
                style={{ fontSize: `${fontSize}px` }}
                className="flex-1 w-full resize-none p-6 leading-relaxed bg-transparent text-slate-900 dark:text-zinc-100 focus:outline-none font-serif"
              />
            )}
          </section>
        </div>
      )}

      {/* Floating Glossary Tooltip */}
      {hoveredTerm && (
        <div
          style={{ left: hoveredTerm.x, top: hoveredTerm.y }}
          className="fixed z-50 w-72 pointer-events-none rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl p-3 text-xs space-y-1"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-sm text-slate-900 dark:text-zinc-100">
              {hoveredTerm.term.source_term}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 text-[10px] font-semibold">
              {hoveredTerm.term.term_type}
            </span>
          </div>
          <div className="text-emerald-700 dark:text-emerald-400 font-semibold">
            Việt: {hoveredTerm.term.vi_term || '(Chưa dịch)'}
          </div>
          {hoveredTerm.term.han_viet && (
            <div className="text-slate-600 dark:text-zinc-300">
              Hán-Việt: <strong>{hoveredTerm.term.han_viet}</strong>
            </div>
          )}
          {hoveredTerm.term.reading && (
            <div className="text-slate-500 dark:text-zinc-400 font-mono text-[11px]">
              Phiên âm: {hoveredTerm.term.reading}
            </div>
          )}
          {hoveredTerm.term.english_meaning && (
            <div className="text-slate-400 text-[11px]">
              EN: {hoveredTerm.term.english_meaning}
            </div>
          )}
        </div>
      )}

      {/* Find & Replace Volume Modal */}
      {frModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Replace className="w-5 h-5 text-indigo-500" />
                <div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">
                    Tìm & Thay thế — {formatVolumeLabel(selectedVolume)}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-zinc-400">
                    Áp dụng trên toàn bộ bản dịch của tập, hỗ trợ biểu thức
                    chính quy (Regex).
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setFrModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Tìm chuỗi / Regex *
                  </label>
                  <input
                    type="text"
                    value={frFind}
                    onChange={(e) => setFrFind(e.target.value)}
                    placeholder="VD: Sylphy hoặc \bNgươi\b"
                    className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Thay thế bằng
                  </label>
                  <input
                    type="text"
                    value={frReplace}
                    onChange={(e) => setFrReplace(e.target.value)}
                    placeholder="VD: Sylphiette hoặc Cậu"
                    className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 font-mono"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4 text-xs">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={frRegex}
                    onChange={(e) => setFrRegex(e.target.checked)}
                    className="rounded border-slate-300 text-indigo-600"
                  />
                  <span>Dùng Regex (biểu thức chính quy)</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={frCaseSensitive}
                    onChange={(e) => setFrCaseSensitive(e.target.checked)}
                    className="rounded border-slate-300 text-indigo-600"
                  />
                  <span>Phân biệt chữ HOA / thường</span>
                </label>
              </div>

              {frPreview && (
                <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950/60 p-4 space-y-2 text-xs">
                  <div className="font-semibold text-slate-800 dark:text-zinc-200">
                    {frPreview.dry_run ? 'Kết quả xem trước:' : 'Đã áp dụng:'}{' '}
                    <span className="text-indigo-600 dark:text-indigo-400">
                      {frPreview.total_matches} vị trí
                    </span>{' '}
                    trên {frPreview.chapters_affected} chương.
                  </div>
                  {frPreview.affected_chapters.length > 0 && (
                    <div className="max-h-40 overflow-y-auto divide-y divide-slate-200 dark:divide-zinc-800">
                      {frPreview.affected_chapters.map((item) => (
                        <div key={item.chapter_id} className="py-1.5 space-y-0.5">
                          <div className="font-medium text-slate-700 dark:text-zinc-300">
                            Chương {item.chapter_index}: {item.title} (
                            <strong>{item.matches}</strong> khớp)
                          </div>
                          <div className="text-slate-500 dark:text-zinc-400 truncate">
                            ...{item.sample_snippet}...
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-200 dark:border-zinc-800 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setFrModalOpen(false)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                Đóng
              </button>
              <button
                type="button"
                disabled={frBusy || !frFind}
                onClick={() => void handleFindReplace(true)}
                className="px-4 py-2 rounded-xl text-xs font-semibold border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 disabled:opacity-50 cursor-pointer"
              >
                Xem trước
              </button>
              <button
                type="button"
                disabled={frBusy || !frFind}
                onClick={() => void handleFindReplace(false)}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white cursor-pointer"
              >
                {frBusy ? 'Đang xử lý...' : 'Thay thế toàn tập'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Retranslate Selection Modal */}
      {retransModalOpen && selectionInfo && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-indigo-500" />
                <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">
                  Dịch lại đoạn đang bôi đen
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setRetransModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4 text-xs">
              <div>
                <div className="font-semibold text-slate-500 mb-1">
                  Đoạn đang bôi đen ({selectionInfo.side === 'raw' ? 'từ cột Raw' : 'từ cột Bản dịch'}):
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 max-h-32 overflow-y-auto whitespace-pre-wrap text-sm">
                  {selectionInfo.text}
                </div>
              </div>

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                  <label className="block font-medium text-slate-600 dark:text-zinc-400">
                    Ghi chú cho AI (tùy chọn)
                  </label>
                  <TaskModelSelector
                    taskKey="proofread_retranslate"
                    value={retransModelOverride}
                    onChange={setRetransModelOverride}
                    compact
                  />
                </div>
                <input
                  type="text"
                  value={retransInstruction}
                  onChange={(e) => setRetransInstruction(e.target.value)}
                  placeholder="VD: Đổi xưng hô sang Anh-Em, văn phong trang trọng hơn..."
                  className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                />
              </div>

              {retransResult !== null && (
                <div>
                  <div className="flex items-center justify-between font-semibold text-emerald-700 dark:text-emerald-400 mb-1">
                    <span>Đoạn dịch mới đề xuất:</span>
                    {retransSlot && (
                      <span className="font-mono text-[10px] text-slate-400">
                        via {retransSlot}
                      </span>
                    )}
                  </div>
                  <textarea
                    rows={5}
                    value={retransResult}
                    onChange={(e) => setRetransResult(e.target.value)}
                    className="w-full p-3 rounded-xl bg-emerald-50/40 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 text-sm"
                  />
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-200 dark:border-zinc-800 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setRetransModalOpen(false)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                Đóng
              </button>
              <button
                type="button"
                disabled={retransLoading}
                onClick={() => void handleRunSelectionRetranslate()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {retransLoading ? 'Đang dịch lại...' : 'Dịch lại bằng Gemini'}
              </button>
              {retransResult !== null && (
                <button
                  type="button"
                  onClick={handleApplyRetranslatedSelection}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
                >
                  Thay thế vào bản dịch
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
