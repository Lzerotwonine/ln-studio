import {
  Activity,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Cpu,
  Edit3,
  FileCode2,
  FlaskConical,
  KeyRound,
  Palette,
  Plus,
  Radar,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ReferencePacksManager } from '../components/ReferencePacksManager'
import { SensitiveMasksManager } from '../components/SensitiveMasksManager'
import {
  type AppearanceSettings,
  DEFAULT_APPEARANCE,
  FONT_PRESETS,
  FONT_SCALE_OPTIONS,
  THEME_PRESETS,
} from '../lib/appearance'
import {
  createApiKey,
  createPreset,
  deleteApiKey,
  deletePreset,
  discoverLiveModels,
  extractErrorMessage,
  fetchApiKeys,
  fetchModelConfig,
  fetchPresets,
  fetchQuotaStatus,
  fetchTaskModels,
  resetQuota,
  seedDefaultPresets,
  testLiveModel,
  updateApiKey,
  updateModelConfig,
  updatePreset,
  updateTaskModels,
} from '../lib/api'
import type {
  ApiKeyItem,
  DiscoveredModelItem,
  ModelLimitItem,
  ModelTestResponse,
  PresetSourceLang,
  PromptPreset,
  PromptPresetPayload,
  QuotaSlot,
  QuotaSlotState,
  QuotaSummary,
  Series,
  TaskModelAssignment,
  TaskModelKey,
  TranslationMode,
} from '../types'
import { MODE_META, TASK_MODEL_META } from '../types'

type SettingsTab =
  | 'appearance'
  | 'keys'
  | 'models'
  | 'quota'
  | 'presets'
  | 'masks'
  | 'references'

const SUGGESTED_MODELS = [
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
]

