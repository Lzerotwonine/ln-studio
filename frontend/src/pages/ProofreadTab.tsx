import {
  Bold,
  BookOpen,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code2,
  Columns2,
  Download,
  Edit3,
  Eye,
  FileText,
  Italic,
  MoreHorizontal,
  Quote,
  Replace,
  Save,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionMenu } from '../components/ActionMenu'
import { MarkdownPreview } from '../components/MarkdownPreview'
import { SafeReaderView } from '../components/SafeReaderView'
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
type LayoutMode = 'split' | 'raw' | 'translated'
type RawViewMode = 'reader' | 'markdown'
type QuoteTransformKind =
  | 'double_to_curly'
  | 'curly_to_double'
  | 'single_to_curly'
  | 'curly_to_single'
  | 'jp_to_curly'

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findAllMatchIndices(
  text: string,
  query: string,
  caseSensitive: boolean,
): number[] {
  if (!text || !query) return []
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const indices: number[] = []
  let pos = 0
  while (pos <= hay.length - needle.length) {
    const found = hay.indexOf(needle, pos)
    if (found === -1) break
    indices.push(found)
    pos = found + Math.max(1, needle.length)
  }
  return indices
}

function transformQuotes(text: string, kind: QuoteTransformKind): string {
  switch (kind) {
    case 'double_to_curly': {
      let open = true
      return text.replace(/"/g, () => {
        const out = open ? '“' : '”'
        open = !open
        return out
      })
    }
    case 'curly_to_double':
      return text.replace(/[“”]/g, '"')
    case 'single_to_curly': {
      // Preserve intra-word English contractions/apostrophes (e.g. don't) while pairing quotes
      let open = true
      return text.replace(/(?<![A-Za-z])'(?![A-Za-z])|(?<=^|[\s(\[{“—-])'|'(?=$|[\s.,!?;:)\]}”])/g, () => {
        const out = open ? '‘' : '’'
        open = !open
        return out
      })
    }
    case 'curly_to_single':
      return text.replace(/[‘’]/g, "'")
    case 'jp_to_curly':
      return text.replace(/「/g, '“').replace(/」/g, '”')
  }
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

