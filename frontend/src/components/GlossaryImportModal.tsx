import { CheckCircle2, Columns3, FileSpreadsheet, Info, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import {
  extractErrorMessage,
  importGlossaryFile,
  previewGlossaryImport,
} from '../lib/api'
import type {
  GlossaryDuplicateMode,
  GlossaryImportPreviewResponse,
  GlossaryImportResponse,
  GlossaryStatus,
  Series,
  Volume,
} from '../types'

interface GlossaryImportModalProps {
  series: Series
  selectedVolume: Volume | null
  onClose: () => void
  onImported: (res: GlossaryImportResponse) => void
}

const MAPPING_FIELDS: Array<{
  key: string
  label: string
  required?: boolean
}> = [
  { key: 'source_term', label: 'Từ gốc', required: true },
  { key: 'vi_term', label: 'Bản dịch tiếng Việt' },
  { key: 'reading', label: 'Phiên âm' },
  { key: 'han_viet', label: 'Hán-Việt' },
  { key: 'english_meaning', label: 'Nghĩa tiếng Anh' },
  { key: 'term_type', label: 'Loại thuật ngữ' },
  { key: 'status', label: 'Trạng thái' },
  { key: 'total_freq', label: 'Tần suất' },
  { key: 'first_seen_vol', label: 'Tập đầu' },
]

export function GlossaryImportModal({
  series,
  selectedVolume,
  onClose,
  onImported,
}: GlossaryImportModalProps) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<GlossaryImportPreviewResponse | null>(
    null,
  )
  const [previewLoading, setPreviewLoading] = useState(false)
  const [columnMapping, setColumnMapping] = useState<
    Record<string, number | null>
  >({})
  const [hasHeader, setHasHeader] = useState<boolean>(true)

  const [defaultStatus, setDefaultStatus] = useState<GlossaryStatus>('approved')
  const [duplicateMode, setDuplicateMode] =
    useState<GlossaryDuplicateMode>('upsert')
  const [firstSeenVol, setFirstSeenVol] = useState<number>(0)
  const [forceDefaultStatus, setForceDefaultStatus] = useState<boolean>(true)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const handleFileSelected = async (chosen: File | null) => {
    setFile(chosen)
    setPreview(null)
    setErrorMsg(null)
    if (!chosen) return
    setPreviewLoading(true)
    try {
      const data = await previewGlossaryImport(series.id, chosen)
      setPreview(data)
      setColumnMapping({ ...data.suggested_mapping })
      setHasHeader(data.has_header)
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setPreviewLoading(false)
    }
  }

  const applyPresetStep1 = () => {
    setDefaultStatus('ignored')
    setDuplicateMode('skip')
    setFirstSeenVol(0)
    setForceDefaultStatus(true)
  }

  const applyPresetStep2 = () => {
    setDefaultStatus('approved')
    setDuplicateMode('upsert')
    setFirstSeenVol(0)
    setForceDefaultStatus(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) {
      setErrorMsg('Hãy chọn tệp .tsv hoặc .csv trước khi nhập.')
      return
    }
    if (preview && (columnMapping.source_term === null || columnMapping.source_term === undefined)) {
      setErrorMsg('Cần chọn ít nhất cột "Từ gốc (JP/ZH/KO)" để nhập thuật ngữ.')
      return
    }
    setSubmitting(true)
    setErrorMsg(null)
    try {
      const res = await importGlossaryFile(series.id, file, {
        default_status: defaultStatus,
        duplicate_mode: duplicateMode,
        default_first_seen_vol: Math.max(0, firstSeenVol),
        force_default_status: forceDefaultStatus,
        column_mapping: preview ? columnMapping : undefined,
        has_header: preview ? hasHeader : undefined,
      })
      onImported(res)
      onClose()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const mappedFieldByColIdx = new Map<number, string>()
  for (const field of MAPPING_FIELDS) {
    const idx = columnMapping[field.key]
    if (idx !== null && idx !== undefined) {
      mappedFieldByColIdx.set(idx, field.label)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[92vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        <div className="shrink-0 px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">
                Nhập tệp TSV / CSV vào Kho thuật ngữ
              </h3>
              <p className="text-xs text-slate-500 dark:text-zinc-400">
                Bộ truyện: <strong>{series.title}</strong> — tự nhận diện tiêu đề tiếng Việt và cho phép kiểm tra cột trước khi nhập
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4 text-sm">
          {/* 2-step quick helper */}
          <div className="rounded-xl border border-indigo-200/70 dark:border-indigo-500/25 bg-indigo-50/50 dark:bg-indigo-500/10 p-3.5 space-y-2 text-xs">
            <div className="flex items-center gap-1.5 font-semibold text-indigo-800 dark:text-indigo-300">
              <Info className="w-3.5 h-3.5" />
              Mẹo đồng bộ kho lịch sử 2 bước (VD: Tập 1–12 từ Excel)
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={applyPresetStep1}
                className="px-2.5 py-1.5 rounded-lg border border-indigo-200 dark:border-indigo-500/30 bg-white dark:bg-zinc-900 hover:bg-indigo-100/70 dark:hover:bg-indigo-500/20 text-slate-700 dark:text-zinc-200 font-medium cursor-pointer"
              >
                Bước 1: File tổng chưa lọc → Bỏ qua (Gốc)
              </button>
              <button
                type="button"
                onClick={applyPresetStep2}
                className="px-2.5 py-1.5 rounded-lg border border-emerald-200 dark:border-emerald-500/30 bg-white dark:bg-zinc-900 hover:bg-emerald-50 dark:hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 font-medium cursor-pointer"
              >
                Bước 2: File đã lọc → Ghi đè Đã duyệt (Gốc)
              </button>
            </div>
          </div>

          {errorMsg && (
            <div className="px-3.5 py-2.5 rounded-xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 text-xs">
              {errorMsg}
            </div>
          )}

          {/* File picker */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-zinc-300 mb-1.5">
              Chọn tệp TSV / CSV *
            </label>
            <input
              ref={fileRef}
              type="file"
              accept=".tsv,.csv,.txt"
              onChange={(e) => void handleFileSelected(e.target.files?.[0] ?? null)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-dashed border-slate-300 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 hover:border-indigo-400 transition-colors cursor-pointer text-left"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <Upload className="w-4 h-4 text-indigo-500 shrink-0" />
                <span className="truncate text-xs font-medium text-slate-700 dark:text-zinc-200">
                  {file
                    ? `${file.name} (${(file.size / 1024).toFixed(1)} KB)`
                    : 'Nhấn để chọn tệp .tsv hoặc .csv xuất từ Excel...'}
                </span>
              </div>
              <span className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 shrink-0">
                {previewLoading ? 'Đang đọc cột...' : 'Chọn tệp'}
              </span>
            </button>
          </div>

          {/* Column Mapping & 3-row Preview */}
          {preview && (
            <div className="rounded-xl border border-emerald-200/80 dark:border-emerald-500/30 bg-emerald-50/35 dark:bg-emerald-500/5 p-4 space-y-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-semibold text-emerald-800 dark:text-emerald-300">
                  <Columns3 className="w-4 h-4" />
                  Xác nhận ánh xạ cột ({preview.headers.length} cột · ~{preview.total_rows.toLocaleString('vi-VN')} dòng)
                </div>
                <label className="inline-flex items-center gap-1.5 text-slate-600 dark:text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hasHeader}
                    onChange={(e) => setHasHeader(e.target.checked)}
                    className="rounded border-slate-300 text-indigo-600"
                  />
                  <span>Dòng đầu tiên là tiêu đề cột</span>
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {MAPPING_FIELDS.map((field) => {
                  const val = columnMapping[field.key]
                  return (
                    <div key={field.key} className="space-y-1">
                      <label className="flex items-center justify-between text-[11px] font-medium text-slate-600 dark:text-zinc-300">
                        <span>
                          {field.label}
                          {field.required && <span className="text-rose-500 ml-0.5">*</span>}
                        </span>
                        {val !== null && val !== undefined && (
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                        )}
                      </label>
                      <select
                        aria-label={`Ánh xạ cột ${field.label}`}
                        value={val === null || val === undefined ? '' : String(val)}
                        onChange={(e) => {
                          const raw = e.target.value
                          setColumnMapping((prev) => ({
                            ...prev,
                            [field.key]: raw === '' ? null : Number(raw),
                          }))
                        }}
                        className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs"
                      >
                        <option value="">-- Bỏ qua --</option>
                        {preview.headers.map((h, idx) => (
                          <option key={idx} value={idx}>
                            #{idx + 1}: {h}
                          </option>
                        ))}
                      </select>
                    </div>
                  )
                })}
              </div>

              {preview.sample_rows.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400">
                    Xem trước {preview.sample_rows.length} dòng mẫu:
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950">
                    <table className="w-full text-[11px] border-collapse">
                      <thead>
                        <tr className="bg-slate-100 dark:bg-zinc-900 border-b border-slate-200 dark:border-zinc-800">
                          {preview.headers.map((h, idx) => {
                            const mappedLabel = mappedFieldByColIdx.get(idx)
                            return (
                              <th
                                key={idx}
                                className="px-2.5 py-1.5 text-left font-semibold text-slate-700 dark:text-zinc-200 whitespace-nowrap"
                              >
                                <div>{h}</div>
                                {mappedLabel ? (
                                  <div className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                    → {mappedLabel}
                                  </div>
                                ) : (
                                  <div className="text-[10px] font-normal text-slate-400">
                                    (Bỏ qua)
                                  </div>
                                )}
                              </th>
                            )
                          })}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
                        {preview.sample_rows.map((row, rIdx) => (
                          <tr key={rIdx}>
                            {row.map((cell, cIdx) => (
                              <td
                                key={cIdx}
                                className="px-2.5 py-1.5 text-slate-700 dark:text-zinc-300 max-w-[180px] truncate"
                                title={cell}
                              >
                                {cell || <span className="text-slate-300 dark:text-zinc-600">—</span>}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Option 1: Default status */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-zinc-300 mb-1.5">
              1. Trạng thái mặc định khi nhập
            </label>
            <select
              aria-label="Trạng thái mặc định khi nhập"
              value={defaultStatus}
              onChange={(e) =>
                setDefaultStatus(e.target.value as GlossaryStatus)
              }
              className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-xs font-medium"
            >
              <option value="approved">Đã duyệt</option>
              <option value="translated">Đã dịch</option>
              <option value="ignored">
                Bỏ qua (lưu kho tham khảo)
              </option>
              <option value="new">Chưa dịch</option>
            </select>
            <label className="mt-2 inline-flex items-center gap-2 text-xs text-slate-600 dark:text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={forceDefaultStatus}
                onChange={(e) => setForceDefaultStatus(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600"
              />
              <span>
                Áp dụng trạng thái này cho tất cả dòng nhập (kể cả khi trống bản
                dịch Việt)
              </span>
            </label>
          </div>

          {/* Option 2: Duplicate handling */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-zinc-300 mb-1.5">
              2. Chế độ xử lý từ trùng
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <label
                className={`flex items-start gap-2 p-3 rounded-xl border cursor-pointer transition-colors ${
                  duplicateMode === 'skip'
                    ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-500/10'
                    : 'border-slate-200 dark:border-zinc-700'
                }`}
              >
                <input
                  type="radio"
                  name="duplicateMode"
                  value="skip"
                  checked={duplicateMode === 'skip'}
                  onChange={() => setDuplicateMode('skip')}
                  className="mt-0.5 text-indigo-600"
                />
                <div>
                  <div className="font-semibold text-slate-800 dark:text-zinc-100">
                    Bỏ qua từ đã có
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                    Giữ nguyên bản ghi cũ trong Master DB
                  </div>
                </div>
              </label>

              <label
                className={`flex items-start gap-2 p-3 rounded-xl border cursor-pointer transition-colors ${
                  duplicateMode === 'upsert'
                    ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-500/10'
                    : 'border-slate-200 dark:border-zinc-700'
                }`}
              >
                <input
                  type="radio"
                  name="duplicateMode"
                  value="upsert"
                  checked={duplicateMode === 'upsert'}
                  onChange={() => setDuplicateMode('upsert')}
                  className="mt-0.5 text-indigo-600"
                />
                <div>
                  <div className="font-semibold text-slate-800 dark:text-zinc-100">
                    Ghi đè trạng thái và bản dịch
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                    Dùng cho Bước 2 để nâng từ đã lọc lên Đã duyệt
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Option 3: first_seen_vol */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-zinc-300 mb-1.5">
              3. Đánh số tập gốc (first_seen_vol)
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                min={0}
                max={9999}
                aria-label="Đánh số tập gốc"
                value={firstSeenVol}
                onChange={(e) =>
                  setFirstSeenVol(Math.max(0, Number(e.target.value) || 0))
                }
                className="w-24 px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-xs font-mono font-semibold text-center"
              />
              <button
                type="button"
                onClick={() => setFirstSeenVol(0)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border cursor-pointer ${
                  firstSeenVol === 0
                    ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300'
                    : 'border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300'
                }`}
              >
                0 = Gốc (Lịch sử)
              </button>
              {selectedVolume && (
                <button
                  type="button"
                  onClick={() => setFirstSeenVol(selectedVolume.volume_number)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border cursor-pointer ${
                    firstSeenVol === selectedVolume.volume_number
                      ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300'
                      : 'border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300'
                  }`}
                >
                  Tập {selectedVolume.volume_number}
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Nhập <code>0</code> để đánh dấu nhãn <strong>Gốc</strong> cho dữ
              liệu lịch sử trước các tập đang dịch.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={!file || submitting || previewLoading}
              className="px-5 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-45 text-white cursor-pointer"
            >
              {submitting ? 'Đang nhập...' : 'Nhập vào Kho thuật ngữ'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
