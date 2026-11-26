export type SourceLang = 'ja' | 'zh' | 'ko'
export type PresetSourceLang = SourceLang | 'any'
export type TranslationMode = 'ln_vn' | 'freeform' | 'hybrid'
export type VolumeStatus =
  | 'imported'
  | 'glossary_done'
  | 'continuity_done'
  | 'translating'
  | 'completed'

export type NavSection =
  | 'dashboard'
  | 'glossary'
  | 'characters'
  | 'translate'
  | 'proofread'
  | 'settings'

export interface HybridConfig {
  use_glossary: boolean
  use_characters: boolean
  use_relationships: boolean
  use_subarc: boolean
  rolling_context_lines: number
}

export interface Series {
  id: number
  title: string
  source_lang: SourceLang
  translation_mode: TranslationMode
  system_prompt: string
  master_prompt_file: string
  hybrid_config: HybridConfig
  hybrid_config_json: string
  created_at: string
  volume_count: number
}

export interface SeriesPayload {
  title: string
  source_lang: SourceLang
  translation_mode: TranslationMode
  system_prompt: string
  master_prompt_file: string
  hybrid_config: HybridConfig
}

export interface Volume {
  id: number
  series_id: number
  volume_number: number
  title: string
  volume_summary: string
  rtas_baseline: number
  rtas_current_avg: number
  rtas_drift: string
  status: VolumeStatus
  created_at: string
}

export interface VolumePayload {
  volume_number: number
  title: string
  volume_summary: string
  rtas_baseline: number
  status?: VolumeStatus
}

export interface ApiKeyItem {
  id: number
  name: string
  masked_key: string
  is_active: boolean
}

export interface ModelLimitItem {
  rpm: number
  rpd: number
}

export interface ModelConfig {
  models: string[]
  model_limits: Record<string, ModelLimitItem>
}

export type QuotaSlotState =
  | 'ready'
  | 'cooldown'
  | 'daily_exhausted'
  | 'session_disabled'

export interface QuotaSlot {
  slot_id: string
  key_name: string
  model_id: string
  requests_today: number
  quota_date: string
  last_request_ts: number
  cooldown_until: number
  cooldown_remaining_sec: number
  is_daily_exhausted: boolean
  is_session_disabled: boolean
  rpm_used: number
  rpm_limit: number
  rpd_limit: number
  status: QuotaSlotState
  is_active_slot: boolean
  last_error: string | null
}

export interface QuotaSummary {
  total: number
  active: number
  ready: number
  cooldown: number
  daily_exhausted: number
  session_disabled: number
}

export interface QuotaStatusResponse {
  slots: QuotaSlot[]
  summary: QuotaSummary
}

export interface PromptPreset {
  id: number
  name: string
  source_lang: PresetSourceLang
  mode: TranslationMode
  content: string
}

export interface PromptPresetPayload {
  name: string
  source_lang: PresetSourceLang
  mode: TranslationMode
  content: string
}

export interface HealthInfo {
  status: string
  db_path: string
  journal_mode: string
  foreign_keys: string
}

export const LANG_META: Record<
  SourceLang,
  { label: string; short: string; badgeClass: string }
> = {
  ja: {
    label: 'Tiếng Nhật (JA)',
    short: 'JA',
    badgeClass:
      'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30',
  },
  zh: {
    label: 'Tiếng Trung (ZH)',
    short: 'ZH',
    badgeClass:
      'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
  },
  ko: {
    label: 'Tiếng Hàn (KO)',
    short: 'KO',
    badgeClass:
      'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30',
  },
}

export const MODE_META: Record<
  TranslationMode,
  { label: string; desc: string; badgeClass: string }
> = {
  ln_vn: {
    label: 'LN-VN Chuẩn',
    desc: 'Quy trình chuẩn hóa đầy đủ XML Master Prompt + Continuity Pack',
    badgeClass:
      'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-500/30',
  },
  freeform: {
    label: 'Freeform / Aiko',
    desc: 'Dịch tự do linh hoạt theo System Prompt tùy chỉnh',
    badgeClass:
      'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30',
  },
  hybrid: {
    label: 'Hybrid',
    desc: 'Kết hợp System Prompt tự do với Glossary, Roster & Quan hệ chọn lọc',
    badgeClass:
      'bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/30',
  },
}

export const VOLUME_STATUS_META: Record<
  VolumeStatus,
  { label: string; badgeClass: string }
> = {
  imported: {
    label: 'Đã nhập raw',
    badgeClass:
      'bg-slate-100 text-slate-700 dark:bg-zinc-800 dark:text-zinc-300',
  },
  glossary_done: {
    label: 'Xong thuật ngữ',
    badgeClass:
      'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  },
  continuity_done: {
    label: 'Xong Continuity',
    badgeClass:
      'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  },
  translating: {
    label: 'Đang dịch',
    badgeClass:
      'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  },
  completed: {
    label: 'Hoàn thành',
    badgeClass:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
}