function scrollChildIntoLocalContainer(
  container: HTMLElement | null,
  child: HTMLElement | null,
) {
  if (!container || !child) return
  const cRect = container.getBoundingClientRect()
  const elRect = child.getBoundingClientRect()
  const targetTop =
    container.scrollTop + (elRect.top - cRect.top) - container.clientHeight / 3
  container.scrollTo({
    top: Math.max(0, targetTop),
    behavior: 'smooth',
  })
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

  // Layout & View modes
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('split')
  const [rawViewMode, setRawViewMode] = useState<RawViewMode>('reader')
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit')
  const [fontSize, setFontSize] = useState<number>(15)

  // Editor & Auto-save state
  const [draftText, setDraftText] = useState('')
  const [savedText, setSavedText] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [retransModelOverride, setRetransModelOverride] = useState<string>('')

  // In-chapter Search (Left: Bản gốc)
  const [rawSearchOpen, setRawSearchOpen] = useState(false)
  const [rawSearchQuery, setRawSearchQuery] = useState('')
  const [rawSearchCase, setRawSearchCase] = useState(false)
  const [rawSearchIdx, setRawSearchIdx] = useState(0)
  const [rawMatchCount, setRawMatchCount] = useState(0)
  const rawScrollRef = useRef<HTMLDivElement | null>(null)

  // In-chapter Find & Replace (Right: Bản dịch tiếng Việt)
  const [trSearchOpen, setTrSearchOpen] = useState(false)
  const [trFind, setTrFind] = useState('')
  const [trReplace, setTrReplace] = useState('')
  const [trCase, setTrCase] = useState(false)
  const [trSearchIdx, setTrSearchIdx] = useState(0)
  const previewScrollRef = useRef<HTMLDivElement | null>(null)

  // Quote menu popover
  const [quoteMenuOpen, setQuoteMenuOpen] = useState(false)
  const quoteMenuRef = useRef<HTMLDivElement | null>(null)

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

  // Find & Replace Volume Modal state
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

  // Close quote menu on outside click
  useEffect(() => {
    if (!quoteMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (
        quoteMenuRef.current &&
        !quoteMenuRef.current.contains(e.target as Node)
      ) {
        setQuoteMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [quoteMenuOpen])

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

  // Sync actual rendered match count in left Raw pane and scroll active match locally
  useEffect(() => {
    const container = rawScrollRef.current
    if (!container || !rawSearchQuery) {
      setRawMatchCount(0)
      return
    }
    const matches = container.querySelectorAll<HTMLElement>('[data-raw-search-match]')
    setRawMatchCount(matches.length)
    if (matches.length > 0) {
      const clamped = ((rawSearchIdx % matches.length) + matches.length) % matches.length
      scrollChildIntoLocalContainer(container, matches[clamped])
    }
  }, [rawSearchQuery, rawSearchCase, rawSearchIdx, rawViewMode, chapterData])

  // Translation in-chapter search match positions
  const trMatches = useMemo(
    () => findAllMatchIndices(draftText, trFind, trCase),
    [draftText, trFind, trCase],
  )

  const jumpToTrMatch = useCallback(
    (nextIdx: number) => {
      if (trMatches.length === 0) return
      const clamped =
        ((nextIdx % trMatches.length) + trMatches.length) % trMatches.length
      setTrSearchIdx(clamped)
      if (viewMode === 'edit' && editorRef.current) {
        const start = trMatches[clamped]
        const end = start + trFind.length
        editorRef.current.focus()
        editorRef.current.setSelectionRange(start, end)
      } else if (viewMode === 'preview' && previewScrollRef.current) {
        const els = previewScrollRef.current.querySelectorAll<HTMLElement>(
          '[data-search-match]',
        )
        if (els[clamped]) {
          scrollChildIntoLocalContainer(previewScrollRef.current, els[clamped])
        }
      }
    },
    [trMatches, trFind.length, viewMode],
  )

  const handleTrReplaceOne = () => {
    if (!trFind || trMatches.length === 0) return
    const idx =
      ((trSearchIdx % trMatches.length) + trMatches.length) % trMatches.length
    const pos = trMatches[idx]
    const updated =
      draftText.slice(0, pos) + trReplace + draftText.slice(pos + trFind.length)
    setDraftText(updated)
    notify('Đã thay 1 vị trí trong chương.')
  }

  const handleTrReplaceAll = () => {
    if (!trFind || trMatches.length === 0) return
    const re = new RegExp(escapeRegExp(trFind), trCase ? 'g' : 'gi')
    const count = trMatches.length
    setDraftText((prev) => prev.replace(re, () => trReplace))
    notify(`Đã thay tất cả ${count} vị trí trong chương hiện tại.`)
  }

  // Wrap or unwrap selection with ** (bold) or * (italic)
  const applyMarkdownWrap = useCallback(
    (marker: '**' | '*') => {
      const el = editorRef.current
      if (!el || viewMode !== 'edit') return
      const start = el.selectionStart
      const end = el.selectionEnd
      const selected = draftText.slice(start, end)
      const mLen = marker.length

      let nextText: string
      let nextStart: number
      let nextEnd: number

      if (
        selected.length >= mLen * 2 &&
        selected.startsWith(marker) &&
        selected.endsWith(marker)
      ) {
        // Unwrap
        const inner = selected.slice(mLen, -mLen)
        nextText = draftText.slice(0, start) + inner + draftText.slice(end)
        nextStart = start
        nextEnd = start + inner.length
      } else if (
        start >= mLen &&
        draftText.slice(start - mLen, start) === marker &&
        draftText.slice(end, end + mLen) === marker
      ) {
        // Unwrap surrounding markers
        nextText =
          draftText.slice(0, start - mLen) +
          selected +
          draftText.slice(end + mLen)
        nextStart = start - mLen
        nextEnd = end - mLen
      } else if (selected.length > 0) {
        // Wrap selection
        nextText =
          draftText.slice(0, start) +
          marker +
          selected +
          marker +
          draftText.slice(end)
        nextStart = start + mLen
        nextEnd = end + mLen
      } else {
        // Insert empty markers and place cursor inside
        nextText =
          draftText.slice(0, start) + marker + marker + draftText.slice(end)
        nextStart = start + mLen
        nextEnd = start + mLen
      }

      setDraftText(nextText)
      window.requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(nextStart, nextEnd)
      })
    },
    [draftText, viewMode],
  )

  const handleApplyQuoteTransform = (kind: QuoteTransformKind, label: string) => {
    setQuoteMenuOpen(false)
    const el = editorRef.current
    if (viewMode === 'edit' && el && el.selectionEnd > el.selectionStart) {
      const start = el.selectionStart
      const end = el.selectionEnd
      const chunk = draftText.slice(start, end)
      const converted = transformQuotes(chunk, kind)
      if (converted === chunk) {
        notify('Không tìm thấy dấu ngoặc phù hợp trong đoạn bôi đen.')
        return
      }
      setDraftText(draftText.slice(0, start) + converted + draftText.slice(end))
      notify(`Đã áp dụng "${label}" cho đoạn đang bôi đen.`)
      window.requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(start, start + converted.length)
      })
    } else {
      const converted = transformQuotes(draftText, kind)
      if (converted === draftText) {
        notify('Không tìm thấy dấu ngoặc phù hợp trong toàn chương.')
        return
      }
      setDraftText(converted)
      notify(`Đã áp dụng "${label}" cho toàn bộ chương hiện tại.`)
    }
  }

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase()
      if (k === 'b') {
        e.preventDefault()
        applyMarkdownWrap('**')
      } else if (k === 'i') {
        e.preventDefault()
        applyMarkdownWrap('*')
      } else if (k === 'f') {
        e.preventDefault()
        setTrSearchOpen(true)
      }
    }
  }

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
        'Hãy bôi đen một đoạn văn bản ở cột Bản gốc hoặc cột Bản dịch trước khi bấm "Dịch lại đoạn đang bôi đen".',
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

  const handleHoverTerm = useCallback(
    (term: GlossaryHighlightItem, rect: DOMRect) => {
      setHoveredTerm({
        term,
        x: Math.min(window.innerWidth - 310, Math.max(12, rect.left)),
        y: rect.bottom + 8,
      })
    },
    [],
  )

  const handleLeaveTerm = useCallback(() => {
    setHoveredTerm(null)
  }, [])

  // Render Raw Markdown mode with both Glossary highlights + Search highlights
  const renderRawMarkdownWithSearch = () => {
    const counter = { current: 0 }
    const renderSearchPart = (text: string, prefix: string) => {
      if (!rawSearchQuery) return text
      const re = new RegExp(
        `(${escapeRegExp(rawSearchQuery)})`,
        rawSearchCase ? 'g' : 'gi',
      )
      const parts = text.split(re)
      if (parts.length === 1) return text
      return parts.map((p, i) => {
        if (!p) return null
        const matched = rawSearchCase
          ? p === rawSearchQuery
          : p.toLowerCase() === rawSearchQuery.toLowerCase()
        if (!matched) return <React.Fragment key={`${prefix}-${i}`}>{p}</React.Fragment>
        const mIdx = counter.current++
        const active =
          rawMatchCount > 0 &&
          mIdx === ((rawSearchIdx % rawMatchCount) + rawMatchCount) % rawMatchCount
        return (
          <mark
            key={`${prefix}-m${i}`}
            data-raw-search-match={mIdx}
            className={`rounded px-0.5 ${
              active
                ? 'bg-orange-400 text-slate-950 ring-2 ring-orange-500'
                : 'bg-yellow-200 dark:bg-yellow-500/40 text-inherit'
            }`}
          >
            {p}
          </mark>
        )
      })
    }

    return rawSegments.map((seg, idx) =>
      seg.term ? (
        <mark
          key={idx}
          onMouseEnter={(e) =>
            handleHoverTerm(seg.term!, e.currentTarget.getBoundingClientRect())
          }
          onMouseLeave={handleLeaveTerm}
          className="rounded px-0.5 bg-amber-200/60 dark:bg-amber-500/25 text-inherit border-b border-amber-500/70 cursor-help transition-colors hover:bg-amber-300/80 dark:hover:bg-amber-500/40"
        >
          {renderSearchPart(seg.text, `t${idx}`)}
        </mark>
      ) : (
        <span key={idx}>{renderSearchPart(seg.text, `s${idx}`)}</span>
      ),
    )
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

  const showRawPane = layoutMode === 'split' || layoutMode === 'raw'
  const showTranslatedPane =
    layoutMode === 'split' || layoutMode === 'translated'

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Top Toolbar */}
      <header className="shrink-0 border-b border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-5 py-2.5 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Chapter Nav + Layout Switcher */}
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
                  className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 font-medium max-w-[240px]"
                >
                  {chapters.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      #{ch.chapter_index} —{' '}
                      {ch.title || `Chương ${ch.chapter_index}`}
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

            {/* Layout Mode Switcher: Song song | Chỉ Bản gốc | Chỉ Bản dịch */}
            <div className="inline-flex items-center rounded-lg bg-slate-100 dark:bg-zinc-800 p-0.5 ml-1">
              <button
                type="button"
                onClick={() => setLayoutMode('split')}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md font-medium cursor-pointer ${
                  layoutMode === 'split'
                    ? 'bg-white dark:bg-zinc-900 text-indigo-700 dark:text-indigo-300 shadow-xs'
                    : 'text-slate-600 dark:text-zinc-400'
                }`}
              >
                <Columns2 className="w-3.5 h-3.5" />
                Song song
              </button>
              <button
                type="button"
                onClick={() => setLayoutMode('raw')}
                className={`px-2.5 py-1 rounded-md font-medium cursor-pointer ${
                  layoutMode === 'raw'
                    ? 'bg-white dark:bg-zinc-900 text-indigo-700 dark:text-indigo-300 shadow-xs'
                    : 'text-slate-600 dark:text-zinc-400'
                }`}
              >
                Chỉ Bản gốc
              </button>
              <button
                type="button"
                onClick={() => setLayoutMode('translated')}
                className={`px-2.5 py-1 rounded-md font-medium cursor-pointer ${
                  layoutMode === 'translated'
                    ? 'bg-white dark:bg-zinc-900 text-indigo-700 dark:text-indigo-300 shadow-xs'
                    : 'text-slate-600 dark:text-zinc-400'
                }`}
              >
                Chỉ Bản dịch
              </button>
            </div>
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

      {/* Main Workspace */}
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
        <div
          className={`flex-1 min-h-0 grid ${
            layoutMode === 'split'
              ? 'grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x'
              : 'grid-cols-1'
          } divide-slate-200 dark:divide-zinc-800`}
        >
          {/* LEFT COLUMN: BẢN GỐC */}
          {showRawPane && (
            <section className="flex flex-col min-h-0 bg-slate-50/70 dark:bg-zinc-950/70">
              <div className="shrink-0 px-4 py-2 border-b border-slate-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-2 text-xs bg-white/80 dark:bg-zinc-900/80">
                <div className="font-semibold text-slate-700 dark:text-zinc-200">
                  Bản gốc
                  {chapterData && (
                    <span className="ml-2 font-normal text-slate-400">
                      {chapterData.raw_text.length.toLocaleString('vi-VN')} ký tự ·{' '}
                      <span className="text-amber-600 dark:text-amber-400 font-medium">
                        {chapterData.glossary_highlights.length} thuật ngữ
                      </span>
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setRawSearchOpen((o) => !o)}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border cursor-pointer ${
                      rawSearchOpen
                        ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 font-semibold'
                        : 'border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <Search className="w-3 h-3" />
                    Tìm
                  </button>

                  {/* Reader vs Markdown switcher */}
                  <div className="inline-flex rounded-lg bg-slate-100 dark:bg-zinc-950 p-0.5 font-medium">
                    <button
                      type="button"
                      onClick={() => setRawViewMode('reader')}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md cursor-pointer ${
                        rawViewMode === 'reader'
                          ? 'bg-white dark:bg-zinc-800 text-indigo-700 dark:text-indigo-300 shadow-xs'
                          : 'text-slate-500 dark:text-zinc-400'
                      }`}
                    >
                      <BookOpen className="w-3 h-3" />
                      Bản đọc
                    </button>
                    <button
                      type="button"
                      onClick={() => setRawViewMode('markdown')}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md cursor-pointer ${
                        rawViewMode === 'markdown'
                          ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 shadow-xs'
                          : 'text-slate-500 dark:text-zinc-400'
                      }`}
                    >
                      <Code2 className="w-3 h-3" />
                      Markdown
                    </button>
                  </div>
                </div>
              </div>

              {/* Inline Search Bar for Bản gốc */}
              {rawSearchOpen && (
                <div className="shrink-0 px-4 py-2 border-b border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-wrap items-center gap-2 text-xs">
                  <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <input
                    type="text"
                    autoFocus
                    value={rawSearchQuery}
                    onChange={(e) => {
                      setRawSearchQuery(e.target.value)
                      setRawSearchIdx(0)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && rawMatchCount > 0) {
                        e.preventDefault()
                        setRawSearchIdx((i) => (e.shiftKey ? i - 1 : i + 1))
                      } else if (e.key === 'Escape') {
                        setRawSearchOpen(false)
                      }
                    }}
                    placeholder="Tìm trong Bản gốc..."
                    className="flex-1 min-w-[140px] px-2.5 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-xs"
                  />
                  <label className="inline-flex items-center gap-1 text-[11px] text-slate-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rawSearchCase}
                      onChange={(e) => setRawSearchCase(e.target.checked)}
                      className="rounded border-slate-300 text-indigo-600"
                    />
                    Aa
                  </label>
                  <span className="font-mono text-[11px] text-slate-500 min-w-[46px] text-center">
                    {rawMatchCount > 0
                      ? `${(((rawSearchIdx % rawMatchCount) + rawMatchCount) % rawMatchCount) + 1}/${rawMatchCount}`
                      : '0/0'}
                  </span>
                  <button
                    type="button"
                    disabled={rawMatchCount === 0}
                    onClick={() => setRawSearchIdx((i) => i - 1)}
                    title="Kết quả trước"
                    className="p-1 rounded border border-slate-200 dark:border-zinc-700 disabled:opacity-35 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    <ChevronUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={rawMatchCount === 0}
                    onClick={() => setRawSearchIdx((i) => i + 1)}
                    title="Kết quả tiếp theo"
                    className="p-1 rounded border border-slate-200 dark:border-zinc-700 disabled:opacity-35 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRawSearchQuery('')
                      setRawSearchOpen(false)
                    }}
                    className="p-1 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              <div
                ref={rawScrollRef}
                onMouseUp={captureRawSelection}
                className="flex-1 overflow-y-auto"
              >
                {loadingChapter ? (
                  <div className="p-6 text-sm text-slate-400 font-sans">
                    Đang tải nội dung chương...
                  </div>
                ) : chapterData && rawViewMode === 'reader' ? (
                  <SafeReaderView
                    sourceHtml={chapterData.source_html}
                    rawText={chapterData.raw_text}
                    volumeId={selectedVolume.id}
                    fontSize={fontSize}
                    glossaryHighlights={chapterData.glossary_highlights}
                    searchQuery={rawSearchQuery}
                    searchCaseSensitive={rawSearchCase}
                    activeSearchIndex={
                      rawMatchCount > 0
                        ? ((rawSearchIdx % rawMatchCount) + rawMatchCount) %
                          rawMatchCount
                        : -1
                    }
                    onHoverTerm={handleHoverTerm}
                    onLeaveTerm={handleLeaveTerm}
                  />
                ) : (
                  <div
                    style={{ fontSize: `${fontSize}px` }}
                    className="p-6 leading-relaxed whitespace-pre-wrap text-slate-800 dark:text-zinc-200 font-serif select-text"
                  >
                    {renderRawMarkdownWithSearch()}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* RIGHT COLUMN: BẢN DỊCH TIẾNG VIỆT */}
          {showTranslatedPane && (
            <section className="flex flex-col min-h-0 bg-white dark:bg-zinc-900">
              <div className="shrink-0 px-4 py-2 border-b border-slate-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="font-semibold text-slate-700 dark:text-zinc-200">
                  Bản dịch tiếng Việt
                  <span className="ml-2 font-mono font-normal text-slate-400">
                    {draftText.length.toLocaleString('vi-VN')} ký tự · Ratio{' '}
                    {liveRatio.toFixed(2)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-zinc-400">
                  {/* Find in chapter */}
                  <button
                    type="button"
                    onClick={() => setTrSearchOpen((o) => !o)}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border cursor-pointer ${
                      trSearchOpen
                        ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 font-semibold'
                        : 'border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <Search className="w-3 h-3" />
                    Tìm
                  </button>

                  {/* Bold / Italic */}
                  {viewMode === 'edit' && (
                    <div className="inline-flex items-center rounded-lg border border-slate-200 dark:border-zinc-700 overflow-hidden">
                      <button
                        type="button"
                        title="In đậm (**...**) — Ctrl+B"
                        onClick={() => applyMarkdownWrap('**')}
                        className="px-2 py-1 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-200 cursor-pointer"
                      >
                        <Bold className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        title="In nghiêng (*...*) — Ctrl+I"
                        onClick={() => applyMarkdownWrap('*')}
                        className="px-2 py-1 border-l border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-200 cursor-pointer"
                      >
                        <Italic className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}

                  {/* Quote Converter Dropdown */}
                  <div ref={quoteMenuRef} className="relative">
                    <button
                      type="button"
                      onClick={() => setQuoteMenuOpen((o) => !o)}
                      title="Đổi kiểu dấu ngoặc (áp dụng cho đoạn bôi đen hoặc toàn chương)"
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                    >
                      <Quote className="w-3 h-3" />
                      <span>Dấu ngoặc</span>
                    </button>
                    {quoteMenuOpen && (
                      <div className="absolute right-0 mt-1.5 w-56 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl py-1.5 z-40 text-xs">
                        <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                          Đổi kiểu dấu ngoặc (chọn / toàn chương)
                        </div>
                        {(
                          [
                            ['double_to_curly', '"" → “” (Ngoặc kép cong)'],
                            ['curly_to_double', '“” → "" (Ngoặc kép thẳng)'],
                            ['single_to_curly', "'' → ‘’ (Ngoặc đơn cong)"],
                            ['curly_to_single', "‘’ → '' (Ngoặc đơn thẳng)"],
                            ['jp_to_curly', '「」 → “” (Ngoặc Nhật sang cong)'],
                          ] as Array<[QuoteTransformKind, string]>
                        ).map(([kind, label]) => (
                          <button
                            key={kind}
                            type="button"
                            onClick={() =>
                              handleApplyQuoteTransform(kind, label)
                            }
                            className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-zinc-200 hover:bg-indigo-50 dark:hover:bg-indigo-500/15 cursor-pointer"
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Soạn thảo vs Xem trước */}
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
                      Xem trước
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setFontSize((s) => Math.max(13, s - 1))}
                    className="px-1.5 py-0.5 rounded border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    A-
                  </button>
                  <span className="font-mono w-4 text-center">{fontSize}</span>
                  <button
                    type="button"
                    onClick={() => setFontSize((s) => Math.min(22, s + 1))}
                    className="px-1.5 py-0.5 rounded border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    A+
                  </button>
                </div>
              </div>

              {/* Inline Find & Replace bar for Bản dịch (current chapter) */}
              {trSearchOpen && (
                <div className="shrink-0 px-4 py-2 border-b border-slate-200 dark:border-zinc-800 bg-slate-50/80 dark:bg-zinc-950/60 flex flex-wrap items-center gap-2 text-xs">
                  <input
                    type="text"
                    autoFocus
                    value={trFind}
                    onChange={(e) => {
                      setTrFind(e.target.value)
                      setTrSearchIdx(0)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && trMatches.length > 0) {
                        e.preventDefault()
                        jumpToTrMatch(
                          e.shiftKey ? trSearchIdx - 1 : trSearchIdx + 1,
                        )
                      } else if (e.key === 'Escape') {
                        setTrSearchOpen(false)
                      }
                    }}
                    placeholder="Tìm trong Bản dịch..."
                    className="flex-1 min-w-[120px] px-2.5 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs"
                  />
                  <input
                    type="text"
                    value={trReplace}
                    onChange={(e) => setTrReplace(e.target.value)}
                    placeholder="Thay thế bằng..."
                    className="flex-1 min-w-[110px] px-2.5 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs"
                  />
                  <label className="inline-flex items-center gap-1 text-[11px] text-slate-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={trCase}
                      onChange={(e) => setTrCase(e.target.checked)}
                      className="rounded border-slate-300 text-indigo-600"
                    />
                    Aa
                  </label>
                  <span className="font-mono text-[11px] text-slate-500 min-w-[42px] text-center">
                    {trMatches.length > 0
                      ? `${(((trSearchIdx % trMatches.length) + trMatches.length) % trMatches.length) + 1}/${trMatches.length}`
                      : '0/0'}
                  </span>
                  <button
                    type="button"
                    disabled={trMatches.length === 0}
                    onClick={() => jumpToTrMatch(trSearchIdx - 1)}
                    title="Kết quả trước"
                    className="p-1 rounded border border-slate-200 dark:border-zinc-700 disabled:opacity-35 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    <ChevronUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={trMatches.length === 0}
                    onClick={() => jumpToTrMatch(trSearchIdx + 1)}
                    title="Kết quả tiếp theo"
                    className="p-1 rounded border border-slate-200 dark:border-zinc-700 disabled:opacity-35 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={trMatches.length === 0}
                    onClick={handleTrReplaceOne}
                    className="px-2 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-35 text-[11px] font-medium cursor-pointer"
                  >
                    Thay 1
                  </button>
                  <button
                    type="button"
                    disabled={trMatches.length === 0}
                    onClick={handleTrReplaceAll}
                    className="px-2 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-35 text-white text-[11px] font-medium cursor-pointer"
                  >
                    Thay hết
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTrFind('')
                      setTrSearchOpen(false)
                    }}
                    className="p-1 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {viewMode === 'preview' ? (
                <div ref={previewScrollRef} className="flex-1 overflow-y-auto">
                  <MarkdownPreview
                    content={draftText}
                    volumeId={selectedVolume.id}
                    fontSize={fontSize}
                    searchQuery={trFind}
                    searchCaseSensitive={trCase}
                    activeSearchIndex={
                      trMatches.length > 0
                        ? ((trSearchIdx % trMatches.length) + trMatches.length) %
                          trMatches.length
                        : -1
                    }
                    emptyPlaceholder="Chưa có bản dịch tiếng Việt. Chuyển sang chế độ Soạn thảo để nhập nội dung."
                  />
                </div>
              ) : (
                <textarea
                  ref={editorRef}
                  value={draftText}
                  onChange={(e) => setDraftText(e.target.value)}
                  onKeyDown={handleEditorKeyDown}
                  onSelect={captureEditorSelection}
                  onMouseUp={captureEditorSelection}
                  onKeyUp={captureEditorSelection}
                  placeholder="Bản dịch tiếng Việt của chương sẽ hiển thị tại đây. Hỗ trợ Ctrl+B (in đậm), Ctrl+I (in nghiêng), Ctrl+F (tìm trong chương) và tự lưu sau 1.5s ngừng gõ."
                  style={{ fontSize: `${fontSize}px` }}
                  className="flex-1 w-full resize-none p-6 leading-relaxed bg-transparent text-slate-900 dark:text-zinc-100 focus:outline-none font-serif"
                />
              )}
            </section>
          )}
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
                  Đoạn đang bôi đen (
                  {selectionInfo.side === 'raw'
                    ? 'từ cột Bản gốc'
                    : 'từ cột Bản dịch'}
                  ):
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
