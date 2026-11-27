import {
  FileText,
  Plus,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  bulkImportSensitiveMasks,
  createSensitiveMask,
  deleteSensitiveMask,
  extractErrorMessage,
  fetchAllSensitiveMasks,
  fetchSeriesList,
  seedDefaultSensitiveMasks,
  updateSensitiveMask,
} from '../lib/api'
import type { MaskSourceLang, SensitiveMaskItem, Series } from '../types'

interface SensitiveMasksManagerProps {
  defaultSeries?: Series | null
}

const LANG_OPTIONS: Array<{ value: MaskSourceLang; label: string }> = [
  { value: 'all', label: 'Mọi ngôn ngữ (All)' },
  { value: 'ja', label: 'Tiếng Nhật (JA)' },
  { value: 'zh', label: 'Tiếng Trung (ZH)' },
  { value: 'ko', label: 'Tiếng Hàn (KO)' },
]

export function SensitiveMasksManager({
  defaultSeries = null,
}: SensitiveMasksManagerProps) {
  const [seriesList, setSeriesList] = useState<Series[]>([])
  const [scopeFilter, setScopeFilter] = useState<'all' | 'global' | 'series'>(
    defaultSeries ? 'series' : 'all',
  )
  const [filterSeriesId, setFilterSeriesId] = useState<number | null>(
    defaultSeries?.id ?? null,
  )
  const [langFilter, setLangFilter] = useState<MaskSourceLang>('all')
  const [search, setSearch] = useState('')
  const [masks, setMasks] = useState<SensitiveMaskItem[]>([])
  const [loading, setLoading] = useState(false)

  // Add single form
  const [newRaw, setNewRaw] = useState('')
  const [newRep, setNewRep] = useState('')
  const [newLang, setNewLang] = useState<MaskSourceLang>('ja')
  const [newScope, setNewScope] = useState<'global' | 'series'>(
    defaultSeries ? 'series' : 'global',
  )

  // Bulk import modal
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkLang, setBulkLang] = useState<MaskSourceLang>('ja')
  const [bulkScope, setBulkScope] = useState<'global' | 'series'>('global')
  const [bulkBusy, setBulkBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  const notify = (msg: string) => {
    setToastMsg(msg)
    window.setTimeout(() => {
      setToastMsg((curr) => (curr === msg ? null : curr))
    }, 5000)
  }

  useEffect(() => {
    fetchSeriesList()
      .then((list) => {
        setSeriesList(list)
        if (!filterSeriesId && list.length > 0) {
          setFilterSeriesId(defaultSeries?.id ?? list[0].id)
        }
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadMasks = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      const data = await fetchAllSensitiveMasks({
        only_global: scopeFilter === 'global',
        series_id:
          scopeFilter === 'series' && filterSeriesId ? filterSeriesId : null,
        include_global: scopeFilter === 'all',
        source_lang: langFilter === 'all' ? null : langFilter,
        search,
      })
      setMasks(data)
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [scopeFilter, filterSeriesId, langFilter, search])

  useEffect(() => {
    void loadMasks()
  }, [loadMasks])

  const handleAddOne = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newRaw.trim() || !newRep.trim()) return
    setErrorMsg(null)
    try {
      await createSensitiveMask({
        series_id: newScope === 'series' ? filterSeriesId : null,
        source_lang: newLang,
        raw_phrase: newRaw.trim(),
        safe_replacement: newRep.trim(),
      })
      setNewRaw('')
      setNewRep('')
      notify('Đã lưu quy tắc che từ nhạy cảm.')
      await loadMasks()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleBulkImport = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!bulkText.trim()) return
    setBulkBusy(true)
    setErrorMsg(null)
    try {
      const res = await bulkImportSensitiveMasks({
        text: bulkText,
        series_id: bulkScope === 'series' ? filterSeriesId : null,
        source_lang: bulkLang,
      })
      notify(
        `Đã nhập hàng loạt: +${res.imported} mới, cập nhật ${res.updated}${res.skipped > 0 ? `, bỏ qua ${res.skipped} dòng sai định dạng` : ''}.`,
      )
      setBulkOpen(false)
      setBulkText('')
      await loadMasks()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setBulkBusy(false)
    }
  }

  const handleSeedDefault = async () => {
    setBulkBusy(true)
    setErrorMsg(null)
    try {
      const res = await seedDefaultSensitiveMasks()
      notify(
        `Đã nạp bộ từ mẫu JA (seed): +${res.imported} mới, cập nhật ${res.updated}${res.skipped > 0 ? ` (bỏ qua ${res.skipped} dòng thiếu dấu =)` : ''}.`,
      )
      await loadMasks()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setBulkBusy(false)
    }
  }

  const handleUploadTxt = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const text = await file.text()
    setBulkText(text)
  }

  const seriesNameById = new Map(seriesList.map((s) => [s.id, s.title]))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-rose-500" />
            Kho từ nhạy cảm ({masks.length})
          </h3>
          <p className="text-xs text-slate-500 dark:text-zinc-400">
            Dùng cho Pre-mask tự động trước khi dịch và Scan &amp; Mask chương
            bị chặn. Hỗ trợ dán hàng loạt định dạng{' '}
            <code>từ gốc = từ thay thế</code>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() => void handleSeedDefault()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer disabled:opacity-45"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-500" />
            Nạp bộ từ mẫu JA (seed)
          </button>

          <button
            type="button"
            onClick={() => setBulkOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5" />
            Import / Dán hàng loạt
          </button>
        </div>
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

      {/* Quick Add Form */}
      <form
        onSubmit={handleAddOne}
        className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-950/60 p-3.5 grid grid-cols-1 md:grid-cols-12 gap-2 items-center text-xs"
      >
        <input
          type="text"
          required
          value={newRaw}
          onChange={(e) => setNewRaw(e.target.value)}
          placeholder="Cụm từ gốc (VD: 幼女)"
          className="md:col-span-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
        />
        <input
          type="text"
          required
          value={newRep}
          onChange={(e) => setNewRep(e.target.value)}
          placeholder="Cụm thay thế nhẹ (VD: bé gái / cô bé)"
          className="md:col-span-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
        />
        <select
          aria-label="Ngôn ngữ quy tắc mới"
          value={newLang}
          onChange={(e) => setNewLang(e.target.value as MaskSourceLang)}
          className="md:col-span-2 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
        >
          {LANG_OPTIONS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Phạm vi quy tắc mới"
          value={newScope}
          onChange={(e) =>
            setNewScope(e.target.value as 'global' | 'series')
          }
          className="md:col-span-2 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
        >
          <option value="global">Toàn cục</option>
          {filterSeriesId && <option value="series">Riêng truyện</option>}
        </select>
        <button
          type="submit"
          className="md:col-span-2 inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg font-semibold bg-slate-900 dark:bg-zinc-100 text-white dark:text-zinc-900 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          Thêm
        </button>
      </form>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div className="inline-flex rounded-lg bg-slate-100 dark:bg-zinc-950 p-1 font-medium">
          {(
            [
              ['all', 'Tất cả'],
              ['global', 'Toàn cục'],
              ['series', 'Riêng truyện'],
            ] as const
          ).map(([val, lbl]) => (
            <button
              key={val}
              type="button"
              onClick={() => setScopeFilter(val)}
              className={`px-2.5 py-1 rounded-md cursor-pointer ${
                scopeFilter === val
                  ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 shadow-xs'
                  : 'text-slate-500 dark:text-zinc-400'
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>

        {scopeFilter === 'series' && seriesList.length > 0 && (
          <select
            aria-label="Chọn bộ truyện lọc kho nhạy cảm"
            value={filterSeriesId ?? ''}
            onChange={(e) => setFilterSeriesId(Number(e.target.value) || null)}
            className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
          >
            {seriesList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        )}

        <select
          aria-label="Lọc ngôn ngữ từ nhạy cảm"
          value={langFilter}
          onChange={(e) => setLangFilter(e.target.value as MaskSourceLang)}
          className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
        >
          {LANG_OPTIONS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>

        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm từ gốc hoặc cụm thay thế..."
            className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
          />
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 bg-slate-50 dark:bg-zinc-950 text-slate-500 dark:text-zinc-400 uppercase text-[11px] border-b border-slate-200 dark:border-zinc-800">
              <tr>
                <th className="px-3 py-2 font-semibold">Cụm từ gốc</th>
                <th className="px-3 py-2 font-semibold">Thay thế nhẹ</th>
                <th className="px-2.5 py-2 font-semibold w-28">Ngôn ngữ</th>
                <th className="px-2.5 py-2 font-semibold w-36">Phạm vi</th>
                <th className="w-10 px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
              {loading ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-slate-400">
                    Đang tải kho từ nhạy cảm...
                  </td>
                </tr>
              ) : masks.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-slate-400">
                    Chưa có quy tắc nào. Bấm{' '}
                    <strong>Nạp bộ từ mẫu JA (seed)</strong> hoặc{' '}
                    <strong>Import / Dán hàng loạt</strong> để khởi tạo nhanh.
                  </td>
                </tr>
              ) : (
                masks.map((m) => (
                  <tr
                    key={m.id}
                    className="hover:bg-slate-50/70 dark:hover:bg-zinc-800/40"
                  >
                    <td className="px-3 py-2 font-semibold text-slate-900 dark:text-zinc-100">
                      {m.raw_phrase}
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        defaultValue={m.safe_replacement}
                        onBlur={(e) => {
                          const next = e.target.value.trim()
                          if (next && next !== m.safe_replacement) {
                            void updateSensitiveMask(m.id, {
                              safe_replacement: next,
                            }).then(() => loadMasks())
                          }
                        }}
                        className="w-full px-2 py-1 rounded border border-transparent hover:border-slate-200 dark:hover:border-zinc-700 focus:border-indigo-500 bg-transparent focus:bg-white dark:focus:bg-zinc-950 focus:outline-none"
                      />
                    </td>
                    <td className="px-2.5 py-2">
                      <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 font-mono text-[10px] uppercase font-semibold">
                        {m.source_lang || 'all'}
                      </span>
                    </td>
                    <td className="px-2.5 py-2 text-[11px] text-slate-500 dark:text-zinc-400 truncate max-w-[140px]">
                      {m.series_id === null
                        ? 'Toàn cục'
                        : seriesNameById.get(m.series_id) ||
                          `Series #${m.series_id}`}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <button
                        type="button"
                        title="Xóa quy tắc"
                        onClick={() =>
                          void deleteSensitiveMask(m.id).then(() => loadMasks())
                        }
                        className="p-1 rounded text-slate-400 hover:text-rose-600 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bulk Import Modal */}
      {bulkOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">
                  Import / Dán hàng loạt từ nhạy cảm
                </h3>
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  Mỗi dòng 1 cặp theo định dạng <code>từ gốc = từ thay thế</code>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setBulkOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleBulkImport} className="p-6 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-600 dark:text-zinc-300 mb-1">
                    Phạm vi lưu
                  </label>
                  <select
                    value={bulkScope}
                    onChange={(e) =>
                      setBulkScope(e.target.value as 'global' | 'series')
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  >
                    <option value="global">Toàn cục (áp dụng mọi truyện)</option>
                    {filterSeriesId && (
                      <option value="series">
                        Riêng truyện (
                        {seriesNameById.get(filterSeriesId) ||
                          `#${filterSeriesId}`}
                        )
                      </option>
                    )}
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-600 dark:text-zinc-300 mb-1">
                    Ngôn ngữ áp dụng
                  </label>
                  <select
                    value={bulkLang}
                    onChange={(e) =>
                      setBulkLang(e.target.value as MaskSourceLang)
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  >
                    {LANG_OPTIONS.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="font-semibold text-slate-600 dark:text-zinc-300">
                    Nội dung danh sách *
                  </label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.tsv,.csv"
                    onChange={(e) => void handleUploadTxt(e)}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:underline font-semibold cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    Nạp từ tệp .txt
                  </button>
                </div>
                <textarea
                  rows={10}
                  required
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={'幼女 = bé gái\n少女 = thiếu nữ\n全裸 = khỏa thân'}
                  className="w-full p-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 font-mono text-xs"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => setBulkOpen(false)}
                  className="px-4 py-2 rounded-xl font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={bulkBusy || !bulkText.trim()}
                  className="px-5 py-2 rounded-xl font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-45 text-white cursor-pointer"
                >
                  {bulkBusy ? 'Đang nhập...' : 'Nhập vào Kho từ nhạy cảm'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