const QUOTA_BADGE: Record<QuotaSlotState, { label: string; cls: string }> = {
  ready: {
    label: 'Sẵn sàng',
    cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
  cooldown: {
    label: 'Tạm nghỉ',
    cls: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  },
  daily_exhausted: {
    label: 'Hết hạn ngày',
    cls: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  },
  session_disabled: {
    label: 'Tạm khóa phiên',
    cls: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
  },
}

const PRESET_LANG_LABELS: Record<PresetSourceLang, string> = {
  ja: 'Tiếng Nhật',
  zh: 'Tiếng Trung',
  ko: 'Tiếng Hàn',
  any: 'Đa ngôn ngữ',
}

interface SettingsPageProps {
  selectedSeries?: Series | null
  appearance: AppearanceSettings
  onChangeAppearance: (next: AppearanceSettings) => void
}

export function SettingsPage({
  selectedSeries = null,
  appearance,
  onChangeAppearance,
}: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  // API keys state
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([])
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyValue, setNewKeyValue] = useState('')
  const [addingKey, setAddingKey] = useState(false)

  // Models state
  const [models, setModels] = useState<string[]>([])
  const [modelLimits, setModelLimits] = useState<
    Record<string, ModelLimitItem>
  >({})
  const [newModelInput, setNewModelInput] = useState('')
  const [savingModels, setSavingModels] = useState(false)
  const [discoveringModels, setDiscoveringModels] = useState(false)
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModelItem[]>([])
  const [discoveredByKey, setDiscoveredByKey] = useState<string | null>(null)
  const [testingModelId, setTestingModelId] = useState<string | null>(null)
  const [modelTestResults, setModelTestResults] = useState<
    Record<string, ModelTestResponse>
  >({})
  const [taskModels, setTaskModels] = useState<
    Record<TaskModelKey, TaskModelAssignment>
  >({
    glossary_translate: {
      primary: 'gemini-flash-latest',
      fallbacks: ['gemini-flash-lite-latest', 'gemini-2.5-flash'],
    },
    continuity_map: {
      primary: 'gemini-flash-lite-latest',
      fallbacks: ['gemini-flash-latest', 'gemini-2.5-flash-lite'],
    },
    continuity_reduce: {
      primary: 'gemini-flash-latest',
      fallbacks: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    },
    translate_main: {
      primary: 'gemini-2.5-pro',
      fallbacks: ['gemini-flash-latest', 'gemini-2.5-flash'],
    },
    sensitive_scan: {
      primary: 'gemini-flash-lite-latest',
      fallbacks: ['gemini-flash-latest'],
    },
    proofread_retranslate: {
      primary: 'gemini-flash-latest',
      fallbacks: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    },
  })
  const [savingTaskModels, setSavingTaskModels] = useState(false)

  // Quota state
  const [quotaSlots, setQuotaSlots] = useState<QuotaSlot[]>([])
  const [quotaSummary, setQuotaSummary] = useState<QuotaSummary>({
    total: 0,
    active: 0,
    ready: 0,
    cooldown: 0,
    daily_exhausted: 0,
    session_disabled: 0,
  })
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [loadingQuota, setLoadingQuota] = useState(false)

  // Presets state
  const [presets, setPresets] = useState<PromptPreset[]>([])
  const [presetModalOpen, setPresetModalOpen] = useState(false)
  const [editingPreset, setEditingPreset] = useState<PromptPreset | null>(null)
  const [presetForm, setPresetForm] = useState<PromptPresetPayload>({
    name: '',
    source_lang: 'ja',
    mode: 'ln_vn',
    content: '',
  })
  const [savingPreset, setSavingPreset] = useState(false)

  const notify = (msg: string) => {
    setToastMsg(msg)
    window.setTimeout(() => {
      setToastMsg((curr) => (curr === msg ? null : curr))
    }, 3200)
  }

  const refreshQuota = useCallback(async () => {
    setLoadingQuota(true)
    try {
      const data = await fetchQuotaStatus()
      setQuotaSlots(data.slots)
      setQuotaSummary(data.summary)
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setLoadingQuota(false)
    }
  }, [])

  const loadAll = useCallback(async () => {
    setErrorMsg(null)
    try {
      const [keysData, modelsData, taskModelsData, quotaData, presetsData] =
        await Promise.all([
          fetchApiKeys(),
          fetchModelConfig(),
          fetchTaskModels(),
          fetchQuotaStatus(),
          fetchPresets(),
        ])
      setApiKeys(keysData)
      setModels(modelsData.models)
      setModelLimits(modelsData.model_limits)
      if (taskModelsData?.tasks) {
        setTaskModels(taskModelsData.tasks)
      }
      setQuotaSlots(quotaData.slots)
      setQuotaSummary(quotaData.summary)
      setPresets(presetsData)
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  // Real-time polling when on Quota tab
  useEffect(() => {
    if (activeTab !== 'quota' || !autoRefresh) return
    const timer = window.setInterval(() => {
      void refreshQuota()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [activeTab, autoRefresh, refreshQuota])

  // ---------- API Key Handlers ----------

  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newKeyName.trim() || !newKeyValue.trim()) return
    setAddingKey(true)
    setErrorMsg(null)
    try {
      const created = await createApiKey({
        name: newKeyName.trim(),
        api_key: newKeyValue.trim(),
        is_active: true,
      })
      setApiKeys((prev) => [...prev, created])
      setNewKeyName('')
      setNewKeyValue('')
      notify(`Đã thêm API Key "${created.name}".`)
      void refreshQuota()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setAddingKey(false)
    }
  }

  const handleToggleKey = async (item: ApiKeyItem) => {
    setErrorMsg(null)
    try {
      const updated = await updateApiKey(item.id, {
        is_active: !item.is_active,
      })
      setApiKeys((prev) =>
        prev.map((k) => (k.id === updated.id ? updated : k)),
      )
      notify(
        `API Key "${updated.name}" đã chuyển sang ${updated.is_active ? 'Hoạt động' : 'Tạm tắt'}.`,
      )
      void refreshQuota()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleDeleteKey = async (item: ApiKeyItem) => {
    if (!window.confirm(`Xóa API Key "${item.name}"?`)) return
    setErrorMsg(null)
    try {
      await deleteApiKey(item.id)
      setApiKeys((prev) => prev.filter((k) => k.id !== item.id))
      notify(`Đã xóa API Key "${item.name}".`)
      void refreshQuota()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  // ---------- Model Config Handlers ----------

  const handleAddModel = (candidate?: string) => {
    const cleaned = (candidate ?? newModelInput).trim()
    if (!cleaned) return
    if (models.includes(cleaned)) {
      notify(`Model "${cleaned}" đã có trong danh sách.`)
      return
    }
    setModels((prev) => [...prev, cleaned])
    setModelLimits((prev) => ({
      ...prev,
      [cleaned]: prev[cleaned] ?? prev.default ?? { rpm: 10, rpd: 250 },
    }))
    if (!candidate) setNewModelInput('')
  }

  const moveModel = (index: number, delta: -1 | 1) => {
    const nextIdx = index + delta
    if (nextIdx < 0 || nextIdx >= models.length) return
    const copy = [...models]
    const [picked] = copy.splice(index, 1)
    copy.splice(nextIdx, 0, picked)
    setModels(copy)
  }

  const removeModel = (modelId: string) => {
    setModels((prev) => prev.filter((m) => m !== modelId))
  }

  const updateModelLimitField = (
    modelId: string,
    field: 'rpm' | 'rpd',
    value: number,
  ) => {
    setModelLimits((prev) => ({
      ...prev,
      [modelId]: {
        ...(prev[modelId] ?? { rpm: 10, rpd: 250 }),
        [field]: Math.max(1, value || 1),
      },
    }))
  }

  const handleSaveModels = async () => {
    const cleaned = models.map((m) => m.trim()).filter(Boolean)
    if (cleaned.length === 0) {
      setErrorMsg('Cần ít nhất một model trong danh sách ưu tiên.')
      return
    }
    setSavingModels(true)
    setErrorMsg(null)
    try {
      const saved = await updateModelConfig({
        models: cleaned,
        model_limits: modelLimits,
      })
      setModels(saved.models)
      setModelLimits(saved.model_limits)
      notify('Đã lưu thứ tự ưu tiên model và giới hạn tham chiếu.')
      void refreshQuota()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setSavingModels(false)
    }
  }

  const handleSaveTaskModels = async () => {
    setSavingTaskModels(true)
    setErrorMsg(null)
    try {
      const saved = await updateTaskModels(taskModels)
      setTaskModels(saved.tasks)
      notify('Đã lưu cấu hình phân bổ Model theo 6 tác vụ.')
      void refreshQuota()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setSavingTaskModels(false)
    }
  }

  const handleDiscoverModels = async () => {
    setDiscoveringModels(true)
    setErrorMsg(null)
    try {
      const res = await discoverLiveModels()
      setDiscoveredModels(res.models)
      setDiscoveredByKey(res.key_used)
      notify(
        `Đã tải ${res.models.length} model gọi được từ Gemini API (qua key ${res.key_used}).`,
      )
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setDiscoveringModels(false)
    }
  }

  const handleTestModel = async (modelId: string) => {
    const trimmed = modelId.trim()
    if (!trimmed) return
    setTestingModelId(trimmed)
    setErrorMsg(null)
    try {
      const res = await testLiveModel(trimmed)
      setModelTestResults((prev) => ({ ...prev, [trimmed]: res }))
      if (res.ok) {
        notify(
          `Model ${trimmed} hoạt động tốt (${res.latency_ms}ms qua ${res.key_used}).`,
        )
      }
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setTestingModelId(null)
    }
  }

  const applyTaskPreset = (preset: 'economy' | 'quality') => {
    if (preset === 'economy') {
      setTaskModels({
        translate_main: {
          primary: 'gemini-flash-latest',
          fallbacks: ['gemini-2.5-flash', 'gemini-flash-lite-latest'],
        },
        glossary_translate: {
          primary: 'gemini-flash-lite-latest',
          fallbacks: ['gemini-flash-latest'],
        },
        continuity_map: {
          primary: 'gemini-flash-lite-latest',
          fallbacks: ['gemini-flash-latest'],
        },
        continuity_reduce: {
          primary: 'gemini-flash-latest',
          fallbacks: ['gemini-flash-lite-latest'],
        },
        sensitive_scan: {
          primary: 'gemini-flash-lite-latest',
          fallbacks: ['gemini-flash-latest'],
        },
        proofread_retranslate: {
          primary: 'gemini-flash-latest',
          fallbacks: ['gemini-2.5-flash'],
        },
      })
    } else {
      setTaskModels({
        translate_main: {
          primary: 'gemini-2.5-pro',
          fallbacks: ['gemini-flash-latest', 'gemini-2.5-flash'],
        },
        glossary_translate: {
          primary: 'gemini-flash-latest',
          fallbacks: ['gemini-2.5-pro'],
        },
        continuity_map: {
          primary: 'gemini-flash-latest',
          fallbacks: ['gemini-flash-lite-latest'],
        },
        continuity_reduce: {
          primary: 'gemini-2.5-pro',
          fallbacks: ['gemini-flash-latest'],
        },
        sensitive_scan: {
          primary: 'gemini-flash-latest',
          fallbacks: ['gemini-flash-lite-latest'],
        },
        proofread_retranslate: {
          primary: 'gemini-2.5-pro',
          fallbacks: ['gemini-flash-latest'],
        },
      })
    }
  }

  // ---------- Quota Handlers ----------

  const handleResetQuota = async (slotId?: string) => {
    setErrorMsg(null)
    try {
      await resetQuota(slotId)
      await refreshQuota()
      notify(
        slotId
          ? `Đã reset quota cho slot ${slotId}.`
          : 'Đã reset toàn bộ bảng trạng thái Quota.',
      )
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  // ---------- Preset Handlers ----------

  const openCreatePreset = () => {
    setEditingPreset(null)
    setPresetForm({
      name: '',
      source_lang: 'ja',
      mode: 'freeform',
      content: '',
    })
    setPresetModalOpen(true)
  }

  const openEditPreset = (preset: PromptPreset) => {
    setEditingPreset(preset)
    setPresetForm({
      name: preset.name,
      source_lang: preset.source_lang,
      mode: preset.mode,
      content: preset.content,
    })
    setPresetModalOpen(true)
  }

  const handleSavePreset = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!presetForm.name.trim() || !presetForm.content.trim()) return
    setSavingPreset(true)
    setErrorMsg(null)
    try {
      if (editingPreset) {
        const updated = await updatePreset(editingPreset.id, presetForm)
        setPresets((prev) =>
          prev.map((p) => (p.id === updated.id ? updated : p)),
        )
        notify(`Đã cập nhật preset "${updated.name}".`)
      } else {
        const created = await createPreset(presetForm)
        setPresets((prev) => [...prev, created])
        notify(`Đã tạo preset "${created.name}".`)
      }
      setPresetModalOpen(false)
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setSavingPreset(false)
    }
  }

  const handleDeletePreset = async (preset: PromptPreset) => {
    if (!window.confirm(`Xóa Prompt Preset "${preset.name}"?`)) return
    setErrorMsg(null)
    try {
      await deletePreset(preset.id)
      setPresets((prev) => prev.filter((p) => p.id !== preset.id))
      notify(`Đã xóa preset "${preset.name}".`)
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleRestoreDefaults = async () => {
    setErrorMsg(null)
    try {
      const res = await seedDefaultPresets()
      setPresets(res.presets)
      notify(
        res.inserted > 0
          ? `Đã khôi phục ${res.inserted} preset mặc định.`
          : 'Tất cả 4 preset mặc định đều đã tồn tại.',
      )
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const tabs: Array<{ id: SettingsTab; label: string; icon: typeof KeyRound }> =
    [
      { id: 'appearance', label: 'Giao diện hiển thị', icon: Palette },
      { id: 'keys', label: 'Khóa API', icon: KeyRound },
      { id: 'models', label: 'Model ưu tiên', icon: Cpu },
      { id: 'quota', label: 'Hạn mức gọi API', icon: Activity },
      { id: 'presets', label: 'Mẫu lệnh dịch', icon: Sparkles },
      { id: 'masks', label: 'Kho từ nhạy cảm', icon: ShieldAlert },
      { id: 'references', label: 'Tài liệu tham chiếu', icon: FileCode2 },
    ]

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
          Cài đặt
        </h2>
        <p className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">
          Tùy chỉnh giao diện đọc, xoay vòng khóa API, phân bổ Model AI, mẫu
          lệnh dịch và tài liệu tham chiếu.
        </p>
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

      {/* Tabs */}
      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 dark:border-zinc-800 pb-3">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
                active
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
              {tab.id === 'quota' && quotaSummary.active > 0 && (
                <span
                  className={`text-[11px] px-1.5 py-0.5 rounded-full ${
                    active
                      ? 'bg-white/20 text-white'
                      : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300'
                  }`}
                >
                  {quotaSummary.ready}/{quotaSummary.active}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* TAB 0: APPEARANCE (GIAO DIỆN HIỂN THỊ) */}
      {activeTab === 'appearance' && (
        <div className="space-y-6">
          {/* Theme Presets */}
          <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 sm:p-6 space-y-4 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                  Bộ màu nền
                </h3>
                <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                  Chọn bảng màu dịu mắt cho quá trình dịch và hiệu đính dài. Tự
                  động lưu trên trình duyệt.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  onChangeAppearance({ ...DEFAULT_APPEARANCE })
                  notify('Đã khôi phục cài đặt giao diện mặc định.')
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Khôi phục mặc định
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              {THEME_PRESETS.map((preset) => {
                const active = appearance.themePreset === preset.id
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() =>
                      onChangeAppearance({
                        ...appearance,
                        themePreset: preset.id,
                      })
                    }
                    className={`text-left p-3.5 rounded-xl border transition-all cursor-pointer space-y-2.5 ${
                      active
                        ? 'border-indigo-600 ring-2 ring-indigo-500/25 bg-indigo-50/40 dark:bg-indigo-500/10'
                        : 'border-slate-200 dark:border-zinc-700 hover:border-indigo-400'
                    }`}
                  >
                    <div
                      className="h-12 rounded-lg border p-2 flex items-center justify-between"
                      style={{
                        backgroundColor: preset.swatchBg,
                        borderColor: preset.isDark ? '#27272a' : '#cbd5e1',
                      }}
                    >
                      <div
                        className="h-7 w-14 rounded-md px-1.5 flex items-center text-[10px] font-bold"
                        style={{
                          backgroundColor: preset.swatchSurface,
                          color: preset.swatchText,
                        }}
                      >
                        Aa
                      </div>
                      <span
                        className="w-5 h-5 rounded-full"
                        style={{ backgroundColor: preset.swatchAccent }}
                      />
                    </div>
                    <div>
                      <div className="font-semibold text-sm text-slate-900 dark:text-zinc-100">
                        {preset.label}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-zinc-400 leading-snug mt-0.5">
                        {preset.desc}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Font + Font Scale + Density + Icon Size */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Font Presets */}
            <div className="lg:col-span-6 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 sm:p-6 space-y-4 shadow-xs">
              <div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                  Phông chữ hiển thị
                </h3>
                <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                  Áp dụng ngay trên toàn ứng dụng và khung soạn thảo bản dịch.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {FONT_PRESETS.map((fp) => {
                  const active = appearance.fontPreset === fp.id
                  return (
                    <button
                      key={fp.id}
                      type="button"
                      onClick={() =>
                        onChangeAppearance({
                          ...appearance,
                          fontPreset: fp.id,
                        })
                      }
                      className={`text-left p-3.5 rounded-xl border cursor-pointer transition-colors ${
                        active
                          ? 'border-indigo-600 bg-indigo-50/50 dark:bg-indigo-500/10'
                          : 'border-slate-200 dark:border-zinc-700 hover:border-indigo-400'
                      }`}
                    >
                      <div
                        className="text-sm font-bold text-slate-900 dark:text-zinc-100"
                        style={{ fontFamily: fp.previewFamily }}
                      >
                        {fp.label} — Tiếng Việt
                      </div>
                      <div className="text-xs text-slate-500 dark:text-zinc-400 mt-1">
                        {fp.desc}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Scale + Density + Icons */}
            <div className="lg:col-span-6 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 sm:p-6 space-y-5 shadow-xs">
              <div className="space-y-2">
                <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                  Cỡ chữ giao diện
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {FONT_SCALE_OPTIONS.map((opt) => {
                    const active = appearance.fontScale === opt.value
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() =>
                          onChangeAppearance({
                            ...appearance,
                            fontScale: opt.value,
                          })
                        }
                        className={`px-3 py-2 rounded-xl text-xs font-semibold border cursor-pointer transition-colors ${
                          active
                            ? 'border-indigo-600 bg-indigo-600 text-white'
                            : 'border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800'
                        }`}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                    Mật độ bố cục
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        ['comfortable', 'Thoáng'],
                        ['compact', 'Gọn'],
                      ] as const
                    ).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() =>
                          onChangeAppearance({ ...appearance, density: val })
                        }
                        className={`px-3 py-2 rounded-xl text-xs font-semibold border cursor-pointer ${
                          appearance.density === val
                            ? 'border-indigo-600 bg-indigo-600 text-white'
                            : 'border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                    Kích thước biểu tượng
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        ['normal', 'Vừa'],
                        ['large', 'Lớn'],
                      ] as const
                    ).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() =>
                          onChangeAppearance({ ...appearance, iconScale: val })
                        }
                        className={`px-3 py-2 rounded-xl text-xs font-semibold border cursor-pointer ${
                          appearance.iconScale === val
                            ? 'border-indigo-600 bg-indigo-600 text-white'
                            : 'border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-950/60 p-4 space-y-1.5">
                <div className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                  Xem thử trực tiếp
                </div>
                <p className="text-sm text-slate-800 dark:text-zinc-200 leading-relaxed">
                  “Ánh bình minh dần lan qua những mái ngói cổ kính của vương đô,
                  báo hiệu một chương mới sắp mở ra.”
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 1: API KEYS */}
      {activeTab === 'keys' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleAddKey}
            className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4 shadow-xs"
          >
            <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
              Thêm khóa API Gemini mới
            </h3>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                Tên gợi nhớ *
              </label>
              <input
                type="text"
                required
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="VD: API_KEY_1, KEY_PHU..."
                className="w-full px-3.5 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                Google Gemini API Key *
              </label>
              <input
                type="password"
                required
                value={newKeyValue}
                onChange={(e) => setNewKeyValue(e.target.value)}
                placeholder="AIzaSy..."
                className="w-full px-3.5 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 font-mono"
              />
            </div>
            <button
              type="submit"
              disabled={addingKey}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              {addingKey ? 'Đang thêm...' : 'Thêm vào xoay vòng API'}
            </button>
          </form>

          <div className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-xs">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                Danh sách khóa API ({apiKeys.length})
              </h3>
              <span className="text-xs text-slate-500 dark:text-zinc-400">
                Đang bật: {apiKeys.filter((k) => k.is_active).length}
              </span>
            </div>

            {apiKeys.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500 dark:text-zinc-400">
                Chưa có khóa API nào. Thêm ít nhất 1 khóa để bắt đầu gọi AI.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-zinc-800">
                {apiKeys.map((item) => (
                  <div
                    key={item.id}
                    className="px-5 py-3.5 flex items-center justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-slate-900 dark:text-zinc-100">
                          {item.name}
                        </span>
                        <span
                          className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                            item.is_active
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                              : 'bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400'
                          }`}
                        >
                          {item.is_active ? 'Đang bật' : 'Tạm tắt'}
                        </span>
                      </div>
                      <div className="text-xs font-mono text-slate-500 dark:text-zinc-400 mt-0.5">
                        {item.masked_key}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => void handleToggleKey(item)}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
                      >
                        {item.is_active ? 'Tắt' : 'Bật'}
                      </button>
                      <button
                        type="button"
                        title="Xóa API Key"
                        onClick={() => void handleDeleteKey(item)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10 cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: MODELS */}
      {activeTab === 'models' && (
        <div className="space-y-6">
        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                Thứ tự ưu tiên Model (Failover)
              </h3>
              <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                Pool sẽ xoay vòng toàn bộ API Key ở model ưu tiên #1 trước khi
                fallback xuống model tiếp theo. Chuỗi rỗng tự động bị loại bỏ.
              </p>
            </div>
            <button
              type="button"
              disabled={savingModels}
              onClick={() => void handleSaveModels()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white cursor-pointer"
            >
              <Save className="w-4 h-4" />
              {savingModels ? 'Đang lưu...' : 'Lưu cấu hình'}
            </button>
          </div>

          {/* Add model bar + Live API Discover */}
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={newModelInput}
              onChange={(e) => setNewModelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAddModel()
                }
              }}
              placeholder="Gõ tự do mã model bất kỳ (VD: gemini-flash-latest, gemini-3.1-pro-preview, gemini-4-...)..."
              className="flex-1 min-w-[240px] px-3.5 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 font-mono"
            />
            <button
              type="button"
              onClick={() => handleAddModel()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
            >
              <Plus className="w-4 h-4" /> Thêm model
            </button>
            <button
              type="button"
              disabled={!newModelInput.trim() || testingModelId === newModelInput.trim()}
              onClick={() => void handleTestModel(newModelInput.trim())}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/70 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 disabled:opacity-45 cursor-pointer"
            >
              <FlaskConical className="w-3.5 h-3.5" />
              {testingModelId === newModelInput.trim() ? 'Đang thử...' : 'Thử gọi model'}
            </button>
            <button
              type="button"
              disabled={discoveringModels}
              onClick={() => void handleDiscoverModels()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/70 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 disabled:opacity-50 cursor-pointer"
            >
              <Radar className={`w-3.5 h-3.5 ${discoveringModels ? 'animate-spin' : ''}`} />
              {discoveringModels ? 'Đang quét API...' : 'Tải danh sách model từ API'}
            </button>
          </div>

          {newModelInput.trim() && modelTestResults[newModelInput.trim()] && (
            <div
              className={`px-3 py-2 rounded-xl text-xs flex items-center gap-2 ${
                modelTestResults[newModelInput.trim()].ok
                  ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/30'
                  : 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-500/30'
              }`}
            >
              {modelTestResults[newModelInput.trim()].ok ? (
                <>
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>
                    <strong>{newModelInput.trim()}</strong> hoạt động tốt ({modelTestResults[newModelInput.trim()].latency_ms}ms · phản hồi: &ldquo;{modelTestResults[newModelInput.trim()].reply_preview}&rdquo;)
                  </span>
                </>
              ) : (
                <>
                  <XCircle className="w-4 h-4 shrink-0" />
                  <span className="break-all">
                    <strong>{newModelInput.trim()}</strong> lỗi: {modelTestResults[newModelInput.trim()].error}
                  </span>
                </>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-slate-500 dark:text-zinc-400">Đề xuất:</span>
            {SUGGESTED_MODELS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => handleAddModel(m)}
                className="px-2.5 py-1 rounded-lg font-mono border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 hover:border-indigo-400 cursor-pointer"
              >
                + {m}
              </button>
            ))}
          </div>

          {/* Live Discovered Models from API */}
          {discoveredModels.length > 0 && (
            <div className="rounded-xl border border-indigo-200/80 dark:border-indigo-500/30 bg-indigo-50/35 dark:bg-indigo-500/5 p-4 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <div className="font-semibold text-indigo-800 dark:text-indigo-300">
                  Model thực tế khả dụng qua API ({discoveredModels.length} model · key {discoveredByKey})
                </div>
                <button
                  type="button"
                  onClick={() => setDiscoveredModels([])}
                  className="text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  Ẩn
                </button>
              </div>
              <div className="max-h-52 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2">
                {discoveredModels.map((dm) => {
                  const tRes = modelTestResults[dm.id]
                  const isAdded = models.includes(dm.id)
                  return (
                    <div
                      key={dm.id}
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-mono font-semibold text-slate-900 dark:text-zinc-100 truncate">
                          {dm.id}
                        </div>
                        <div className="text-[10px] text-slate-500 dark:text-zinc-400 truncate">
                          {dm.display_name}
                          {dm.input_token_limit
                            ? ` · in ${(dm.input_token_limit / 1000).toFixed(0)}k`
                            : ''}
                          {tRes && (
                            <span
                              className={`ml-1.5 font-semibold ${
                                tRes.ok ? 'text-emerald-600' : 'text-rose-600'
                              }`}
                            >
                              {tRes.ok ? `✓ ${tRes.latency_ms}ms` : '✗ Lỗi'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={testingModelId === dm.id}
                          onClick={() => void handleTestModel(dm.id)}
                          className="px-2 py-1 rounded-md border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 text-[11px] cursor-pointer"
                        >
                          {testingModelId === dm.id ? '...' : 'Thử'}
                        </button>
                        <button
                          type="button"
                          disabled={isAdded}
                          onClick={() => handleAddModel(dm.id)}
                          className="px-2 py-1 rounded-md bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-[11px] font-medium cursor-pointer"
                        >
                          {isAdded ? 'Đã có' : '+ Thêm'}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Priority list */}
          <div className="divide-y divide-slate-100 dark:divide-zinc-800 border border-slate-200 dark:border-zinc-800 rounded-xl overflow-hidden">
            {models.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-400">
                Chưa có model nào được chọn.
              </div>
            ) : (
              models.map((modelId, idx) => {
                const limit = modelLimits[modelId] ??
                  modelLimits.default ?? { rpm: 10, rpd: 250 }
                const probe = modelTestResults[modelId]
                return (
                  <div
                    key={modelId}
                    className="p-3.5 flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-zinc-900"
                  >
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="w-7 h-7 rounded-lg bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 text-xs font-bold flex items-center justify-center">
                        #{idx + 1}
                      </span>
                      <span className="font-mono text-sm font-semibold text-slate-900 dark:text-zinc-100">
                        {modelId}
                      </span>
                      {probe && (
                        <span
                          title={probe.error ?? probe.reply_preview}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                            probe.ok
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                              : 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300 max-w-[260px] truncate'
                          }`}
                        >
                          {probe.ok ? (
                            <>
                              <CheckCircle2 className="w-3 h-3 shrink-0" />
                              OK · {probe.latency_ms}ms
                            </>
                          ) : (
                            <>
                              <XCircle className="w-3 h-3 shrink-0" />
                              Lỗi: {probe.error}
                            </>
                          )}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        disabled={testingModelId === modelId}
                        onClick={() => void handleTestModel(modelId)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 text-xs font-medium cursor-pointer disabled:opacity-50"
                      >
                        <FlaskConical className="w-3.5 h-3.5 text-emerald-600" />
                        {testingModelId === modelId ? 'Đang thử...' : 'Thử gọi'}
                      </button>
                      <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-zinc-400">
                        RPM
                        <input
                          type="number"
                          min={1}
                          value={limit.rpm}
                          onChange={(e) =>
                            updateModelLimitField(
                              modelId,
                              'rpm',
                              Number(e.target.value),
                            )
                          }
                          className="w-16 px-2 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 text-xs"
                        />
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-zinc-400">
                        RPD
                        <input
                          type="number"
                          min={1}
                          value={limit.rpd}
                          onChange={(e) =>
                            updateModelLimitField(
                              modelId,
                              'rpd',
                              Number(e.target.value),
                            )
                          }
                          className="w-20 px-2 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 text-xs"
                        />
                      </label>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => moveModel(idx, -1)}
                          title="Ưu tiên cao hơn"
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 disabled:opacity-35 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === models.length - 1}
                          onClick={() => moveModel(idx, 1)}
                          title="Ưu tiên thấp hơn"
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 disabled:opacity-35 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeModel(modelId)}
                          title="Bỏ model"
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Task-based Model Routing Card */}
        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                Phân bổ Model AI theo từng Tác vụ (6 tác vụ)
              </h3>
              <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                Tránh lãng phí model nặng cho tác vụ nhẹ. Bạn vẫn có thể đổi
                nhanh model ngay trên từng tab trước khi chạy.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => applyTaskPreset('economy')}
                className="px-3 py-1.5 rounded-xl text-xs font-medium border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/70 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 cursor-pointer"
              >
                Tiết kiệm Quota
              </button>
              <button
                type="button"
                onClick={() => applyTaskPreset('quality')}
                className="px-3 py-1.5 rounded-xl text-xs font-medium border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/70 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 cursor-pointer"
              >
                Chất lượng Tối đa
              </button>
              <button
                type="button"
                disabled={savingTaskModels}
                onClick={() => void handleSaveTaskModels()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                {savingTaskModels ? 'Đang lưu...' : 'Lưu phân bổ tác vụ'}
              </button>
            </div>
          </div>

          <datalist id="ln-model-choices-datalist">
            {Array.from(
              new Set([
                ...models,
                ...SUGGESTED_MODELS,
                ...discoveredModels.map((m) => m.id),
              ]),
            ).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>

          <div className="divide-y divide-slate-100 dark:divide-zinc-800 border border-slate-200 dark:border-zinc-800 rounded-xl overflow-hidden">
            {TASK_MODEL_META.map((meta) => {
              const cfg = taskModels[meta.key] ?? {
                primary: 'gemini-flash-latest',
                fallbacks: [],
              }
              return (
                <div
                  key={meta.key}
                  className="p-3.5 grid grid-cols-1 lg:grid-cols-12 gap-3 items-center bg-white dark:bg-zinc-900"
                >
                  <div className="lg:col-span-5">
                    <div className="font-semibold text-xs text-slate-900 dark:text-zinc-100">
                      {meta.label}{' '}
                      <span className="font-mono text-[10px] text-slate-400">
                        ({meta.key})
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                      {meta.desc}
                    </div>
                  </div>

                  <div className="lg:col-span-3">
                    <label className="block text-[10px] font-semibold uppercase text-slate-400 mb-1">
                      Model ưu tiên (chọn hoặc gõ tự do)
                    </label>
                    <input
                      type="text"
                      list="ln-model-choices-datalist"
                      aria-label={`Model ưu tiên cho ${meta.key}`}
                      value={cfg.primary}
                      onChange={(e) =>
                        setTaskModels((prev) => ({
                          ...prev,
                          [meta.key]: {
                            ...cfg,
                            primary: e.target.value,
                            fallbacks: cfg.fallbacks.filter(
                              (m) => m !== e.target.value,
                            ),
                          },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 font-mono text-xs"
                    />
                  </div>

                  <div className="lg:col-span-4">
                    <label className="block text-[10px] font-semibold uppercase text-slate-400 mb-1">
                      Model dự phòng (phân tách bằng dấu phẩy)
                    </label>
                    <input
                      type="text"
                      value={cfg.fallbacks.join(', ')}
                      onChange={(e) =>
                        setTaskModels((prev) => ({
                          ...prev,
                          [meta.key]: {
                            ...cfg,
                            fallbacks: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          },
                        }))
                      }
                      placeholder="VD: gemini-flash-latest, gemini-2.5-flash"
                      className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 font-mono text-xs"
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        </div>
      )}

      {/* TAB 5: SENSITIVE MASKS */}
      {activeTab === 'masks' && (
        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 shadow-xs">
          <SensitiveMasksManager defaultSeries={selectedSeries} />
        </div>
      )}

      {/* TAB 6: LN-VN REFERENCE PACKS */}
      {activeTab === 'references' && (
        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 shadow-xs">
          <ReferencePacksManager />
        </div>
      )}

      {/* TAB 3: QUOTA REAL-TIME */}
      {activeTab === 'quota' && (
        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[
              { label: 'Lượt gọi hoạt động', value: quotaSummary.active, tone: 'text-slate-900 dark:text-zinc-100' },
              { label: 'Sẵn sàng', value: quotaSummary.ready, tone: 'text-emerald-600 dark:text-emerald-400' },
              { label: 'Đang tạm nghỉ', value: quotaSummary.cooldown, tone: 'text-amber-600 dark:text-amber-400' },
              { label: 'Hết hạn ngày', value: quotaSummary.daily_exhausted, tone: 'text-rose-600 dark:text-rose-400' },
              { label: 'Tạm khóa phiên', value: quotaSummary.session_disabled, tone: 'text-zinc-500 dark:text-zinc-400' },
            ].map((card) => (
              <div
                key={card.label}
                className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4"
              >
                <div className="text-xs text-slate-500 dark:text-zinc-400">
                  {card.label}
                </div>
                <div className={`text-2xl font-bold mt-1 ${card.tone}`}>
                  {card.value}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-xs">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                  Bảng theo dõi hạn mức gọi API
                </h3>
                <label className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-zinc-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    onChange={(e) => setAutoRefresh(e.target.checked)}
                    className="rounded border-slate-300 text-indigo-600"
                  />
                  Tự làm mới mỗi 5s
                </label>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void refreshQuota()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${loadingQuota ? 'animate-spin' : ''}`}
                  />
                  Làm mới
                </button>
                <button
                  type="button"
                  onClick={() => void handleResetQuota()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset tất cả
                </button>
              </div>
            </div>

            {quotaSlots.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500 dark:text-zinc-400">
                Chưa có slot nào. Hãy thêm ít nhất 1 API Key ở tab "API Keys".
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 dark:bg-zinc-950/60 text-xs uppercase text-slate-500 dark:text-zinc-400 border-b border-slate-200 dark:border-zinc-800">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Slot</th>
                      <th className="px-4 py-3 font-semibold">Trạng thái</th>
                      <th className="px-4 py-3 font-semibold">RPM</th>
                      <th className="px-4 py-3 font-semibold">RPD hôm nay</th>
                      <th className="px-4 py-3 font-semibold">Ngày</th>
                      <th className="px-4 py-3 font-semibold">Lỗi gần nhất</th>
                      <th className="px-4 py-3 text-right font-semibold">
                        Thao tác
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
                    {quotaSlots.map((slot) => {
                      const badge = QUOTA_BADGE[slot.status]
                      return (
                        <tr
                          key={slot.slot_id}
                          className={
                            slot.is_active_slot
                              ? ''
                              : 'opacity-55 bg-slate-50/50 dark:bg-zinc-950/30'
                          }
                        >
                          <td className="px-4 py-3 font-mono text-xs">
                            <div className="font-semibold text-slate-900 dark:text-zinc-100">
                              {slot.key_name}
                            </div>
                            <div className="text-slate-500 dark:text-zinc-400">
                              {slot.model_id}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${badge.cls}`}
                            >
                              {badge.label}
                              {slot.status === 'cooldown' &&
                              slot.cooldown_remaining_sec > 0
                                ? ` (${Math.ceil(slot.cooldown_remaining_sec)}s)`
                                : ''}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs font-mono">
                            {slot.rpm_used} / {slot.rpm_limit}
                          </td>
                          <td className="px-4 py-3 text-xs font-mono">
                            {slot.requests_today} / {slot.rpd_limit}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-500 dark:text-zinc-400">
                            {slot.quota_date}
                          </td>
                          <td className="px-4 py-3 text-xs text-rose-600 dark:text-rose-400 max-w-xs truncate">
                            {slot.last_error || '—'}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              type="button"
                              onClick={() =>
                                void handleResetQuota(slot.slot_id)
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
                            >
                              <RotateCcw className="w-3 h-3" /> Reset
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: PROMPT PRESETS */}
      {activeTab === 'presets' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                Danh sách Prompt Presets ({presets.length})
              </h3>
              <p className="text-xs text-slate-500 dark:text-zinc-400">
                Nạp sẵn 4 preset mặc định (LN-VN Nhật chuẩn, Nhật Tự Do
                (Freeform), Tiên hiệp/Huyền huyễn Trung, Hunter/Hệ thống Hàn).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleRestoreDefaults()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Khôi phục 4 mặc định
              </button>
              <button
                type="button"
                onClick={openCreatePreset}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"
              >
                <Plus className="w-4 h-4" /> Thêm Preset mới
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {presets.map((preset) => (
              <div
                key={preset.id}
                className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 flex flex-col justify-between gap-3 shadow-xs"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="font-semibold text-sm text-slate-900 dark:text-zinc-100">
                      {preset.name}
                    </h4>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEditPreset(preset)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeletePreset(preset)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10 cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <span className="px-2 py-0.5 text-[11px] font-medium rounded-md bg-slate-100 text-slate-700 dark:bg-zinc-800 dark:text-zinc-300">
                      {PRESET_LANG_LABELS[preset.source_lang]}
                    </span>
                    <span
                      className={`px-2 py-0.5 text-[11px] font-medium rounded-md border ${MODE_META[preset.mode].badgeClass}`}
                    >
                      {MODE_META[preset.mode].label}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-zinc-400 whitespace-pre-wrap leading-relaxed line-clamp-5">
                    {preset.content}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Preset Modal */}
      {presetModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 dark:text-zinc-100">
                {editingPreset
                  ? 'Chỉnh sửa Prompt Preset'
                  : 'Tạo Prompt Preset mới'}
              </h3>
              <button
                type="button"
                onClick={() => setPresetModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSavePreset} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                  Tên Preset *
                </label>
                <input
                  type="text"
                  required
                  value={presetForm.name}
                  onChange={(e) =>
                    setPresetForm({ ...presetForm, name: e.target.value })
                  }
                  className="w-full px-3.5 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Ngôn ngữ
                  </label>
                  <select
                    value={presetForm.source_lang}
                    onChange={(e) =>
                      setPresetForm({
                        ...presetForm,
                        source_lang: e.target.value as PresetSourceLang,
                      })
                    }
                    className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  >
                    <option value="ja">Nhật (JA)</option>
                    <option value="zh">Trung (ZH)</option>
                    <option value="ko">Hàn (KO)</option>
                    <option value="any">Đa ngôn ngữ (Any)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Chế độ
                  </label>
                  <select
                    value={presetForm.mode}
                    onChange={(e) =>
                      setPresetForm({
                        ...presetForm,
                        mode: e.target.value as TranslationMode,
                      })
                    }
                    className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  >
                    <option value="ln_vn">LN-VN Chuẩn</option>
                    <option value="freeform">Dịch Tự Do (Freeform)</option>
                    <option value="hybrid">Hybrid</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                  Nội dung Prompt *
                </label>
                <textarea
                  rows={7}
                  required
                  value={presetForm.content}
                  onChange={(e) =>
                    setPresetForm({ ...presetForm, content: e.target.value })
                  }
                  className="w-full px-3.5 py-2.5 text-sm rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => setPresetModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={savingPreset}
                  className="px-5 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white cursor-pointer"
                >
                  {savingPreset ? 'Đang lưu...' : 'Lưu Preset'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
