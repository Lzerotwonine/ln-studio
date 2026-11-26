import {
  Plus,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  applyChapterMasks,
  deleteSensitiveMask,
  extractErrorMessage,
  fetchSensitiveMasks,
  retranslateSingleChapter,
  scanChapterSensitive,
} from '../lib/api'
import type {
  HybridConfig,
  SensitiveMaskItem,
  TranslateChapterRow,
  TranslationMode,
} from '../types'

interface SensitiveMaskModalProps {
  chapter: TranslateChapterRow
  seriesId: number
  mode: TranslationMode
  temperature: number
  hybridConfig: HybridConfig
  onClose: () => void
  onAppliedAndRetranslated: (msg: string) => void
}

interface EditableMaskRow {
  raw_phrase: string
  safe_replacement: string
  reason: string
}

export function SensitiveMaskModal({
  chapter,
  seriesId,
  mode,
  temperature,
  hybridConfig,
  onClose,
  onAppliedAndRetranslated,
}: SensitiveMaskModalProps) {
  const [rows, setRows] = useState<EditableMaskRow[]>([])
  const [existingMasks, setExistingMasks] = useState<SensitiveMaskItem[]>([])
  const [scope, setScope] = useState<'series' | 'global'>('series')
  const [saveToDb, setSaveToDb] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [infoMsg, setInfoMsg] = useState<string | null>(null)

  const loadExisting = async () => {
    try {
      const list = await fetchSensitiveMasks(seriesId)
      setExistingMasks(list)
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    void loadExisting()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesId])

  const handleScanWithGemini = async () => {
    setScanning(true)
    setErrorMsg(null)
    setInfoMsg(null)
    try {
      const res = await scanChapterSensitive(chapter.id)
      setExistingMasks(res.existing_masks)
      if (res.suggestions.length === 0) {
        setInfoMsg(
          'Gemini không phát hiện cụm nhạy cảm rõ rệt nào. Bạn có thể tự thêm cụm thay thế bên dưới.',
        )
      } else {
        setRows(res.suggestions)
        setInfoMsg(
          `Đã quét xong qua ${res.used_slot}: gợi ý ${res.suggestions.length} cụm cần che nhẹ.`,
        )
      }
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setScanning(false)
    }
  }

  const addEmptyRow = () => {
    setRows((prev) => [
      ...prev,
      { raw_phrase: '', safe_replacement: '', reason: '' },
    ])
  }

  const updateRow = (
    idx: number,
    field: keyof EditableMaskRow,
    val: string,
  ) => {
    setRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, [field]: val } : r)),
    )
  }

  const removeRow = (idx: number) => {
    setRows((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleDeleteSavedMask = async (id: number) => {
    try {
      await deleteSensitiveMask(id)
      setExistingMasks((prev) => prev.filter((m) => m.id !== id))
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleApply = async (alsoRetranslate: boolean) => {
    setApplying(true)
    setErrorMsg(null)
    try {
      const validPairs = rows
        .map((r) => ({
          raw_phrase: r.raw_phrase.trim(),
          safe_replacement: r.safe_replacement.trim(),
        }))
        .filter((p) => p.raw_phrase && p.safe_replacement)

      const maskRes = await applyChapterMasks(chapter.id, {
        extra_masks: validPairs,
        save_to_db: saveToDb,
        scope,
      })

      if (alsoRetranslate) {
        const trRes = await retranslateSingleChapter(chapter.id, {
          mode,
          temperature,
          hybrid_config: hybridConfig,
        })
        onAppliedAndRetranslated(
          `Đã che ${maskRes.applied_count} vị trí (lưu ${maskRes.saved_masks_count} quy tắc) và dịch lại Chương ${chapter.chapter_index} → trạng thái: ${trRes.status} (ratio ${trRes.char_ratio.toFixed(2)}).`,
        )
      } else {
        onAppliedAndRetranslated(
          `Đã áp dụng che ${maskRes.applied_count} vị trí vào masked_raw_text (giữ nguyên raw_text gốc).`,
        )
      }
      onClose()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="w-5 h-5 text-rose-500" />
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">
                Xử lý nội dung nhạy cảm (Scan & Mask) — Chương{' '}
                {chapter.chapter_index}
              </h3>
              <p className="text-xs text-slate-500 dark:text-zinc-400">
                Thay thế nhẹ các cụm từ kích hoạt safety filter vào{' '}
                <code>masked_raw_text</code>, luôn bảo toàn nguyên vẹn{' '}
                <code>raw_text</code> gốc.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-5 text-sm">
          {errorMsg && (
            <div className="px-4 py-3 rounded-xl bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-500/30 text-xs">
              {errorMsg}
            </div>
          )}

          {infoMsg && (
            <div className="px-4 py-3 rounded-xl bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30 text-xs">
              {infoMsg}
            </div>
          )}

          {/* Scan toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              disabled={scanning}
              onClick={() => void handleScanWithGemini()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white cursor-pointer"
            >
              <Sparkles className="w-4 h-4" />
              {scanning
                ? 'Đang quét từ nhạy cảm bằng Gemini...'
                : 'Quét từ nhạy cảm bằng Gemini'}
            </button>

            <button
              type="button"
              onClick={addEmptyRow}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Thêm cụm thủ công
            </button>
          </div>

          {/* Editable suggestions */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-slate-600 dark:text-zinc-300">
              Cụm thay thế mới / gợi ý từ AI ({rows.length}):
            </div>
            {rows.length === 0 ? (
              <div className="p-5 rounded-xl border border-dashed border-slate-200 dark:border-zinc-700 text-center text-xs text-slate-400">
                Bấm "Quét từ nhạy cảm bằng Gemini" hoặc "Thêm cụm thủ công" để
                tạo danh sách thay thế.
              </div>
            ) : (
              <div className="space-y-2">
                {rows.map((row, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-12 gap-2 items-center p-2.5 rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950/60"
                  >
                    <input
                      type="text"
                      value={row.raw_phrase}
                      onChange={(e) =>
                        updateRow(idx, 'raw_phrase', e.target.value)
                      }
                      placeholder="Cụm gốc trong raw..."
                      className="col-span-4 px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                    />
                    <input
                      type="text"
                      value={row.safe_replacement}
                      onChange={(e) =>
                        updateRow(idx, 'safe_replacement', e.target.value)
                      }
                      placeholder="Cụm thay thế nhẹ nhàng..."
                      className="col-span-4 px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                    />
                    <input
                      type="text"
                      value={row.reason}
                      onChange={(e) => updateRow(idx, 'reason', e.target.value)}
                      placeholder="Ghi chú lý do..."
                      className="col-span-3 px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-500"
                    />
                    <button
                      type="button"
                      onClick={() => removeRow(idx)}
                      className="col-span-1 p-1.5 text-slate-400 hover:text-rose-600 cursor-pointer justify-self-center"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Save options */}
          <div className="flex flex-wrap items-center gap-4 text-xs pt-1">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={saveToDb}
                onChange={(e) => setSaveToDb(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600"
              />
              <span>Lưu vào từ điển sensitive_masks để tái sử dụng</span>
            </label>

            {saveToDb && (
              <select
                value={scope}
                onChange={(e) =>
                  setScope(e.target.value as 'series' | 'global')
                }
                className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
              >
                <option value="series">Riêng bộ truyện này</option>
                <option value="global">Áp dụng toàn cục (mọi truyện)</option>
              </select>
            )}
          </div>

          {/* Existing dictionary */}
          {existingMasks.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-slate-600 dark:text-zinc-300">
                Từ điển sensitive_masks đang áp dụng ({existingMasks.length}):
              </div>
              <div className="max-h-36 overflow-y-auto rounded-xl border border-slate-200 dark:border-zinc-800 divide-y divide-slate-100 dark:divide-zinc-800 text-xs">
                {existingMasks.map((m) => (
                  <div
                    key={m.id}
                    className="px-3 py-2 flex items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span
                        className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${
                          m.series_id === null
                            ? 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300'
                            : 'bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-300'
                        }`}
                      >
                        {m.series_id === null ? 'Toàn cục' : 'Truyện này'}
                      </span>
                      <span className="font-mono text-rose-600 dark:text-rose-400">
                        {m.raw_phrase}
                      </span>
                      <span className="text-slate-400">→</span>
                      <span className="font-mono text-emerald-600 dark:text-emerald-400">
                        {m.safe_replacement}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteSavedMask(m.id)}
                      className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 dark:border-zinc-800 flex flex-wrap items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            Đóng
          </button>
          <button
            type="button"
            disabled={applying}
            onClick={() => void handleApply(false)}
            className="px-4 py-2 rounded-xl text-xs font-semibold border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 disabled:opacity-50 cursor-pointer"
          >
            Chỉ áp dụng Mask
          </button>
          <button
            type="button"
            disabled={applying}
            onClick={() => void handleApply(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {applying ? 'Đang xử lý...' : 'Áp dụng & Dịch lại ngay'}
          </button>
        </div>
      </div>
    </div>
  )
}
