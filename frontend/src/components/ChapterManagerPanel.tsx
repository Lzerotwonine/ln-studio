import {
  Eye,
  FilePlus2,
  FileText,
  Merge,
  Scissors,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createManualChapter,
  deleteSingleChapter,
  extractErrorMessage,
  fetchChapterDetail,
  fetchVolumeChapters,
  mergeChapterNext,
  splitChapterAtOffset,
  updateChapter,
} from '../lib/api'
import type {
  ChapterDetail,
  ChapterStatus,
  ChapterSummary,
  Volume,
} from '../types'
import { CHAPTER_STATUS_META, formatVolumeLabel } from '../types'

interface ChapterManagerPanelProps {
  volume: Volume
  refreshSignal?: number
  onOpenImportModal: () => void
  onNotify: (msg: string) => void
  onError: (msg: string) => void
}

export function ChapterManagerPanel({
  volume,
  refreshSignal = 0,
  onOpenImportModal,
  onNotify,
  onError,
}: ChapterManagerPanelProps) {
  const [chapters, setChapters] = useState<ChapterSummary[]>([])
  const [loading, setLoading] = useState(false)

  // Paste new chapter modal
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteTitle, setPasteTitle] = useState('')
  const [pasteRaw, setPasteRaw] = useState('')
  const [savingPaste, setSavingPaste] = useState(false)

  // Preview & Split modal
  const [inspectChapter, setInspectChapter] = useState<ChapterDetail | null>(
    null,
  )
  const [loadingInspect, setLoadingInspect] = useState(false)
  const [splitOffset, setSplitOffset] = useState<number>(0)
  const [splitSecondTitle, setSplitSecondTitle] = useState('')
  const [splitting, setSplitting] = useState(false)
  const splitTextareaRef = useRef<HTMLTextAreaElement | null>(null)

  const loadChapters = useCallback(async () => {
    setLoading(true)
    try {
      const list = await fetchVolumeChapters(volume.id)
      setChapters(list)
    } catch (err) {
      onError(extractErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [volume.id, onError])

  useEffect(() => {
    setChapters([])
    void loadChapters()
  }, [loadChapters, refreshSignal])

  const handleRename = async (ch: ChapterSummary, nextTitle: string) => {
    const cleaned = nextTitle.trim()
    if (!cleaned || cleaned === ch.title) return
    try {
      const updated = await updateChapter(ch.id, { title: cleaned })
      setChapters((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item)),
      )
      onNotify(`Đã đổi tên Chương ${ch.chapter_index}.`)
    } catch (err) {
      onError(extractErrorMessage(err))
    }
  }

  const handlePasteSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pasteRaw.trim()) return
    setSavingPaste(true)
    try {
      const created = await createManualChapter(volume.id, {
        title: pasteTitle.trim(),
        raw_text: pasteRaw,
      })
      setPasteOpen(false)
      setPasteTitle('')
      setPasteRaw('')
      onNotify(`Đã thêm Chương ${created.chapter_index}: ${created.title}.`)
      await loadChapters()
    } catch (err) {
      onError(extractErrorMessage(err))
    } finally {
      setSavingPaste(false)
    }
  }

  const handleDeleteOne = async (ch: ChapterSummary) => {
    if (
      !window.confirm(
        `Xóa Chương ${ch.chapter_index}: "${ch.title}"? Các chương sau sẽ tự động đánh lại số thứ tự.`,
      )
    ) {
      return
    }
    try {
      await deleteSingleChapter(ch.id)
      onNotify(`Đã xóa Chương ${ch.chapter_index}.`)
      await loadChapters()
    } catch (err) {
      onError(extractErrorMessage(err))
    }
  }

  const handleMergeNext = async (ch: ChapterSummary) => {
    if (
      !window.confirm(
        `Gộp Chương ${ch.chapter_index} và Chương ${ch.chapter_index + 1} thành một chương duy nhất?`,
      )
    ) {
      return
    }
    try {
      const res = await mergeChapterNext(ch.id)
      onNotify(
        `Đã gộp thành Chương ${res.chapter_index} (${res.raw_chars.toLocaleString('vi-VN')} ký tự Raw).`,
      )
      await loadChapters()
    } catch (err) {
      onError(extractErrorMessage(err))
    }
  }

  const openInspectAndSplit = async (ch: ChapterSummary) => {
    setLoadingInspect(true)
    setInspectChapter(null)
    setSplitOffset(0)
    setSplitSecondTitle(`${ch.title || `Chương ${ch.chapter_index}`} (Phần 2)`)
    try {
      const detail = await fetchChapterDetail(ch.id)
      setInspectChapter(detail)
      setSplitOffset(Math.floor(detail.raw_text.length / 2))
    } catch (err) {
      onError(extractErrorMessage(err))
    } finally {
      setLoadingInspect(false)
    }
  }

  const captureSplitCursor = () => {
    const el = splitTextareaRef.current
    if (!el) return
    setSplitOffset(el.selectionStart)
  }

  const handleConfirmSplit = async () => {
    if (!inspectChapter) return
    if (splitOffset <= 0 || splitOffset >= inspectChapter.raw_text.length) {
      onError('Hãy đặt con trỏ vào giữa nội dung văn bản để tách chương.')
      return
    }
    setSplitting(true)
    try {
      const res = await splitChapterAtOffset(inspectChapter.id, {
        split_offset: splitOffset,
        second_title: splitSecondTitle,
      })
      setInspectChapter(null)
      onNotify(
        `Đã tách thành Chương ${res.first_chapter_index} và Chương ${res.second_chapter_index} (tổng ${res.total_chapters} chương).`,
      )
      await loadChapters()
    } catch (err) {
      onError(extractErrorMessage(err))
    } finally {
      setSplitting(false)
    }
  }

  const totalRawChars = chapters.reduce(
    (acc, c) => acc + (c.raw_chars || c.char_count),
    0,
  )

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-xs">
      <div className="px-4 py-3.5 border-b border-slate-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
            <FileText className="w-4 h-4 text-indigo-500" />
            Kho Chương — {formatVolumeLabel(volume)} ({chapters.length})
          </h4>
          <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
            Tổng {totalRawChars.toLocaleString('vi-VN')} ký tự Raw · Đổi tên
            trực tiếp, xem/tách tại vị trí con trỏ, hoặc gộp 2 chương kề nhau.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setPasteTitle(`Chương ${chapters.length + 1}`)
              setPasteRaw('')
              setPasteOpen(true)
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <FilePlus2 className="w-3.5 h-3.5 text-indigo-500" />
            Dán thêm chương
          </button>
          <button
            type="button"
            onClick={onOpenImportModal}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            Nhập tệp (.epub/.txt/.docx)
          </button>
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-center text-xs text-slate-400">
          Đang tải Kho Chương...
        </div>
      ) : chapters.length === 0 ? (
        <div className="p-8 text-center text-xs text-slate-500 dark:text-zinc-400 space-y-2">
          <p>
            Tập/Quyển này chưa có chương nào. Bạn có thể nhập tệp
            `.epub`/`.txt`/`.docx` hoặc dán trực tiếp văn bản Raw.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 bg-slate-50 dark:bg-zinc-950 text-slate-500 dark:text-zinc-400 uppercase text-[11px] border-b border-slate-200 dark:border-zinc-800">
              <tr>
                <th className="w-12 px-3 py-2.5 text-center font-semibold">
                  STT
                </th>
                <th className="px-3 py-2.5 font-semibold min-w-[200px]">
                  Tiêu đề chương
                </th>
                <th className="px-2.5 py-2.5 text-right font-semibold">Raw</th>
                <th className="px-2.5 py-2.5 text-right font-semibold">Dịch</th>
                <th className="px-2.5 py-2.5 font-semibold">Trạng thái</th>
                <th className="px-3 py-2.5 text-right font-semibold">
                  Thao tác
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
              {chapters.map((ch, idx) => {
                const stMeta =
                  CHAPTER_STATUS_META[ch.status as ChapterStatus] ??
                  CHAPTER_STATUS_META.pending
                const isLast = idx === chapters.length - 1
                return (
                  <tr
                    key={ch.id}
                    className="hover:bg-slate-50/70 dark:hover:bg-zinc-800/40"
                  >
                    <td className="px-3 py-2 text-center font-mono font-semibold text-slate-500">
                      {ch.chapter_index}
                    </td>
                    <td className="px-2 py-1.5">
                      <InlineChapterTitle
                        value={ch.title || `Chương ${ch.chapter_index}`}
                        onSave={(v) => void handleRename(ch, v)}
                      />
                    </td>
                    <td className="px-2.5 py-2 text-right font-mono text-slate-600 dark:text-zinc-300">
                      {(ch.raw_chars || ch.char_count).toLocaleString('vi-VN')}
                    </td>
                    <td className="px-2.5 py-2 text-right font-mono text-slate-500 dark:text-zinc-400">
                      {(ch.translated_chars || 0).toLocaleString('vi-VN')}
                    </td>
                    <td className="px-2.5 py-2">
                      <span
                        className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${stMeta.badgeClass}`}
                      >
                        {stMeta.label}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          title="Xem trước Raw & Tách chương tại vị trí con trỏ"
                          onClick={() => void openInspectAndSplit(ch)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/15 cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>Xem / Tách</span>
                        </button>
                        <button
                          type="button"
                          disabled={isLast}
                          title="Gộp với chương kế tiếp"
                          onClick={() => void handleMergeNext(ch)}
                          className="p-1 rounded-md text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-30 cursor-pointer"
                        >
                          <Merge className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Xóa chương này"
                          onClick={() => void handleDeleteOne(ch)}
                          className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Paste New Chapter Modal */}
      {pasteOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">
                Dán thêm chương mới — {formatVolumeLabel(volume)}
              </h3>
              <button
                type="button"
                onClick={() => setPasteOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handlePasteSubmit} className="p-6 space-y-4 text-sm">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                  Tiêu đề chương (tùy chọn)
                </label>
                <input
                  type="text"
                  value={pasteTitle}
                  onChange={(e) => setPasteTitle(e.target.value)}
                  placeholder="VD: Chương 1 — Khởi đầu"
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                  Nội dung văn bản gốc (Raw) *
                </label>
                <textarea
                  rows={10}
                  required
                  value={pasteRaw}
                  onChange={(e) => setPasteRaw(e.target.value)}
                  placeholder="Dán nội dung chương tiếng Nhật / Trung / Hàn vào đây..."
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 font-serif text-sm"
                />
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-zinc-800">
                <span className="text-xs text-slate-400 font-mono">
                  {pasteRaw.trim().length.toLocaleString('vi-VN')} ký tự
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPasteOpen(false)}
                    className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    Hủy
                  </button>
                  <button
                    type="submit"
                    disabled={savingPaste}
                    className="px-5 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white cursor-pointer"
                  >
                    {savingPaste ? 'Đang lưu...' : 'Thêm chương'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Preview Raw & Split at Cursor Modal */}
      {(loadingInspect || inspectChapter) && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">
                  {inspectChapter
                    ? `Xem trước Raw & Tách chương #${inspectChapter.chapter_index}: ${inspectChapter.title}`
                    : 'Đang tải nội dung chương...'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  Click đặt con trỏ vào đúng vị trí muốn cắt trong văn bản Raw
                  bên dưới, rồi bấm "Tách tại vị trí con trỏ".
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInspectChapter(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {inspectChapter ? (
              <>
                <div className="p-6 flex-1 overflow-y-auto space-y-4 text-xs">
                  <textarea
                    ref={splitTextareaRef}
                    readOnly
                    value={inspectChapter.raw_text}
                    onClick={captureSplitCursor}
                    onKeyUp={captureSplitCursor}
                    onSelect={captureSplitCursor}
                    rows={14}
                    className="w-full p-4 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 font-serif text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                  />

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center rounded-xl bg-indigo-50/60 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/30 p-3.5">
                    <div className="space-y-0.5">
                      <div className="font-semibold text-indigo-800 dark:text-indigo-300">
                        Vị trí con trỏ: ký tự #{splitOffset}
                      </div>
                      <div className="text-[11px] text-slate-600 dark:text-zinc-300 font-mono">
                        Phần 1: {splitOffset.toLocaleString('vi-VN')} ký tự ·
                        Phần 2:{' '}
                        {Math.max(
                          0,
                          inspectChapter.raw_text.length - splitOffset,
                        ).toLocaleString('vi-VN')}{' '}
                        ký tự
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 dark:text-zinc-300 mb-1">
                        Tiêu đề cho Phần 2
                      </label>
                      <input
                        type="text"
                        value={splitSecondTitle}
                        onChange={(e) => setSplitSecondTitle(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                      />
                    </div>
                  </div>
                </div>

                <div className="px-6 py-4 border-t border-slate-200 dark:border-zinc-800 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setInspectChapter(null)}
                    className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    Đóng
                  </button>
                  <button
                    type="button"
                    disabled={
                      splitting ||
                      splitOffset <= 0 ||
                      splitOffset >= inspectChapter.raw_text.length
                    }
                    onClick={() => void handleConfirmSplit()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-45 text-white cursor-pointer"
                  >
                    <Scissors className="w-3.5 h-3.5" />
                    {splitting ? 'Đang tách...' : 'Tách tại vị trí con trỏ'}
                  </button>
                </div>
              </>
            ) : (
              <div className="p-10 text-center text-sm text-slate-400">
                Đang tải...
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function InlineChapterTitle({
  value,
  onSave,
}: {
  value: string
  onSave: (next: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() && draft.trim() !== value) onSave(draft)
        else setDraft(value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          setDraft(value)
          e.currentTarget.blur()
        }
      }}
      className="w-full px-2 py-1 rounded-md border border-transparent hover:border-slate-200 dark:hover:border-zinc-700 focus:border-indigo-500 bg-transparent focus:bg-white dark:focus:bg-zinc-950 text-xs font-medium text-slate-900 dark:text-zinc-100 focus:outline-none"
    />
  )
}
