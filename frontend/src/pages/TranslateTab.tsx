import {
  Bug,
  Languages,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Square,
  Terminal,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DebugContextModal } from '../components/DebugContextModal'
import { SensitiveMaskModal } from '../components/SensitiveMaskModal'
import {
  extractErrorMessage,
  fetchTranslateStatus,
  getTranslateEventsUrl,
  pauseTranslationJob,
  resumeTranslationJob,
  retranslateSingleChapter,
  startTranslationJob,
  stopTranslationJob,
} from '../lib/api'
import type {
  HybridConfig,
  Series,
  TranslateChapterRow,
  TranslateLogEvent,
  TranslateStatusResponse,
  TranslationMode,
  Volume,
} from '../types'
import { CHAPTER_STATUS_META, MODE_META, formatVolumeLabel } from '../types'

interface TranslateTabProps {
  selectedSeries: Series | null
  selectedVolume: Volume | null
  onBackToDashboard: () => void
}

export function TranslateTab({
  selectedSeries,
  selectedVolume,
  onBackToDashboard,
}: TranslateTabProps) {
  const [statusData, setStatusData] = useState<TranslateStatusResponse | null>(
    null,
  )
  const [logs, setLogs] = useState<TranslateLogEvent[]>([])
  const [sseConnected, setSseConnected] = useState(false)

  // Controls
  const [startChapter, setStartChapter] = useState<number>(1)
  const [endChapter, setEndChapter] = useState<number>(1)
  const [mode, setMode] = useState<TranslationMode>(
    selectedSeries?.translation_mode ?? 'ln_vn',
  )
  const [temperature, setTemperature] = useState<number>(0.7)
  const [onlyUncompleted, setOnlyUncompleted] = useState<boolean>(true)
  const [hybridCfg, setHybridCfg] = useState<HybridConfig>(
    selectedSeries?.hybrid_config ?? {
      use_glossary: true,
      use_characters: true,
      use_relationships: true,
      use_subarc: false,
      rolling_context_lines: 5,
    },
  )

  // Modals & per-row state
  const [debugChapter, setDebugChapter] = useState<TranslateChapterRow | null>(
    null,
  )
  const [maskChapter, setMaskChapter] = useState<TranslateChapterRow | null>(
    null,
  )
  const [retranslatingId, setRetranslatingId] = useState<number | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const logEndRef = useRef<HTMLDivElement | null>(null)
  const loadSeqRef = useRef(0)

  const notify = (msg: string) => {
    setToastMsg(msg)
    window.setTimeout(() => {
      setToastMsg((curr) => (curr === msg ? null : curr))
    }, 4500)
  }

  // Sync mode & hybridCfg when series changes
  useEffect(() => {
    if (!selectedSeries) return
    setMode(selectedSeries.translation_mode)
    setHybridCfg({ ...selectedSeries.hybrid_config })
  }, [selectedSeries])

  const volumeId = selectedVolume?.id ?? null

  const loadStatus = useCallback(
    async (resetRange = false) => {
      const seq = ++loadSeqRef.current
      if (!volumeId) {
        setStatusData(null)
        setLogs([])
        setStartChapter(1)
        setEndChapter(1)
        return
      }
      try {
        const data = await fetchTranslateStatus(volumeId)
        if (seq !== loadSeqRef.current) return
        setStatusData(data)
        if (data.chapters.length > 0) {
          const minIdx = data.chapters[0].chapter_index
          const maxIdx = data.chapters[data.chapters.length - 1].chapter_index
          if (resetRange) {
            setStartChapter(minIdx)
            setEndChapter(maxIdx)
          } else {
            setStartChapter((prev) =>
              prev < minIdx || prev > maxIdx ? minIdx : prev,
            )
            setEndChapter((prev) =>
              prev < minIdx || prev > maxIdx ? maxIdx : prev,
            )
          }
        } else {
          setStartChapter(1)
          setEndChapter(1)
        }
        setLogs(data.recent_logs)
      } catch (err) {
        if (seq !== loadSeqRef.current) return
        setErrorMsg(extractErrorMessage(err))
      }
    },
    [volumeId],
  )

  // Reset all volume-scoped state immediately when switching activeVolumeId
  useEffect(() => {
    setStatusData(null)
    setLogs([])
    setDebugChapter(null)
    setMaskChapter(null)
    setErrorMsg(null)
    setStartChapter(1)
    setEndChapter(1)
    void loadStatus(true)
  }, [volumeId, loadStatus])

  // Real-time Server-Sent Events (SSE) subscription keyed strictly by volumeId
  useEffect(() => {
    if (!volumeId) {
      setSseConnected(false)
      return
    }
    let active = true
    const es = new EventSource(getTranslateEventsUrl(volumeId))

    es.onopen = () => {
      if (active) setSseConnected(true)
    }
    es.onerror = () => {
      if (active) setSseConnected(false)
    }
    es.onmessage = (evt) => {
      if (!active) return
      try {
        const payload = JSON.parse(evt.data) as TranslateLogEvent
        if (payload.type === 'log') {
          setLogs((prev) => [...prev.slice(-240), payload])
        } else if (payload.type === 'chapter_update') {
          setStatusData((prev) => {
            if (!prev || prev.volume_id !== volumeId) return prev
            const updatedChapters = prev.chapters.map((ch) =>
              ch.id === payload.chapter_id
                ? {
                    ...ch,
                    status: payload.status ?? ch.status,
                    char_ratio: payload.char_ratio ?? ch.char_ratio,
                    used_slot: payload.used_slot ?? ch.used_slot,
                    error_message: payload.error_message ?? null,
                  }
                : ch,
            )
            return {
              ...prev,
              done_in_run: payload.done_in_run ?? prev.done_in_run,
              total_targets: payload.total_targets ?? prev.total_targets,
              chapters: updatedChapters,
              counts: {
                total: updatedChapters.length,
                pending: updatedChapters.filter(
                  (c) => c.status === 'pending' || c.status === 'summarized',
                ).length,
                translating: updatedChapters.filter(
                  (c) => c.status === 'translating',
                ).length,
                completed: updatedChapters.filter(
                  (c) => c.status === 'completed',
                ).length,
                blocked: updatedChapters.filter((c) => c.status === 'blocked')
                  .length,
                failed: updatedChapters.filter((c) => c.status === 'failed')
                  .length,
              },
            }
          })
        } else if (payload.type === 'job_status') {
          setStatusData((prev) =>
            prev && prev.volume_id === volumeId
              ? {
                  ...prev,
                  job_state: payload.state ?? prev.job_state,
                  done_in_run: payload.done_in_run ?? prev.done_in_run,
                  total_targets: payload.total_targets ?? prev.total_targets,
                }
              : prev,
          )
          if (payload.state === 'completed' || payload.state === 'stopped') {
            void loadStatus(false)
          }
        }
      } catch {
        // ignore keepalive/malformed chunk
      }
    }

    return () => {
      active = false
      es.close()
      setSseConnected(false)
    }
  }, [volumeId, loadStatus])

  // Auto-scroll terminal logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // ---------- Action Handlers ----------

  const handleStart = async (onlyFailedOrBlocked = false) => {
    if (!selectedVolume) return
    setErrorMsg(null)
    try {
      const res = await startTranslationJob(selectedVolume.id, {
        start_chapter: onlyFailedOrBlocked ? null : startChapter,
        end_chapter: onlyFailedOrBlocked ? null : endChapter,
        mode,
        temperature,
        hybrid_config: hybridCfg,
        only_uncompleted: onlyUncompleted,
        only_failed_or_blocked: onlyFailedOrBlocked,
      })
      setStatusData(res)
      notify(
        onlyFailedOrBlocked
          ? `Đã khởi chạy dịch lại ${res.total_targets} chương lỗi/bị chặn.`
          : `Đã bắt đầu dịch ${res.total_targets} chương (chế độ ${MODE_META[mode].label}).`,
      )
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handlePause = async () => {
    if (!selectedVolume) return
    try {
      setStatusData(await pauseTranslationJob(selectedVolume.id))
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleResume = async () => {
    if (!selectedVolume) return
    try {
      setStatusData(await resumeTranslationJob(selectedVolume.id))
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleStop = async () => {
    if (!selectedVolume) return
    try {
      setStatusData(await stopTranslationJob(selectedVolume.id))
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleRetranslateOne = async (ch: TranslateChapterRow) => {
    setRetranslatingId(ch.id)
    setErrorMsg(null)
    try {
      const res = await retranslateSingleChapter(ch.id, {
        mode,
        temperature,
        hybrid_config: hybridCfg,
      })
      notify(
        `Chương ${ch.chapter_index}: ${res.status} (ratio ${res.char_ratio.toFixed(2)}${res.retried_with_fiction_context ? ', đã thử lại <FICTION_CONTEXT>' : ''}).`,
      )
      await loadStatus()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setRetranslatingId(null)
    }
  }

  if (!selectedSeries || !selectedVolume) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-6">
        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 text-center space-y-3">
          <Languages className="w-8 h-8 mx-auto text-indigo-500" />
          <h2 className="text-lg font-bold text-slate-900 dark:text-zinc-100">
            Chọn Bộ truyện & Tập để bắt đầu dịch
          </h2>
          <p className="text-sm text-slate-500 dark:text-zinc-400">
            Hãy tạo bộ truyện, thêm tập và nhập tệp raw ở Dashboard / Thuật ngữ
            trước khi chạy bộ máy dịch thuật.
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

  const jobState = statusData?.job_state ?? 'idle'
  const isRunning = jobState === 'running' || jobState === 'stopping'
  const isPaused = jobState === 'paused'
  const chapters = statusData?.chapters ?? []
  const failedOrBlockedCount =
    (statusData?.counts.blocked ?? 0) + (statusData?.counts.failed ?? 0)

  return (
    <div className="max-w-[1600px] mx-auto p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
            Dịch thuật Đa chế độ
          </h2>
          <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 text-xs font-medium text-slate-600 dark:text-zinc-300">
            {formatVolumeLabel(selectedVolume)}
          </span>
          <span
            className={`px-2 py-0.5 text-xs font-medium rounded-full ${
              sseConnected
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                : 'bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400'
            }`}
          >
            SSE: {sseConnected ? 'Live' : 'Kết nối...'}
          </span>
        </div>

        <button
          type="button"
          onClick={() => void loadStatus(false)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Làm mới
        </button>
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

      {/* Control Panel */}
      <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4 shadow-xs">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
          {/* Range */}
          <div className="lg:col-span-3 grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1">
                Từ chương
              </label>
              <input
                type="number"
                min={1}
                value={startChapter}
                onChange={(e) =>
                  setStartChapter(Math.max(1, Number(e.target.value) || 1))
                }
                className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1">
                Đến chương
              </label>
              <input
                type="number"
                min={1}
                value={endChapter}
                onChange={(e) =>
                  setEndChapter(Math.max(1, Number(e.target.value) || 1))
                }
                className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
              />
            </div>
          </div>

          {/* Mode switcher */}
          <div className="lg:col-span-3">
            <label className="block text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1">
              Chế độ dịch
            </label>
            <select
              aria-label="Chọn chế độ dịch"
              value={mode}
              onChange={(e) => setMode(e.target.value as TranslationMode)}
              className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 font-medium"
            >
              <option value="ln_vn">LN-VN Chuẩn (Master XML + Context)</option>
              <option value="freeform">Dịch Tự Do (Freeform — Glossary gọn)</option>
              <option value="hybrid">Hybrid (Tùy chọn từng khối Context)</option>
            </select>
          </div>

          {/* Temperature */}
          <div className="lg:col-span-2">
            <label className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1">
              <span>Temperature</span>
              <span className="font-mono font-bold text-indigo-600 dark:text-indigo-400">
                {temperature.toFixed(1)}
              </span>
            </label>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className="w-full accent-indigo-600 cursor-pointer"
            />
          </div>

          {/* Action buttons */}
          <div className="lg:col-span-4 flex flex-wrap items-center justify-end gap-2">
            {!isRunning && !isPaused && (
              <button
                type="button"
                disabled={chapters.length === 0}
                onClick={() => void handleStart(false)}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-45 text-white shadow-xs cursor-pointer"
              >
                <Play className="w-4 h-4" />
                Bắt đầu dịch
              </button>
            )}

            {isRunning && (
              <button
                type="button"
                onClick={() => void handlePause()}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-white cursor-pointer"
              >
                <Pause className="w-4 h-4" />
                Tạm dừng
              </button>
            )}

            {isPaused && (
              <button
                type="button"
                onClick={() => void handleResume()}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
              >
                <Play className="w-4 h-4" />
                Tiếp tục
              </button>
            )}

            {(isRunning || isPaused) && (
              <button
                type="button"
                onClick={() => void handleStop()}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white cursor-pointer"
              >
                <Square className="w-3.5 h-3.5" />
                Dừng
              </button>
            )}

            {failedOrBlockedCount > 0 && !isRunning && !isPaused && (
              <button
                type="button"
                onClick={() => void handleStart(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-semibold border border-rose-300 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 hover:bg-rose-100 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Dịch lại lỗi ({failedOrBlockedCount})
              </button>
            )}
          </div>
        </div>

        {/* Context fine-tuning row */}
        <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-slate-100 dark:border-zinc-800 text-xs">
          <label className="inline-flex items-center gap-1.5 cursor-pointer text-slate-700 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={onlyUncompleted}
              onChange={(e) => setOnlyUncompleted(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600"
            />
            Bỏ qua chương đã hoàn thành
          </label>

          {(mode === 'freeform' || mode === 'hybrid') && (
            <>
              <span className="text-slate-300 dark:text-zinc-700">|</span>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hybridCfg.use_glossary}
                  onChange={(e) =>
                    setHybridCfg({
                      ...hybridCfg,
                      use_glossary: e.target.checked,
                    })
                  }
                  className="rounded border-slate-300 text-indigo-600"
                />
                Glossary
              </label>

              {mode === 'hybrid' && (
                <>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hybridCfg.use_characters}
                      onChange={(e) =>
                        setHybridCfg({
                          ...hybridCfg,
                          use_characters: e.target.checked,
                        })
                      }
                      className="rounded border-slate-300 text-indigo-600"
                    />
                    Roster
                  </label>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hybridCfg.use_relationships}
                      onChange={(e) =>
                        setHybridCfg({
                          ...hybridCfg,
                          use_relationships: e.target.checked,
                        })
                      }
                      className="rounded border-slate-300 text-indigo-600"
                    />
                    Xưng hô
                  </label>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hybridCfg.use_subarc}
                      onChange={(e) =>
                        setHybridCfg({
                          ...hybridCfg,
                          use_subarc: e.target.checked,
                        })
                      }
                      className="rounded border-slate-300 text-indigo-600"
                    />
                    Sub-Arc
                  </label>
                </>
              )}

              <label className="inline-flex items-center gap-1.5">
                <span>Rolling Context (câu cuối):</span>
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={hybridCfg.rolling_context_lines}
                  onChange={(e) =>
                    setHybridCfg({
                      ...hybridCfg,
                      rolling_context_lines: Math.max(
                        0,
                        Number(e.target.value) || 0,
                      ),
                    })
                  }
                  className="w-14 px-2 py-0.5 rounded border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-center"
                />
              </label>
            </>
          )}
        </div>
      </div>

      {/* Main Split: Chapter List (left 7 cols) + Real-time SSE Terminal (right 5 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Chapter Status Table */}
        <section className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-xs">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="font-semibold text-sm text-slate-900 dark:text-zinc-100">
              Danh sách Chương ({chapters.length})
            </div>
            {statusData && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                  Xong: {statusData.counts.completed}
                </span>
                <span className="text-rose-600 dark:text-rose-400 font-medium">
                  Blocked: {statusData.counts.blocked}
                </span>
                <span className="text-amber-600 dark:text-amber-400 font-medium">
                  Lỗi: {statusData.counts.failed}
                </span>
              </div>
            )}
          </div>

          <div className="divide-y divide-slate-100 dark:divide-zinc-800 max-h-[560px] overflow-y-auto">
            {chapters.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-400">
                Tập này chưa có chương nào. Hãy nhập tệp `.epub`/`.txt`/`.docx`
                ở Quản lý Truyện hoặc Thuật ngữ.
              </div>
            ) : (
              chapters.map((ch) => {
                const stMeta =
                  CHAPTER_STATUS_META[ch.status] ?? CHAPTER_STATUS_META.pending
                const isRetryingThis = retranslatingId === ch.id
                return (
                  <div
                    key={ch.id}
                    className={`p-3.5 space-y-2 transition-colors ${
                      ch.status === 'blocked'
                        ? 'bg-rose-50/40 dark:bg-rose-500/5'
                        : 'hover:bg-slate-50/60 dark:hover:bg-zinc-800/30'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-bold text-slate-500">
                          #{ch.chapter_index}
                        </span>
                        <span className="font-semibold text-sm text-slate-900 dark:text-zinc-100 truncate max-w-[260px]">
                          {ch.title || `Chương ${ch.chapter_index}`}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${stMeta.badgeClass}`}
                        >
                          {stMeta.label}
                        </span>
                        {ch.has_mask && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                            Đã che nhạy cảm
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {ch.status === 'blocked' && (
                          <button
                            type="button"
                            onClick={() => setMaskChapter(ch)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white cursor-pointer"
                          >
                            <ShieldAlert className="w-3.5 h-3.5" />
                            Xử lý nhạy cảm (Scan & Mask)
                          </button>
                        )}

                        {ch.status !== 'blocked' && (
                          <button
                            type="button"
                            title="Quét / Che từ nhạy cảm"
                            onClick={() => setMaskChapter(ch)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                          >
                            <ShieldAlert className="w-3.5 h-3.5" />
                          </button>
                        )}

                        <button
                          type="button"
                          title="Xem Debug Context"
                          onClick={() => setDebugChapter(ch)}
                          className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
                        >
                          <Bug className="w-3.5 h-3.5 text-indigo-500" />
                          Debug
                        </button>

                        <button
                          type="button"
                          disabled={isRetryingThis || isRunning}
                          onClick={() => void handleRetranslateOne(ch)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 disabled:opacity-45 cursor-pointer"
                        >
                          <RotateCcw
                            className={`w-3.5 h-3.5 ${isRetryingThis ? 'animate-spin' : ''}`}
                          />
                          Dịch lại
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-zinc-400 font-mono">
                      <span>Raw: {ch.raw_chars.toLocaleString('vi-VN')}</span>
                      <span>
                        Dịch: {ch.translated_chars.toLocaleString('vi-VN')}
                      </span>
                      <span>Ratio: {ch.char_ratio.toFixed(2)}</span>
                      {ch.used_slot && <span>Slot: {ch.used_slot}</span>}
                    </div>

                    {ch.error_message && (
                      <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50/70 dark:bg-rose-500/10 rounded-lg px-2.5 py-1.5">
                        {ch.error_message}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </section>

        {/* Real-time SSE Terminal Log */}
        <section className="lg:col-span-5 rounded-2xl border border-slate-800 bg-zinc-950 text-zinc-100 overflow-hidden shadow-md">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <Terminal className="w-4 h-4 text-emerald-400" />
              <span>Terminal Log Real-time (SSE)</span>
              <span className="px-2 py-0.5 rounded-full text-[10px] bg-zinc-800 text-zinc-300 uppercase">
                {jobState}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setLogs([])}
              className="text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer"
            >
              Xóa log
            </button>
          </div>

          <div className="p-4 h-[520px] overflow-y-auto font-mono text-xs space-y-1.5 leading-relaxed">
            {logs.length === 0 ? (
              <div className="text-zinc-500">
                Chờ sự kiện dịch thuật... Bấm "Bắt đầu dịch" để theo dõi log
                trực tiếp từng chương.
              </div>
            ) : (
              logs.map((entry, idx) => {
                const color =
                  entry.level === 'success'
                    ? 'text-emerald-400'
                    : entry.level === 'warn'
                      ? 'text-amber-300'
                      : entry.level === 'error'
                        ? 'text-rose-400'
                        : 'text-zinc-300'
                return (
                  <div key={idx} className={color}>
                    <span className="text-zinc-500 mr-2">
                      [{entry.ts ?? '--:--:--'}]
                    </span>
                    <span>{entry.message}</span>
                  </div>
                )
              })
            )}
            <div ref={logEndRef} />
          </div>
        </section>
      </div>

      {/* Debug Context Modal */}
      {debugChapter && (
        <DebugContextModal
          chapter={debugChapter}
          mode={mode}
          hybridConfig={hybridCfg}
          onClose={() => setDebugChapter(null)}
        />
      )}

      {/* Scan & Mask Modal */}
      {maskChapter && (
        <SensitiveMaskModal
          chapter={maskChapter}
          seriesId={selectedSeries.id}
          mode={mode}
          temperature={temperature}
          hybridConfig={hybridCfg}
          onClose={() => setMaskChapter(null)}
          onAppliedAndRetranslated={(msg) => {
            notify(msg)
            void loadStatus()
          }}
        />
      )}
    </div>
  )
}
