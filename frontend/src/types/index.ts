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
  | 'guide'

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
    label: 'Dịch Tự Do (Freeform)',
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

// ---------- Phase 2: Import & Master Glossary ----------

export type SplitMode = 'epub_chapters' | 'chunk_chars'
export type GlossaryStatus = 'new' | 'translated' | 'approved' | 'ignored'

export const TERM_TYPES = [
  'Character',
  'Place',
  'Skill',
  'Item',
  'Title',
  'Organization',
  'Race',
  'Creature',
  'Rank',
  'Event',
  'Concept',
  'Language',
  'Currency',
] as const

export const GLOSSARY_STATUS_META: Record<
  GlossaryStatus,
  { label: string; badgeClass: string }
> = {
  new: {
    label: 'Chưa dịch',
    badgeClass:
      'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  },
  translated: {
    label: 'Đã dịch',
    badgeClass:
      'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  },
  approved: {
    label: 'Đã duyệt',
    badgeClass:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
  ignored: {
    label: 'Bỏ qua',
    badgeClass:
      'bg-slate-200 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400',
  },
}

export interface ImportedChapterItem {
  id: number
  volume_id: number
  chapter_index: number
  title: string
  char_count: number
  status: string
}

export interface VolumeImportResponse {
  volume_id: number
  filename: string
  split_mode: SplitMode
  keep_furigana: boolean
  chapters_imported: number
  total_chars: number
  chapters: ImportedChapterItem[]
}

export interface ChapterSummary {
  id: number
  volume_id: number
  chapter_index: number
  title: string
  char_count: number
  raw_chars: number
  translated_chars: number
  has_mask: boolean
  char_ratio: number
  preview: string
  status: string
  updated_at: string
}

export interface ChapterDetail {
  id: number
  volume_id: number
  chapter_index: number
  title: string
  raw_text: string
  translated_text: string
  status: string
  updated_at: string
}

export function formatVolumeLabel(vol: Volume): string {
  const label = (vol.title || '').trim()
  if (!label) return `Tập ${vol.volume_number}`
  return label
}

export interface GlossaryTerm {
  id: number
  series_id: number
  source_term: string
  normalized_key: string
  vi_term: string
  reading: string
  han_viet: string
  english_meaning: string
  term_type: string
  status: GlossaryStatus
  first_seen_vol: number
  total_freq: number
  volume_freq: number | null
}

export type GlossarySortBy =
  | 'source_term'
  | 'vi_term'
  | 'freq'
  | 'first_seen_vol'
  | 'term_type'
  | 'status'
export type SortDir = 'asc' | 'desc'
export type GlossaryDuplicateMode = 'skip' | 'upsert'

export function formatFirstSeenVol(volNum: number): string {
  return volNum <= 0 ? 'Gốc' : `Tập ${volNum}`
}

export interface GlossaryFilterCriteria {
  volume_id?: number | null
  status?: GlossaryStatus | null
  term_type?: string | null
  min_freq?: number | null
  max_freq?: number | null
  missing_vi?: boolean
  missing_han_viet?: boolean
  first_seen_vol?: number | null
  search?: string | null
}

export interface GlossaryBulkSelectionPayload {
  series_id?: number | null
  term_ids?: number[]
  apply_to_filter?: boolean
  filter?: GlossaryFilterCriteria | null
  exclude_ids?: number[]
}

export interface GlossaryListResponse {
  items: GlossaryTerm[]
  total_count: number
  total_filtered: number
  total_in_scope: number
  status_counts: Record<GlossaryStatus, number>
  distinct_first_seen_vols: number[]
}

export interface GlossaryExtractResponse {
  volume_id: number
  series_id: number
  source_lang: string
  total_extracted: number
  new_terms: number
  existing_terms: number
}

export interface GlossaryTranslateResponse {
  series_id: number
  volume_id: number | null
  total_new_found: number
  translated_count: number
  missing_count: number
  missing_terms: string[]
  batches_processed: number
  rounds_used: number
  used_slots: string[]
}

export interface GlossaryImportResponse {
  imported: number
  updated: number
  skipped: number
}

export interface GlossaryImportPreviewResponse {
  filename: string
  delimiter: string
  has_header: boolean
  headers: string[]
  suggested_mapping: Record<string, number | null>
  sample_rows: string[][]
  total_rows: number
}

// ---------- Phase 3: Continuity, Characters & Relationships ----------

export type CharacterAppearance = 'ACTUAL' | 'MENTIONED'

export const COMMON_PRONOUN_PAIRS = [
  'Tôi-Cậu',
  'Anh-Em',
  'Em-Anh',
  'Ta-Ngươi',
  'Ta-Nhóc',
  'Con-Cha',
  'Con-Mẹ',
  'Cha-Con',
  'Mẹ-Con',
  'Em-Sư phụ',
  'Ta-Con',
  'Chị-Em',
  'Em-Chị',
  'Cháu-Bác',
  'Cô-Cháu',
  'Tôi-Chị',
  'Tôi-Anh',
  'Tôi-Cô',
  'Ta-Cô',
  'Tôi-Cậu chủ',
  'Tại hạ-Đạo hữu',
  'Vãn bối-Tiền bối',
  'Tiền bối-Vãn bối',
  'Bản tọa-Ngươi',
] as const

export const CHARACTER_ARCHETYPES = [
  'NORMAL',
  'TSUNDERE',
  'KUUDERE',
  'ONEE',
  'GYARU',
  'SAMURAI',
  'CHUUNI',
  'NOBLE',
  'MENTOR',
  'VILLAIN',
] as const

export interface ContinuityStatus {
  volume_id: number
  series_id: number
  volume_number: number
  status: string
  total_chapters: number
  summarized_chapters: number
  characters_count: number
  relationships_total: number
  relationships_needs_review: number
  relationships_locked: number
  relationships_missing_reverse: number
  volume_summary: string
  rtas_baseline: number
  rtas_current_avg: number
  rtas_drift: string
}

export interface MapPhaseResponse {
  volume_id: number
  total_chapters: number
  processed_chapters: number
  skipped_cached: number
  used_slots: string[]
}

export interface ReducePhaseResponse {
  volume_id: number
  series_id: number
  chapters_reduced: number
  actual_characters: number
  mentioned_characters: number
  relationships_added: number
  relationships_updated: number
  locked_preserved: number
  missing_reverse_created: number
  sub_arc_updated: number
  volume_summary: string
  rtas_current_avg: number
  rtas_drift: string
  used_slot: string | null
}

export interface CharacterWithState {
  id: number
  series_id: number
  canonical_name: string
  display_name: string
  aliases: string[]
  archetype: string
  default_pair: string
  rtas_baseline: number
  appearance: CharacterAppearance
  subarc: string
  current_state: string
  state_notes: string
  in_volume: boolean
}

export interface RelationshipItem {
  id: number
  series_id: number
  source_char_id: number
  target_char_id: number
  source_name: string
  source_canonical: string
  target_name: string
  target_canonical: string
  pair_pronoun: string
  rtas_score: number
  notes: string
  evidence_quote: string
  needs_review: boolean
  is_locked: boolean
  is_missing_reverse: boolean
  last_updated_vol: number
}

// ---------- Phase 4: Translation Engine & Sensitive Masks ----------

export type ChapterStatus =
  | 'pending'
  | 'summarized'
  | 'translating'
  | 'completed'
  | 'failed'
  | 'blocked'

export const CHAPTER_STATUS_META: Record<
  ChapterStatus,
  { label: string; badgeClass: string }
> = {
  pending: {
    label: 'Chờ dịch',
    badgeClass:
      'bg-slate-100 text-slate-700 dark:bg-zinc-800 dark:text-zinc-300',
  },
  summarized: {
    label: 'Đã MAP',
    badgeClass:
      'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  },
  translating: {
    label: 'Đang dịch...',
    badgeClass:
      'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300 animate-pulse',
  },
  completed: {
    label: 'Hoàn thành',
    badgeClass:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
  blocked: {
    label: 'Bị chặn (Blocked)',
    badgeClass:
      'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300 font-semibold',
  },
  failed: {
    label: 'Lỗi (Failed)',
    badgeClass:
      'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  },
}

export interface TranslateChapterRow {
  id: number
  volume_id: number
  chapter_index: number
  title: string
  raw_chars: number
  translated_chars: number
  has_mask: boolean
  status: ChapterStatus
  used_slot: string | null
  char_ratio: number
  error_message: string | null
  updated_at: string
}

export interface TranslateLogEvent {
  type: string
  ts?: string
  level?: 'info' | 'warn' | 'error' | 'success'
  message?: string
  chapter_id?: number
  chapter_index?: number
  status?: ChapterStatus
  char_ratio?: number
  used_slot?: string | null
  error_message?: string | null
  state?: string
  done_in_run?: number
  total_targets?: number
}

export interface TranslateStatusResponse {
  volume_id: number
  series_id: number
  job_state: string
  total_targets: number
  done_in_run: number
  current_chapter_index: number | null
  counts: {
    total: number
    pending: number
    translating: number
    completed: number
    blocked: number
    failed: number
  }
  chapters: TranslateChapterRow[]
  recent_logs: TranslateLogEvent[]
}

export interface DebugContextResponse {
  chapter_id: number
  chapter_index: number
  chapter_title: string
  mode: string
  using_masked_text: boolean
  source_char_count: number
  system_instruction_length: number
  system_instruction_preview: string
  user_prompt: string
  rolling_context: string
  matched_characters: Array<{
    id: number
    canonical_name: string
    display_name: string
    matched_aliases: string[]
  }>
  matched_relationships: Array<{
    source_name: string
    target_name: string
    pair_pronoun: string
  }>
  matched_glossary: Array<{
    source_term: string
    vi_term: string
    term_type: string
  }>
  ignored_shared_parts: string[]
}

export type MaskSourceLang = 'all' | 'ja' | 'zh' | 'ko'

export interface SensitiveMaskItem {
  id: number
  series_id: number | null
  source_lang: string
  raw_phrase: string
  safe_replacement: string
  created_at: string
}

export interface SensitiveMaskBulkImportResponse {
  imported: number
  updated: number
  skipped: number
  invalid_lines: string[]
}

export interface SensitiveSuggestion {
  raw_phrase: string
  safe_replacement: string
  reason: string
}

export interface SensitiveScanResponse {
  chapter_id: number
  series_id: number
  suggestions: SensitiveSuggestion[]
  existing_masks: SensitiveMaskItem[]
  used_slot: string
}

export interface ApplyMasksResponse {
  chapter_id: number
  masked_raw_text: string | null
  applied_count: number
  applied_masks: Array<{
    raw_phrase: string
    safe_replacement: string
    occurrences: number
  }>
  saved_masks_count: number
}

// ---------- Phase 5: Proofreading & Publication Export ----------

export interface GlossaryHighlightItem {
  id: number
  source_term: string
  vi_term: string
  reading: string
  han_viet: string
  english_meaning: string
  term_type: string
  status: string
}

export interface ChapterProofreadData {
  id: number
  volume_id: number
  series_id: number
  chapter_index: number
  title: string
  raw_text: string
  source_html?: string
  masked_raw_text: string | null
  translated_text: string
  status: ChapterStatus
  used_slot: string | null
  char_ratio: number
  error_message: string | null
  updated_at: string
  glossary_highlights: GlossaryHighlightItem[]
}

export interface FindReplaceResponse {
  volume_id: number
  dry_run: boolean
  use_regex: boolean
  case_sensitive: boolean
  total_matches: number
  chapters_affected: number
  affected_chapters: Array<{
    chapter_id: number
    chapter_index: number
    title: string
    matches: number
    sample_snippet: string
  }>
}

export interface RetranslateSelectionResponse {
  chapter_id: number
  original_selection: string
  retranslated_text: string
  used_slot: string
}

// ---------- Batch C: Task Models & LN-VN Reference Packs ----------

export type TaskModelKey =
  | 'glossary_translate'
  | 'continuity_map'
  | 'continuity_reduce'
  | 'translate_main'
  | 'sensitive_scan'
  | 'proofread_retranslate'

export interface TaskModelAssignment {
  primary: string
  fallbacks: string[]
}

export interface TaskModelsResponse {
  tasks: Record<TaskModelKey, TaskModelAssignment>
  available_models: string[]
}

export const TASK_MODEL_META: Array<{
  key: TaskModelKey
  label: string
  desc: string
}> = [
  {
    key: 'translate_main',
    label: 'Dịch chương chính',
    desc: 'Tác vụ trọng tâm cần văn phong tốt (gợi ý Pro → Flash)',
  },
  {
    key: 'glossary_translate',
    label: 'Dịch thuật ngữ (Glossary)',
    desc: 'Dịch batch 300–400 từ JSON có đối soát (gợi ý Flash)',
  },
  {
    key: 'continuity_map',
    label: 'Tóm tắt từng chương (MAP)',
    desc: 'Chạy qua từng chương để trích xuất xưng hô (gợi ý Flash-Lite)',
  },
  {
    key: 'continuity_reduce',
    label: 'Tổng hợp Tập (REDUCE)',
    desc: '1 request/tập tổng hợp RTAS & Sub-Arc (gợi ý Flash → Pro)',
  },
  {
    key: 'sensitive_scan',
    label: 'Quét từ nhạy cảm (Scan)',
    desc: 'Tìm cụm từ kích hoạt safety filter (gợi ý Flash-Lite)',
  },
  {
    key: 'proofread_retranslate',
    label: 'Dịch lại đoạn bôi đen',
    desc: 'Trau chuốt đoạn nhỏ trong Hiệu đính (gợi ý Flash → Pro)',
  },
]

export interface ReferenceFileItem {
  id: number
  pack_name: string
  filename: string
  size_bytes: number
  estimated_tokens: number
  use_in_summary: boolean
  use_in_translate: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface ReferenceFileDetail extends ReferenceFileItem {
  content: string
}

// ---------- Batch D: Model Discovery, Live Probe & Web Translation ----------

export interface DiscoveredModelItem {
  id: string
  display_name: string
  description: string
  input_token_limit: number | null
  output_token_limit: number | null
}

export interface ModelDiscoverResponse {
  key_used: string
  models: DiscoveredModelItem[]
}

export interface ModelTestResponse {
  ok: boolean
  model: string
  key_used: string
  latency_ms: number
  reply_preview: string
  error: string | null
}

export interface WebPromptResponse {
  chapter_id: number
  chapter_index: number
  chapter_title: string
  mode: string
  system_instruction: string
  user_prompt: string
  combined_prompt: string
  protected_images: string[]
  using_masked_text: boolean
  pre_masked_count: number
  source_chars: number
  estimated_tokens: number
}

export interface WebImportTranslationResponse {
  chapter_id: number
  chapter_index: number
  status: string
  char_ratio: number
  translated_chars: number
  restored_images_count: number
  missing_images_count: number
}
