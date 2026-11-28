import {
  AlertTriangle,
  Eye,
  FileCode2,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteReferenceFile,
  extractErrorMessage,
  fetchReferenceFileDetail,
  fetchReferenceFiles,
  syncReferenceFilesDisk,
  updateReferenceFile,
  uploadReferenceFile,
} from '../lib/api'
import type { ReferenceFileDetail, ReferenceFileItem } from '../types'

const LARGE_FILE_BYTES = 500 * 1024

export function ReferencePacksManager() {
  const [files, setFiles] = useState<ReferenceFileItem[]>([])
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [uploading, setUploading] = useState(false)

  // Upload form
  const [packName, setPackName] = useState('LN-VN Core')
  const [uploadSummary, setUploadSummary] = useState(false)
  const [uploadTranslate, setUploadTranslate] = useState(true)
  const [uploadActive, setUploadActive] = useState(true)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Preview modal
  const [previewDoc, setPreviewDoc] = useState<ReferenceFileDetail | null>(null)

  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  const notify = (msg: string) => {
    setToastMsg(msg)
    window.setTimeout(() => {
      setToastMsg((curr) => (curr === msg ? null : curr))
    }, 4500)
  }

  const loadFiles = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      setFiles(await fetchReferenceFiles())
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setErrorMsg(null)
    try {
      await uploadReferenceFile(file, {
        pack_name: packName,
        use_in_summary: uploadSummary,
        use_in_translate: uploadTranslate,
        is_active: uploadActive,
      })
      notify(`Đã tải lên tệp tham chiếu "${file.name}" vào gói ${packName}.`)
      await loadFiles()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setUploading(false)
    }
  }

  const handleSyncDisk = async () => {
    setSyncing(true)
    setErrorMsg(null)
    try {
      const res = await syncReferenceFilesDisk()
      notify(
        `Đã đồng bộ từ thư mục gốc: +${res.inserted} tệp mới (tổng ${res.total} tệp).`,
      )
      await loadFiles()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setSyncing(false)
    }
  }

  const handleToggle = async (
    item: ReferenceFileItem,
    patch: Partial<
      Pick<ReferenceFileItem, 'is_active' | 'use_in_summary' | 'use_in_translate'>
    >,
  ) => {
    setErrorMsg(null)
    try {
      const updated = await updateReferenceFile(item.id, patch)
      setFiles((prev) => prev.map((f) => (f.id === updated.id ? updated : f)))
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleDelete = async (item: ReferenceFileItem) => {
    if (!window.confirm(`Xóa tệp tham chiếu "${item.filename}" khỏi DB?`)) return
    setErrorMsg(null)
    try {
      await deleteReferenceFile(item.id)
      setFiles((prev) => prev.filter((f) => f.id !== item.id))
      notify(`Đã xóa "${item.filename}".`)
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handlePreview = async (item: ReferenceFileItem) => {
    setErrorMsg(null)
    try {
      setPreviewDoc(await fetchReferenceFileDetail(item.id))
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const activeTranslateTokens = files
    .filter((f) => f.is_active && f.use_in_translate)
    .reduce((acc, f) => acc + f.estimated_tokens, 0)
  const activeSummaryTokens = files
    .filter((f) => f.is_active && f.use_in_summary)
    .reduce((acc, f) => acc + f.estimated_tokens, 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
            <FileCode2 className="w-4 h-4 text-emerald-500" />
            Tài liệu tham chiếu ({files.length})
          </h3>
          <p className="text-xs text-slate-500 dark:text-zinc-400">
            Các tệp quy tắc dịch tự động đính kèm theo từng pha khi bộ truyện
            chạy ở chế độ <strong>Chuẩn xuất bản</strong>.
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-1.5 text-[11px] text-slate-500 dark:text-zinc-400">
            <span>
              Đang nạp pha Dịch:{' '}
              <strong className="text-indigo-600 dark:text-indigo-400">
                ~{activeTranslateTokens.toLocaleString('vi-VN')} tokens
              </strong>
            </span>
            <span>
              Đang nạp pha Tóm tắt:{' '}
              <strong className="text-emerald-600 dark:text-emerald-400">
                ~{activeSummaryTokens.toLocaleString('vi-VN')} tokens
              </strong>
            </span>
          </div>
        </div>

        <button
          type="button"
          disabled={syncing}
          onClick={() => void handleSyncDisk()}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer disabled:opacity-45"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
          Đồng bộ từ thư mục gốc
        </button>
      </div>

      {errorMsg && (
        <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 text-xs">
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
        <div className="px-3.5 py-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300 text-xs font-medium">
          {toastMsg}
        </div>
      )}

      {/* Upload Bar */}
      <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-950/60 p-3.5 flex flex-wrap items-center gap-3 text-xs">
        <input
          type="text"
          value={packName}
          onChange={(e) => setPackName(e.target.value)}
          placeholder="Tên gói (VD: LN-VN Core)"
          className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 w-44"
        />
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={uploadTranslate}
            onChange={(e) => setUploadTranslate(e.target.checked)}
            className="rounded border-slate-300 text-indigo-600"
          />
          Nạp khi Dịch
        </label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={uploadSummary}
            onChange={(e) => setUploadSummary(e.target.checked)}
            className="rounded border-slate-300 text-indigo-600"
          />
          Nạp khi Tóm tắt
        </label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={uploadActive}
            onChange={(e) => setUploadActive(e.target.checked)}
            className="rounded border-slate-300 text-indigo-600"
          />
          Bật ngay
        </label>

        <input
          ref={fileRef}
          type="file"
          accept=".md,.txt,.xml"
          onChange={(e) => void handleUpload(e)}
          className="hidden"
        />
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className="ml-auto inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg font-semibold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-45 cursor-pointer"
        >
          <Upload className="w-3.5 h-3.5" />
          {uploading ? 'Đang tải...' : 'Tải lên (.md / .txt / .xml)'}
        </button>
      </div>

      {/* List Table */}
      <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-50 dark:bg-zinc-950 text-slate-500 dark:text-zinc-400 uppercase text-[11px] border-b border-slate-200 dark:border-zinc-800">
            <tr>
              <th className="px-3.5 py-2.5 font-semibold">Tệp / Gói</th>
              <th className="px-2.5 py-2.5 font-semibold text-right w-32">
                Dung lượng
              </th>
              <th className="px-2.5 py-2.5 font-semibold text-center w-24">
                Kích hoạt
              </th>
              <th className="px-2.5 py-2.5 font-semibold text-center w-28">
                Pha Tóm tắt
              </th>
              <th className="px-2.5 py-2.5 font-semibold text-center w-24">
                Pha Dịch
              </th>
              <th className="px-2.5 py-2.5 font-semibold text-right w-20" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
            {loading ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-slate-400">
                  Đang tải danh sách Reference Packs...
                </td>
              </tr>
            ) : files.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-slate-400">
                  Chưa có tệp tham chiếu nào. Hãy bấm{' '}
                  <strong>Đồng bộ từ thư mục gốc</strong> hoặc tải tệp lên.
                </td>
              </tr>
            ) : (
              files.map((item) => {
                const isLarge = item.size_bytes >= LARGE_FILE_BYTES
                return (
                  <tr
                    key={item.id}
                    className={`hover:bg-slate-50/70 dark:hover:bg-zinc-800/40 ${
                      !item.is_active ? 'opacity-65' : ''
                    }`}
                  >
                    <td className="px-3.5 py-2.5">
                      <div className="font-semibold text-slate-900 dark:text-zinc-100 flex flex-wrap items-center gap-1.5">
                        <span className="font-mono">{item.filename}</span>
                        <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-[10px] font-medium text-slate-500 dark:text-zinc-400">
                          {item.pack_name}
                        </span>
                        {isLarge && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 text-[10px] font-semibold">
                            <AlertTriangle className="w-3 h-3" />
                            Tệp lớn — tốn nhiều token
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="px-2.5 py-2.5 text-right font-mono text-[11px] text-slate-500 dark:text-zinc-400">
                      <div>{(item.size_bytes / 1024).toFixed(1)} KB</div>
                      <div className="text-[10px] text-slate-400">
                        ~{item.estimated_tokens.toLocaleString('vi-VN')} tok
                      </div>
                    </td>

                    <td className="px-2.5 py-2.5 text-center">
                      <input
                        type="checkbox"
                        aria-label={`Kích hoạt ${item.filename}`}
                        checked={item.is_active}
                        onChange={(e) =>
                          void handleToggle(item, {
                            is_active: e.target.checked,
                          })
                        }
                        className="rounded border-slate-300 text-indigo-600 cursor-pointer"
                      />
                    </td>

                    <td className="px-2.5 py-2.5 text-center">
                      <input
                        type="checkbox"
                        aria-label={`Dùng khi tóm tắt ${item.filename}`}
                        checked={item.use_in_summary}
                        onChange={(e) =>
                          void handleToggle(item, {
                            use_in_summary: e.target.checked,
                          })
                        }
                        className="rounded border-slate-300 text-emerald-600 cursor-pointer"
                      />
                    </td>

                    <td className="px-2.5 py-2.5 text-center">
                      <input
                        type="checkbox"
                        aria-label={`Dùng khi dịch ${item.filename}`}
                        checked={item.use_in_translate}
                        onChange={(e) =>
                          void handleToggle(item, {
                            use_in_translate: e.target.checked,
                          })
                        }
                        className="rounded border-slate-300 text-indigo-600 cursor-pointer"
                      />
                    </td>

                    <td className="px-2.5 py-2.5 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          title="Xem nội dung"
                          onClick={() => void handlePreview(item)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Xóa tệp"
                          onClick={() => void handleDelete(item)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Preview Modal */}
      {previewDoc && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <div>
                <h4 className="font-bold font-mono text-sm text-slate-900 dark:text-zinc-100">
                  {previewDoc.filename}
                </h4>
                <p className="text-[11px] text-slate-400">
                  {previewDoc.pack_name} ·{' '}
                  {(previewDoc.size_bytes / 1024).toFixed(1)} KB · ~
                  {previewDoc.estimated_tokens.toLocaleString('vi-VN')} tokens
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewDoc(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <pre className="flex-1 overflow-auto p-5 text-xs font-mono whitespace-pre-wrap text-slate-700 dark:text-zinc-300 bg-slate-50 dark:bg-zinc-950">
              {previewDoc.content.slice(0, 40000)}
              {previewDoc.content.length > 40000
                ? '\n\n... [Đã cắt bớt hiển thị xem trước để giữ mượt trình duyệt] ...'
                : ''}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
