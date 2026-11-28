import {
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Globe,
  Image as ImageIcon,
  Languages,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Sparkles,
  Square,
  Terminal,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DebugContextModal } from '../components/DebugContextModal'
import { SensitiveMaskModal } from '../components/SensitiveMaskModal'
import { SensitiveMasksManager } from '../components/SensitiveMasksManager'
import { TaskModelSelector } from '../components/TaskModelSelector'
import {
  buildChapterWebPrompt,
  extractErrorMessage,
  fetchTranslateStatus,
  getTranslateEventsUrl,
  importChapterWebTranslation,
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
  WebPromptResponse,
} from '../types'
import { CHAPTER_STATUS_META, MODE_META, formatVolumeLabel } from '../types'

interface TranslateTabProps {
  selectedSeries: Series | null
  selectedVolume: Volume | null
  onBackToDashboard: () => void
}

type ExecutionChannel = 'api' | 'web'

export function TranslateTab({
  selectedSeries,
  selectedVolume,
  onBackToDashboard,
}: TranslateTabProps) {
  const [execChannel, setExecChannel] = useState<ExecutionChannel>('api')
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
  const [preMask, setPreMask] = useState<boolean>(false)
  const [matureMode, setMatureMode] = useState<boolean>(false)
  const [modelOverride, setModelOverride] = useState<string>('')
  const [masksDrawerOpen, setMasksDrawerOpen] = useState<boolean>(false)
  const [hybridCfg, setHybridCfg] = useState<HybridConfig>(
    selectedSeries?.hybrid_config ?? {
      use_glossary: true,
      use_characters: true,
      use_relationships: true,
      use_subarc: false,
      rolling_context_lines: 5,
    },
  )

  // Web Translation (Gemini Web / Google AI Studio) state
  const [webChapterId, setWebChapterId] = useState<number | null>(null)
  const [webPrompt, setWebPrompt] = useState<WebPromptResponse | null>(null)
  const [webPromptLoading, setWebPromptLoading] = useState(false)
  const [webPasteText, setWebPasteText] = useState('')
  const [webSaving, setWebSaving] = useState(false)
  const [webPreviewOpen, setWebPreviewOpen] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const webPromptSeqRef = useRef(0)

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

  // Internal log scroll container refs (NEVER uses scrollIntoView so page scroll never jumps!)
  const logContainerRef = useRef<HTMLDivElement | null>(null)
  const prevLogCountRef = useRef<number>(0)
  const isNearBottomRef = useRef<boolean>(true)
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
        setWebChapterId(null)
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
          setWebChapterId((curr) => {
            if (curr && data.chapters.some((c) => c.id === curr)) return curr
            const firstPending = data.chapters.find(
              (c) => c.status !== 'completed',
            )
            return (firstPending ?? data.chapters[0]).id
          })
        } else {
          setStartChapter(1)
          setEndChapter(1)
          setWebChapterId(null)
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
    prevLogCountRef.current = 0
    isNearBottomRef.current = true
    setDebugChapter(null)
    setMaskChapter(null)
    setWebChapterId(null)
    setWebPrompt(null)
    setWebPasteText('')
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

  // Internal-only log scroll: NEVER calls scrollIntoView(), NEVER moves outer page scroll!
  const handleLogContainerScroll = () => {
    const el = logContainerRef.current
    if (!el) return
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= 48
  }

  useEffect(() => {
    const prevCount = prevLogCountRef.current
    prevLogCountRef.current = logs.length
    if (
      logs.length > prevCount &&
      prevCount > 0 &&
      isNearBottomRef.current &&
      logContainerRef.current
    ) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }, [logs])

  // Load Web Translation prompt package whenever active chapter or prompt options change in Web mode
  const loadWebPromptPackage = useCallback(
    async (targetChapterId: number | null) => {
      const seq = ++webPromptSeqRef.current
      if (!targetChapterId) {
        setWebPrompt(null)
        return
      }
      setWebPromptLoading(true)
      setErrorMsg(null)
      try {
        const res = await buildChapterWebPrompt(targetChapterId, {
          mode,
          hybrid_config: hybridCfg,
          pre_mask: preMask,
          mature_mode: matureMode,
        })
        if (seq !== webPromptSeqRef.current) return
        setWebPrompt(res)
      } catch (err) {
        if (seq !== webPromptSeqRef.current) return
        setErrorMsg(extractErrorMessage(err))
      } finally {
        if (seq === webPromptSeqRef.current) {
          setWebPromptLoading(false)
        }
      }
    },
    [mode, hybridCfg, preMask, matureMode],
  )

  useEffect(() => {
    if (execChannel !== 'web') return
    if (!webChapterId) {
      setWebPrompt(null)
      return
    }
    void loadWebPromptPackage(webChapterId)
  }, [execChannel, webChapterId, loadWebPromptPackage])

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
        pre_mask: preMask,
        mature_mode: matureMode,
        model_override: modelOverride || null,
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
        pre_mask: preMask,
        mature_mode: matureMode,
        model_override: modelOverride || null,
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

  const copyTextToClipboard = async (
    text: string,
    key: string,
    label: string,
  ) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      notify(`Đã sao chép ${label} (${text.length.toLocaleString('vi-VN')} ký tự).`)
      window.setTimeout(() => {
        setCopiedKey((curr) => (curr === key ? null : curr))
      }, 2200)
    } catch {
      setErrorMsg(
        'Trình duyệt không cho phép truy cập clipboard tự động. Bạn có thể mở "Xem gói prompt" để copy thủ công.',
      )
    }
  }

  const handleSaveWebResult = async (advanceNext: boolean) => {
    if (!webChapterId || !webPasteText.trim()) return
    setWebSaving(true)
    setErrorMsg(null)
    try {
      const res = await importChapterWebTranslation(webChapterId, {
        translated_text: webPasteText,
        protected_images: webPrompt?.protected_images ?? null,
      })
      const imgNote =
        res.restored_images_count > 0
          ? ` · khôi phục ${res.restored_images_count} ảnh`
          : ''
      notify(
        `Đã lưu Chương ${res.chapter_index} (ratio ${res.char_ratio.toFixed(2)}, ${res.translated_chars.toLocaleString('vi-VN')} ký tự${imgNote}).`,
      )
      setWebPasteText('')
      await loadStatus(false)
      if (advanceNext && statusData) {
        const list = statusData.chapters
        const curPos = list.findIndex((c) => c.id === webChapterId)
        if (curPos >= 0 && curPos + 1 < list.length) {
          setWebChapterId(list[curPos + 1].id)
        }
      }
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setWebSaving(false)
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
  const activeWebChapter =
    chapters.find((c) => c.id === webChapterId) ?? null
  const activeWebIndex = chapters.findIndex((c) => c.id === webChapterId)

  return (
    <div className="max-w-[1600px] mx-auto p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
            Dịch thuật
          </h2>
          <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 text-xs font-medium text-slate-600 dark:text-zinc-300">
            {formatVolumeLabel(selectedVolume)}
          </span>

          {/* Execution Channel Switcher: API vs Web */}
          <div className="inline-flex rounded-xl bg-slate-100 dark:bg-zinc-800 p-0.5 text-xs font-medium">
            <button
              type="button"
              onClick={() => setExecChannel('api')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                execChannel === 'api'
                  ? 'bg-white dark:bg-zinc-900 text-indigo-700 dark:text-indigo-300 shadow-xs font-semibold'
                  : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              Dịch tự động qua API
            </button>
            <button
              type="button"
              onClick={() => setExecChannel('web')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                execChannel === 'web'
                  ? 'bg-white dark:bg-zinc-900 text-emerald-700 dark:text-emerald-300 shadow-xs font-semibold'
                  : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200'
              }`}
            >
              <Globe className="w-3.5 h-3.5" />
              Dịch qua Web (Gemini / AI Studio)
            </button>
          </div>

          {execChannel === 'api' && (
            <span
              className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                sseConnected
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                  : 'bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400'
              }`}
            >
              SSE: {sseConnected ? 'Live' : 'Kết nối...'}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {execChannel === 'api' && (
            <TaskModelSelector
              taskKey="translate_main"
              value={modelOverride}
              onChange={setModelOverride}
            />
          )}
          <button
            type="button"
            onClick={() => setMasksDrawerOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <ShieldAlert className="w-3.5 h-3.5 text-rose-500" />
            Kho từ nhạy cảm
          </button>
          <button
            type="button"
            onClick={() => void loadStatus(false)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Làm mới
          </button>
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

      {/* Control Panel */}
      <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4 shadow-xs">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
          {/* Range (API mode only) */}
          {execChannel === 'api' && (
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
          )}

          {/* Mode switcher */}
          <div className={execChannel === 'api' ? 'lg:col-span-3' : 'lg:col-span-5'}>
            <label className="block text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1">
              Chế độ ngữ cảnh
            </label>
            <select
              aria-label="Chọn chế độ dịch"
              value={mode}
              onChange={(e) => setMode(e.target.value as TranslationMode)}
              className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 font-medium"
            >
              <option value="ln_vn">Chuẩn xuất bản (Ngữ cảnh đầy đủ)</option>
              <option value="freeform">Dịch tự do (Thuật ngữ gọn nhẹ)</option>
              <option value="hybrid">Tùy chọn linh hoạt (Chọn từng khối ngữ cảnh)</option>
            </select>
          </div>

          {execChannel === 'api' ? (
            <>
              {/* Temperature */}
              <div className="lg:col-span-2">
                <label className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1">
                  <span>Độ sáng tạo</span>
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
            </>
          ) : (
            <div className="lg:col-span-7 flex flex-wrap items-center justify-end gap-2">
              <a
                href="https://gemini.google.com/app"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border border-indigo-200 dark:border-indigo-500/35 bg-indigo-50/70 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Mở Gemini Web
              </a>
              <a
                href="https://aistudio.google.com/prompts/new_chat"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border border-emerald-200 dark:border-emerald-500/35 bg-emerald-50/70 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Mở Google AI Studio
              </a>
            </div>
          )}
        </div>

        {/* Context fine-tuning row */}
        <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-slate-100 dark:border-zinc-800 text-xs">
          {execChannel === 'api' && (
            <label className="inline-flex items-center gap-1.5 cursor-pointer text-slate-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={onlyUncompleted}
                onChange={(e) => setOnlyUncompleted(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600"
              />
              Bỏ qua chương đã hoàn thành
            </label>
          )}

          <label
            className="inline-flex items-center gap-1.5 cursor-pointer text-slate-700 dark:text-zinc-300"
            title="Áp dụng tự động Kho từ nhạy cảm lên bản tạm trước khi dịch (giữ nguyên bản gốc)"
          >
            <input
              type="checkbox"
              checked={preMask}
              onChange={(e) => setPreMask(e.target.checked)}
              className="rounded border-slate-300 text-amber-600"
            />
            <span>Tự che từ nhạy cảm</span>
          </label>

          <label
            className="inline-flex items-center gap-1.5 cursor-pointer text-rose-700 dark:text-rose-300 font-medium"
            title="Nới lỏng bộ lọc an toàn ở mức tối đa kèm ngữ cảnh tác phẩm văn học cho nội dung trưởng thành"
          >
            <input
              type="checkbox"
              checked={matureMode}
              onChange={(e) => setMatureMode(e.target.checked)}
              className="rounded border-rose-300 text-rose-600"
            />
            <span>Chế độ 18+</span>
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
                Thuật ngữ
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
                    Nhân vật
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
                    Diễn biến nhánh
                  </label>
                </>
              )}

              <label className="inline-flex items-center gap-1.5">
                <span>Câu nối từ chương trước:</span>
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

      {/* Main Split: Chapter List (left) + API SSE Terminal OR Web Translation Workbench (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Chapter Status Table */}
        <section
          className={`${
            execChannel === 'web' ? 'lg:col-span-5' : 'lg:col-span-7'
          } rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-xs`}
        >
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
                  Bị chặn: {statusData.counts.blocked}
                </span>
                <span className="text-amber-600 dark:text-amber-400 font-medium">
                  Lỗi: {statusData.counts.failed}
                </span>
              </div>
            )}
          </div>

          <div className="divide-y divide-slate-100 dark:divide-zinc-800 max-h-[580px] overflow-y-auto">
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
                const isWebSelected =
                  execChannel === 'web' && webChapterId === ch.id
                return (
                  <div
                    key={ch.id}
                    onClick={
                      execChannel === 'web'
                        ? () => {
                            setWebChapterId(ch.id)
                            setWebPasteText('')
                          }
                        : undefined
                    }
                    className={`p-3.5 space-y-2 transition-colors ${
                      execChannel === 'web' ? 'cursor-pointer' : ''
                    } ${
                      isWebSelected
                        ? 'bg-emerald-50/70 dark:bg-emerald-500/10 border-l-3 border-l-emerald-500'
                        : ch.status === 'blocked'
                          ? 'bg-rose-50/40 dark:bg-rose-500/5'
                          : 'hover:bg-slate-50/60 dark:hover:bg-zinc-800/30'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-bold text-slate-500">
                          #{ch.chapter_index}
                        </span>
                        <span className="font-semibold text-sm text-slate-900 dark:text-zinc-100 truncate max-w-[230px]">
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

                      <div
                        className="flex flex-wrap items-center gap-1.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {execChannel === 'api' && ch.status === 'blocked' && (
                          <button
                            type="button"
                            onClick={() => setMaskChapter(ch)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white cursor-pointer"
                          >
                            <ShieldAlert className="w-3.5 h-3.5" />
                            Xử lý nhạy cảm
                          </button>
                        )}

                        {execChannel === 'api' && ch.status !== 'blocked' && (
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
                          title="Xem ngữ cảnh gửi AI"
                          onClick={() => setDebugChapter(ch)}
                          className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
                        >
                          <Bug className="w-3.5 h-3.5 text-indigo-500" />
                          Xem ngữ cảnh
                        </button>

                        {execChannel === 'api' && (
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
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-zinc-400 font-mono">
                      <span>Gốc: {ch.raw_chars.toLocaleString('vi-VN')}</span>
                      <span>
                        Dịch: {ch.translated_chars.toLocaleString('vi-VN')}
                      </span>
                      <span>Tỷ lệ: {ch.char_ratio.toFixed(2)}</span>
                      {ch.used_slot && <span>Lượt gọi: {ch.used_slot}</span>}
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

        {/* RIGHT COLUMN: API Real-time SSE Terminal OR Web Translation Workbench */}
        {execChannel === 'api' ? (
          <section className="lg:col-span-5 rounded-2xl border border-slate-800 bg-zinc-950 text-zinc-100 overflow-hidden shadow-md">
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <Terminal className="w-4 h-4 text-emerald-400" />
                <span>Nhật ký dịch trực tiếp</span>
                <span className="px-2 py-0.5 rounded-full text-[10px] bg-zinc-800 text-zinc-300 uppercase">
                  {jobState}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  prevLogCountRef.current = 0
                  setLogs([])
                }}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer"
              >
                Xóa log
              </button>
            </div>

            <div
              ref={logContainerRef}
              onScroll={handleLogContainerScroll}
              className="p-4 h-[520px] overflow-y-auto font-mono text-xs space-y-1.5 leading-relaxed"
            >
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
            </div>
          </section>
        ) : (
          <section className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-xs">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-emerald-600 shrink-0" />
                  <h3 className="font-bold text-sm text-slate-900 dark:text-zinc-100 truncate">
                    {activeWebChapter
                      ? `Chương #${activeWebChapter.chapter_index}: ${activeWebChapter.title || `Chương ${activeWebChapter.chapter_index}`}`
                      : 'Chọn một chương bên trái để tạo gói dịch Web'}
                  </h3>
                </div>
                {webPrompt && (
                  <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-slate-500 dark:text-zinc-400 mt-1">
                    <span>
                      Nguồn: {webPrompt.source_chars.toLocaleString('vi-VN')} ký tự
                    </span>
                    <span>
                      Gói prompt: ~{webPrompt.estimated_tokens.toLocaleString('vi-VN')} tokens
                    </span>
                    {webPrompt.protected_images.length > 0 && (
                      <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 font-medium">
                        <ImageIcon className="w-3 h-3" />
                        Bảo toàn {webPrompt.protected_images.length} mã ảnh [[IMAGE_NNN]]
                      </span>
                    )}
                    {webPrompt.pre_masked_count > 0 && (
                      <span className="text-amber-600 dark:text-amber-400 font-medium">
                        Đã che {webPrompt.pre_masked_count} cụm nhạy cảm
                      </span>
                    )}
                  </div>
                )}
              </div>

              <button
                type="button"
                disabled={!webChapterId || webPromptLoading}
                onClick={() => void loadWebPromptPackage(webChapterId)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 disabled:opacity-45 cursor-pointer"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${webPromptLoading ? 'animate-spin' : ''}`}
                />
                Tạo lại gói
              </button>
            </div>

            {!activeWebChapter ? (
              <div className="p-10 text-center text-sm text-slate-400">
                Hãy chọn một chương ở danh sách bên trái để sao chép gói prompt sang Gemini Web hoặc Google AI Studio.
              </div>
            ) : (
              <div className="p-5 space-y-4">
                {/* Step 1: Copy package & Open Web UI */}
                <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-950/60 p-4 space-y-3">
                  <div className="text-xs font-semibold text-slate-700 dark:text-zinc-200">
                    Bước 1: Sao chép gói dịch (đã ghép ngữ cảnh + bảo toàn mã ảnh) và dán vào trình duyệt
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={!webPrompt || webPromptLoading}
                      onClick={() =>
                        webPrompt &&
                        void copyTextToClipboard(
                          webPrompt.combined_prompt,
                          'combined',
                          'gói dịch đầy đủ',
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-45 text-white shadow-xs cursor-pointer"
                    >
                      {copiedKey === 'combined' ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      {copiedKey === 'combined'
                        ? 'Đã sao chép!'
                        : 'Sao chép gói dịch'}
                    </button>

                    <button
                      type="button"
                      disabled={!webPrompt || webPromptLoading}
                      onClick={() =>
                        webPrompt &&
                        void copyTextToClipboard(
                          webPrompt.system_instruction,
                          'system',
                          'System Instruction (AI Studio)',
                        )
                      }
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 disabled:opacity-45 cursor-pointer"
                    >
                      {copiedKey === 'system' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      Copy System
                    </button>

                    <button
                      type="button"
                      disabled={!webPrompt || webPromptLoading}
                      onClick={() =>
                        webPrompt &&
                        void copyTextToClipboard(
                          webPrompt.user_prompt,
                          'user',
                          'User Prompt (AI Studio)',
                        )
                      }
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 disabled:opacity-45 cursor-pointer"
                    >
                      {copiedKey === 'user' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      Copy User
                    </button>

                    <button
                      type="button"
                      onClick={() => setWebPreviewOpen((o) => !o)}
                      className="inline-flex items-center gap-1 px-2.5 py-2 rounded-xl text-xs text-slate-600 dark:text-zinc-300 hover:bg-slate-200/60 dark:hover:bg-zinc-800 cursor-pointer ml-auto"
                    >
                      {webPreviewOpen ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                      Xem gói prompt
                    </button>
                  </div>

                  {webPreviewOpen && webPrompt && (
                    <pre className="p-3 rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-[11px] font-mono max-h-48 overflow-y-auto whitespace-pre-wrap text-slate-700 dark:text-zinc-300">
                      {webPrompt.combined_prompt}
                    </pre>
                  )}
                </div>

                {/* Step 2: Paste result & Save */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <label className="font-semibold text-slate-700 dark:text-zinc-200">
                      Bước 2: Dán bản dịch tiếng Việt trả về từ Gemini Web / Google AI Studio
                    </label>
                    <span className="font-mono text-[11px] text-slate-400">
                      {webPasteText.trim().length.toLocaleString('vi-VN')} ký tự
                    </span>
                  </div>
                  <textarea
                    rows={12}
                    value={webPasteText}
                    onChange={(e) => setWebPasteText(e.target.value)}
                    placeholder="Dán toàn bộ kết quả bản dịch tiếng Việt vào đây... Hệ thống sẽ tự động khôi phục các thẻ ảnh [[IMAGE_001]] và tính tỷ lệ ký tự (char_ratio)."
                    className="w-full p-3.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-sm font-serif leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <span className="text-[11px] text-slate-400">
                    {activeWebIndex >= 0 && activeWebIndex + 1 < chapters.length
                      ? `Chương kế tiếp: #${chapters[activeWebIndex + 1].chapter_index} — ${chapters[activeWebIndex + 1].title || `Chương ${chapters[activeWebIndex + 1].chapter_index}`}`
                      : 'Đây là chương cuối cùng trong tập.'}
                  </span>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={webSaving || !webPasteText.trim()}
                      onClick={() => void handleSaveWebResult(false)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 disabled:opacity-45 cursor-pointer"
                    >
                      <Save className="w-3.5 h-3.5" />
                      Lưu chương này
                    </button>
                    <button
                      type="button"
                      disabled={webSaving || !webPasteText.trim()}
                      onClick={() => void handleSaveWebResult(true)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-45 text-white shadow-xs cursor-pointer"
                    >
                      <Save className="w-3.5 h-3.5" />
                      {webSaving
                        ? 'Đang lưu...'
                        : 'Lưu kết quả & Sang chương tiếp theo'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}
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
            void loadStatus(false)
          }}
        />
      )}

      {/* Sensitive Masks Manager Modal */}
      {masksDrawerOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-4xl max-h-[88vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <span className="font-bold text-sm text-slate-900 dark:text-zinc-100">
                Quản lý Kho từ nhạy cảm
              </span>
              <button
                type="button"
                onClick={() => setMasksDrawerOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto">
              <SensitiveMasksManager defaultSeries={selectedSeries} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
