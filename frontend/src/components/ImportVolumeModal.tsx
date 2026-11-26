import { CheckCircle2, FileText, Upload, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  extractErrorMessage,
  fetchVolumeChapters,
  importVolumeBook,
} from '../lib/api'
import type {
  ChapterSummary,
  SplitMode,
  Volume,
  VolumeImportResponse,
} from '../types'

interface ImportVolumeModalProps {
  volume: Volume
  seriesTitle: string
  onClose: () => void
  onImported?: (result: VolumeImportResponse) => void
}

export function ImportVolumeModal({
  volume,
  seriesTitle,
  onClose,
  onImported,
}: ImportVolumeModalProps) {
  const [file, setFile] = useState<File | null>(null)
  const [splitMode, setSplitMode] = useState<SplitMode>('epub_chapters')
  const [keepFurigana, setKeepFurigana] = useState(true)
  const [chunkMin, setChunkMin] = useState(4000)
  const [chunkMax, setChunkMax] = useState(5000)
  const [replaceExisting, setReplaceExisting] = useState(true)
  const [importing, setImporting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [result, setResult] = useState<VolumeImportResponse | null>(null)
  const [existingChapters, setExistingChapters] = useState<ChapterSummary[]>([])

  useEffect(() => {
    let active = true
    fetchVolumeChapters(volume.id)
      .then((list) => {
        if (active) setExistingChapters(list)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [volume.id])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) {
      setErrorMsg('Hãy chọn một tệp .epub, .txt hoặc .docx.')
      return
    }
    setImporting(true)
    setErrorMsg(null)
    try {
      const res = await importVolumeBook(volume.id, file, {
        split_mode: splitMode,
        keep_furigana: keepFurigana,
        chunk_min: chunkMin,
        chunk_max: chunkMax,
        replace_existing: replaceExisting,
      })
      setResult(res)
      const updated = await fetchVolumeChapters(volume.id)
      setExistingChapters(updated)
      onImported?.(res)
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xl">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-zinc-100">
              Nhập truyện — Tập {volume.volume_number}
            </h3>
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              {seriesTitle} · {volume.title}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {errorMsg && (
            <div className="px-4 py-3 rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 text-sm">
              {errorMsg}
            </div>
          )}

          {result && (
            <div className="px-4 py-3 rounded-xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 text-sm flex items-start gap-2.5">
              <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">
                  Đã nhập thành công {result.chapters_imported} chương (
                  {result.total_chars.toLocaleString('vi-VN')} ký tự) từ{' '}
                  {result.filename}
                </div>
                <div className="text-xs opacity-85 mt-0.5">
                  Chế độ:{' '}
                  {result.split_mode === 'epub_chapters'
                    ? 'Theo cấu trúc chương gốc'
                    : 'Chia chunk theo ranh giới đoạn văn'}
                  {' · '}
                  Furigana: {result.keep_furigana ? 'Giữ nguyên' : 'Đã lược bỏ'}
                </div>
              </div>
            </div>
          )}

          {/* File picker */}
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-zinc-200 mb-1.5">
              Chọn tệp truyện gốc (.epub, .txt, .docx) *
            </label>
            <label className="flex flex-col items-center justify-center gap-2 p-6 rounded-xl border-2 border-dashed border-slate-300 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950/60 hover:border-indigo-400 transition-colors cursor-pointer">
              <Upload className="w-6 h-6 text-indigo-500" />
              <span className="text-sm font-medium text-slate-700 dark:text-zinc-200">
                {file ? file.name : 'Bấm để chọn tệp .epub, .txt hoặc .docx'}
              </span>
              <span className="text-xs text-slate-400 dark:text-zinc-500">
                {file
                  ? `${(file.size / 1024).toFixed(1)} KB`
                  : 'EPUB đọc chuẩn thứ tự spine, xử lý mọi thẻ <ruby> kể cả trong blockquote/em/strong/td/a'}
              </span>
              <input
                type="file"
                accept=".epub,.txt,.docx"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>

          {/* Split mode */}
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-zinc-200 mb-1.5">
              Kiểu tách chương khi import
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setSplitMode('epub_chapters')}
                className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                  splitMode === 'epub_chapters'
                    ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-500/15 dark:border-indigo-400'
                    : 'border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800'
                }`}
              >
                <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                  Theo file chương gốc EPUB
                </div>
                <div className="text-xs text-slate-500 dark:text-zinc-400 mt-1">
                  Giữ nguyên từng chương theo cấu trúc spine của EPUB (hoặc tiêu
                  đề chương trong TXT/DOCX).
                </div>
              </button>

              <button
                type="button"
                onClick={() => setSplitMode('chunk_chars')}
                className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                  splitMode === 'chunk_chars'
                    ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-500/15 dark:border-indigo-400'
                    : 'border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800'
                }`}
              >
                <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                  Chia chunk 4.000–5.000 ký tự
                </div>
                <div className="text-xs text-slate-500 dark:text-zinc-400 mt-1">
                  Gộp toàn bộ văn bản rồi cắt đều theo ranh giới đoạn văn (tối
                  ưu cho dịch AI).
                </div>
              </button>
            </div>
          </div>

          {splitMode === 'chunk_chars' && (
            <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800 p-3.5">
              <div>
                <label className="block text-xs text-slate-600 dark:text-zinc-400 mb-1">
                  Ngưỡng tối thiểu (ký tự)
                </label>
                <input
                  type="number"
                  min={500}
                  max={20000}
                  value={chunkMin}
                  onChange={(e) => setChunkMin(Number(e.target.value) || 4000)}
                  className="w-full px-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600 dark:text-zinc-400 mb-1">
                  Ngưỡng tối đa (ký tự)
                </label>
                <input
                  type="number"
                  min={1000}
                  max={30000}
                  value={chunkMax}
                  onChange={(e) => setChunkMax(Number(e.target.value) || 5000)}
                  className="w-full px-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                />
              </div>
            </div>
          )}

          {/* Options */}
          <div className="space-y-2.5 text-sm">
            <label className="flex items-center gap-2.5 text-slate-700 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={keepFurigana}
                onChange={(e) => setKeepFurigana(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span>
                Giữ furigana dạng{' '}
                <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-xs">
                  漢字（ふりがな）
                </code>{' '}
                khi nhập EPUB
              </span>
            </label>

            <label className="flex items-center gap-2.5 text-slate-700 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={replaceExisting}
                onChange={(e) => setReplaceExisting(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span>Thay thế toàn bộ chương cũ của tập này (nếu đã có)</span>
            </label>
          </div>

          {/* Existing chapters preview */}
          {existingChapters.length > 0 && (
            <div className="rounded-xl border border-slate-200 dark:border-zinc-800 overflow-hidden">
              <div className="px-3.5 py-2 bg-slate-50 dark:bg-zinc-950/70 text-xs font-semibold text-slate-600 dark:text-zinc-400 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5" />
                  Các chương hiện có trong Tập {volume.volume_number} (
                  {existingChapters.length})
                </span>
                <span>
                  {existingChapters
                    .reduce((acc, c) => acc + c.char_count, 0)
                    .toLocaleString('vi-VN')}{' '}
                  ký tự
                </span>
              </div>
              <div className="max-h-40 overflow-y-auto divide-y divide-slate-100 dark:divide-zinc-800 text-xs">
                {existingChapters.map((ch) => (
                  <div
                    key={ch.id}
                    className="px-3.5 py-2 flex items-center justify-between gap-3"
                  >
                    <span className="truncate text-slate-700 dark:text-zinc-300">
                      <strong className="text-slate-900 dark:text-zinc-100">
                        #{ch.chapter_index}
                      </strong>{' '}
                      {ch.title}
                    </span>
                    <span className="shrink-0 font-mono text-slate-400">
                      {ch.char_count.toLocaleString('vi-VN')} ký tự
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100 dark:border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
            >
              Đóng
            </button>
            <button
              type="submit"
              disabled={importing || !file}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              {importing ? 'Đang xử lý...' : 'Nhập vào Tập'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
