import axios from 'axios'
import type {
  ApiKeyItem,
  ApplyMasksResponse,
  ChapterDetail,
  ChapterProofreadData,
  ChapterSummary,
  CharacterAppearance,
  CharacterWithState,
  ContinuityStatus,
  DebugContextResponse,
  FindReplaceResponse,
  GlossaryExtractResponse,
  GlossaryImportResponse,
  GlossaryListResponse,
  GlossaryStatus,
  GlossaryTerm,
  GlossaryTranslateResponse,
  HealthInfo,
  HybridConfig,
  MapPhaseResponse,
  ModelConfig,
  PromptPreset,
  PromptPresetPayload,
  QuotaStatusResponse,
  ReducePhaseResponse,
  RelationshipItem,
  RetranslateSelectionResponse,
  SensitiveMaskItem,
  SensitiveScanResponse,
  Series,
  SeriesPayload,
  SplitMode,
  TranslateStatusResponse,
  TranslationMode,
  Volume,
  VolumeImportResponse,
  VolumePayload,
} from '../types'

const baseURL = import.meta.env.VITE_API_BASE_URL || ''

export const http = axios.create({
  baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
})

export function extractErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail) && detail.length > 0) {
      const first = detail[0] as { msg?: string }
      if (first?.msg) return first.msg
    }
    return err.message || 'Lỗi kết nối máy chủ.'
  }
  if (err instanceof Error) return err.message
  return 'Đã xảy ra lỗi không xác định.'
}

// ---------- Health ----------

export async function fetchHealth(): Promise<HealthInfo> {
  const { data } = await http.get<HealthInfo>('/api/health')
  return data
}

// ---------- Series & Volumes ----------

export async function fetchSeriesList(): Promise<Series[]> {
  const { data } = await http.get<Series[]>('/api/series')
  return data
}

export async function createSeries(payload: SeriesPayload): Promise<Series> {
  const { data } = await http.post<Series>('/api/series', payload)
  return data
}

export async function updateSeries(
  id: number,
  payload: Partial<SeriesPayload>,
): Promise<Series> {
  const { data } = await http.put<Series>(`/api/series/${id}`, payload)
  return data
}

export async function deleteSeries(id: number): Promise<void> {
  await http.delete(`/api/series/${id}`)
}

export async function fetchVolumes(seriesId: number): Promise<Volume[]> {
  const { data } = await http.get<Volume[]>(`/api/series/${seriesId}/volumes`)
  return data
}

export async function createVolume(
  seriesId: number,
  payload: VolumePayload,
): Promise<Volume> {
  const { data } = await http.post<Volume>(
    `/api/series/${seriesId}/volumes`,
    payload,
  )
  return data
}

export async function updateVolume(
  volumeId: number,
  payload: Partial<VolumePayload>,
): Promise<Volume> {
  const { data } = await http.put<Volume>(`/api/volumes/${volumeId}`, payload)
  return data
}

export async function deleteVolume(volumeId: number): Promise<void> {
  await http.delete(`/api/volumes/${volumeId}`)
}

// ---------- Settings: API Keys ----------

export async function fetchApiKeys(): Promise<ApiKeyItem[]> {
  const { data } = await http.get<ApiKeyItem[]>('/api/settings/api-keys')
  return data
}

export async function createApiKey(payload: {
  name: string
  api_key: string
  is_active?: boolean
}): Promise<ApiKeyItem> {
  const { data } = await http.post<ApiKeyItem>('/api/settings/api-keys', payload)
  return data
}

export async function updateApiKey(
  id: number,
  payload: { name?: string; api_key?: string; is_active?: boolean },
): Promise<ApiKeyItem> {
  const { data } = await http.patch<ApiKeyItem>(
    `/api/settings/api-keys/${id}`,
    payload,
  )
  return data
}

export async function deleteApiKey(id: number): Promise<void> {
  await http.delete(`/api/settings/api-keys/${id}`)
}

// ---------- Settings: Models ----------

export async function fetchModelConfig(): Promise<ModelConfig> {
  const { data } = await http.get<ModelConfig>('/api/settings/models')
  return data
}

export async function updateModelConfig(
  payload: Partial<ModelConfig> & { models: string[] },
): Promise<ModelConfig> {
  const { data } = await http.put<ModelConfig>('/api/settings/models', payload)
  return data
}

// ---------- Settings: Quota ----------

export async function fetchQuotaStatus(): Promise<QuotaStatusResponse> {
  const { data } = await http.get<QuotaStatusResponse>('/api/settings/quota')
  return data
}

export async function resetQuota(slotId?: string): Promise<void> {
  await http.post('/api/settings/quota/reset', {
    slot_id: slotId ?? null,
  })
}

// ---------- Prompt Presets ----------

export async function fetchPresets(): Promise<PromptPreset[]> {
  const { data } = await http.get<PromptPreset[]>('/api/presets')
  return data
}

export async function createPreset(
  payload: PromptPresetPayload,
): Promise<PromptPreset> {
  const { data } = await http.post<PromptPreset>('/api/presets', payload)
  return data
}

export async function updatePreset(
  id: number,
  payload: Partial<PromptPresetPayload>,
): Promise<PromptPreset> {
  const { data } = await http.put<PromptPreset>(`/api/presets/${id}`, payload)
  return data
}

export async function deletePreset(id: number): Promise<void> {
  await http.delete(`/api/presets/${id}`)
}

export async function seedDefaultPresets(): Promise<{
  inserted: number
  presets: PromptPreset[]
}> {
  const { data } = await http.post<{
    inserted: number
    presets: PromptPreset[]
  }>('/api/presets/seed-defaults')
  return data
}

// ---------- Phase 2: Chapters & Book Import ----------

export async function importVolumeBook(
  volumeId: number,
  file: File,
  options: {
    split_mode: SplitMode
    keep_furigana: boolean
    chunk_min?: number
    chunk_max?: number
    replace_existing?: boolean
  },
): Promise<VolumeImportResponse> {
  const form = new FormData()
  form.append('file', file)
  form.append('split_mode', options.split_mode)
  form.append('keep_furigana', String(options.keep_furigana))
  form.append('chunk_min', String(options.chunk_min ?? 4000))
  form.append('chunk_max', String(options.chunk_max ?? 5000))
  form.append('replace_existing', String(options.replace_existing ?? true))

  const { data } = await http.post<VolumeImportResponse>(
    `/api/volumes/${volumeId}/import`,
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  )
  return data
}

export async function fetchVolumeChapters(
  volumeId: number,
): Promise<ChapterSummary[]> {
  const { data } = await http.get<ChapterSummary[]>(
    `/api/volumes/${volumeId}/chapters`,
  )
  return data
}

export async function fetchChapterDetail(
  chapterId: number,
): Promise<ChapterDetail> {
  const { data } = await http.get<ChapterDetail>(`/api/chapters/${chapterId}`)
  return data
}

export async function createManualChapter(
  volumeId: number,
  payload: {
    title?: string
    raw_text: string
    insert_after_index?: number | null
  },
): Promise<ChapterSummary> {
  const { data } = await http.post<ChapterSummary>(
    `/api/volumes/${volumeId}/chapters`,
    payload,
  )
  return data
}

export async function updateChapter(
  chapterId: number,
  payload: { title?: string; raw_text?: string },
): Promise<ChapterSummary> {
  const { data } = await http.patch<ChapterSummary>(
    `/api/chapters/${chapterId}`,
    payload,
  )
  return data
}

export async function deleteSingleChapter(
  chapterId: number,
): Promise<{ deleted_chapter_id: number; remaining_chapters: number }> {
  const { data } = await http.delete<{
    deleted_chapter_id: number
    remaining_chapters: number
  }>(`/api/chapters/${chapterId}`)
  return data
}

export async function mergeChapterNext(chapterId: number): Promise<{
  merged_chapter_id: number
  deleted_chapter_id: number
  chapter_index: number
  title: string
  raw_chars: number
  total_chapters: number
}> {
  const { data } = await http.post(`/api/chapters/${chapterId}/merge-next`)
  return data
}

export async function splitChapterAtOffset(
  chapterId: number,
  payload: { split_offset: number; second_title?: string },
): Promise<{
  first_chapter_id: number
  second_chapter_id: number
  first_chapter_index: number
  second_chapter_index: number
  total_chapters: number
}> {
  const { data } = await http.post(`/api/chapters/${chapterId}/split`, payload)
  return data
}

// ---------- Phase 2: Master Glossary ----------

export async function extractVolumeGlossary(
  volumeId: number,
  minFreq = 1,
): Promise<GlossaryExtractResponse> {
  const { data } = await http.post<GlossaryExtractResponse>(
    `/api/volumes/${volumeId}/glossary/extract`,
    { min_freq: minFreq },
  )
  return data
}

export async function translateNewGlossaryTerms(
  seriesId: number,
  options?: {
    volume_id?: number | null
    batch_size?: number
    max_rounds?: number
    model_override?: string | null
  },
): Promise<GlossaryTranslateResponse> {
  const { data } = await http.post<GlossaryTranslateResponse>(
    `/api/series/${seriesId}/glossary/translate-new`,
    {
      volume_id: options?.volume_id ?? null,
      batch_size: options?.batch_size ?? 400,
      max_rounds: options?.max_rounds ?? 3,
      model_override: options?.model_override || null,
    },
  )
  return data
}

export async function fetchGlossary(
  seriesId: number,
  params?: {
    volume_id?: number | null
    status?: GlossaryStatus | null
    term_type?: string | null
    min_freq?: number | null
    max_freq?: number | null
    missing_vi?: boolean
    missing_han_viet?: boolean
    first_seen_vol?: number | null
    search?: string
    sort_by?: import('../types').GlossarySortBy
    sort_dir?: import('../types').SortDir
    limit?: number
    offset?: number
  },
): Promise<GlossaryListResponse> {
  const query: Record<string, string | number | boolean> = {}
  if (params?.volume_id) query.volume_id = params.volume_id
  if (params?.status) query.status = params.status
  if (params?.term_type) query.term_type = params.term_type
  if (params?.min_freq && params.min_freq > 1) query.min_freq = params.min_freq
  if (params?.max_freq && params.max_freq >= 1) query.max_freq = params.max_freq
  if (params?.missing_vi) query.missing_vi = true
  if (params?.missing_han_viet) query.missing_han_viet = true
  if (
    params?.first_seen_vol !== undefined &&
    params?.first_seen_vol !== null
  ) {
    query.first_seen_vol = params.first_seen_vol
  }
  if (params?.search?.trim()) query.search = params.search.trim()
  if (params?.sort_by) query.sort_by = params.sort_by
  if (params?.sort_dir) query.sort_dir = params.sort_dir
  if (params?.limit !== undefined) query.limit = params.limit
  if (params?.offset && params.offset > 0) query.offset = params.offset

  const { data } = await http.get<GlossaryListResponse>(
    `/api/series/${seriesId}/glossary`,
    { params: query },
  )
  return data
}

export async function createGlossaryTerm(
  seriesId: number,
  payload: {
    source_term: string
    vi_term?: string
    reading?: string
    han_viet?: string
    english_meaning?: string
    term_type?: string
    status?: GlossaryStatus
    first_seen_vol?: number
  },
): Promise<GlossaryTerm> {
  const { data } = await http.post<GlossaryTerm>(
    `/api/series/${seriesId}/glossary`,
    payload,
  )
  return data
}

export async function updateGlossaryTerm(
  termId: number,
  payload: Partial<
    Pick<
      GlossaryTerm,
      | 'vi_term'
      | 'reading'
      | 'han_viet'
      | 'english_meaning'
      | 'term_type'
      | 'status'
    >
  >,
): Promise<GlossaryTerm> {
  const { data } = await http.patch<GlossaryTerm>(
    `/api/glossary/${termId}`,
    payload,
  )
  return data
}

export async function deleteGlossaryTerm(termId: number): Promise<void> {
  await http.delete(`/api/glossary/${termId}`)
}

export async function bulkUpdateGlossaryStatus(
  selection: import('../types').GlossaryBulkSelectionPayload,
  status: GlossaryStatus,
): Promise<{ updated: number }> {
  const { data } = await http.post<{ updated: number }>(
    '/api/glossary/bulk-status',
    { ...selection, status },
  )
  return data
}

export async function bulkUpdateGlossaryType(
  selection: import('../types').GlossaryBulkSelectionPayload,
  termType: string,
): Promise<{ updated: number }> {
  const { data } = await http.post<{ updated: number }>(
    '/api/glossary/bulk-type',
    { ...selection, term_type: termType },
  )
  return data
}

export async function bulkDeleteGlossaryTerms(
  selection: import('../types').GlossaryBulkSelectionPayload,
): Promise<{ deleted: number }> {
  const { data } = await http.post<{ deleted: number }>(
    '/api/glossary/bulk-delete',
    selection,
  )
  return data
}

export async function translateSelectedGlossaryTerms(
  seriesId: number,
  payload: {
    term_ids?: number[]
    apply_to_filter?: boolean
    filter?: import('../types').GlossaryFilterCriteria | null
    exclude_ids?: number[]
    batch_size?: number
    max_rounds?: number
    model_override?: string | null
  },
): Promise<GlossaryTranslateResponse> {
  const { data } = await http.post<GlossaryTranslateResponse>(
    `/api/series/${seriesId}/glossary/translate-selected`,
    {
      term_ids: payload.term_ids ?? [],
      apply_to_filter: payload.apply_to_filter ?? false,
      filter: payload.filter ?? null,
      exclude_ids: payload.exclude_ids ?? [],
      batch_size: payload.batch_size ?? 400,
      max_rounds: payload.max_rounds ?? 3,
      model_override: payload.model_override || null,
    },
  )
  return data
}

export async function importGlossaryFile(
  seriesId: number,
  file: File,
  options?: {
    default_status?: GlossaryStatus
    duplicate_mode?: import('../types').GlossaryDuplicateMode
    default_first_seen_vol?: number
    force_default_status?: boolean
  },
): Promise<GlossaryImportResponse> {
  const form = new FormData()
  form.append('file', file)
  form.append('default_status', options?.default_status ?? 'approved')
  form.append('duplicate_mode', options?.duplicate_mode ?? 'upsert')
  form.append(
    'default_first_seen_vol',
    String(options?.default_first_seen_vol ?? 0),
  )
  form.append(
    'force_default_status',
    String(options?.force_default_status ?? true),
  )
  const { data } = await http.post<GlossaryImportResponse>(
    `/api/series/${seriesId}/glossary/import`,
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  )
  return data
}

export function getGlossaryExportUrl(
  seriesId: number,
  fmt: 'tsv' | 'csv',
  filter?: import('../types').GlossaryFilterCriteria | null,
): string {
  const sp = new URLSearchParams({ format: fmt })
  if (filter?.volume_id) sp.set('volume_id', String(filter.volume_id))
  if (filter?.status) sp.set('status', filter.status)
  if (filter?.term_type) sp.set('term_type', filter.term_type)
  if (filter?.min_freq && filter.min_freq > 1) {
    sp.set('min_freq', String(filter.min_freq))
  }
  if (filter?.max_freq && filter.max_freq >= 1) {
    sp.set('max_freq', String(filter.max_freq))
  }
  if (filter?.missing_vi) sp.set('missing_vi', 'true')
  if (filter?.missing_han_viet) sp.set('missing_han_viet', 'true')
  if (
    filter?.first_seen_vol !== undefined &&
    filter?.first_seen_vol !== null
  ) {
    sp.set('first_seen_vol', String(filter.first_seen_vol))
  }
  if (filter?.search?.trim()) sp.set('search', filter.search.trim())
  return `${baseURL}/api/series/${seriesId}/glossary/export?${sp.toString()}`
}

// ---------- Phase 3: Continuity, Characters & Relationships ----------

export async function fetchContinuityStatus(
  volumeId: number,
): Promise<ContinuityStatus> {
  const { data } = await http.get<ContinuityStatus>(
    `/api/volumes/${volumeId}/continuity/status`,
  )
  return data
}

export async function runMapPhaseApi(
  volumeId: number,
  forceRerun = false,
  modelOverride?: string | null,
): Promise<MapPhaseResponse> {
  const { data } = await http.post<MapPhaseResponse>(
    `/api/volumes/${volumeId}/continuity/map`,
    { force_rerun: forceRerun, model_override: modelOverride || null },
  )
  return data
}

export async function runReducePhaseApi(
  volumeId: number,
  skipAiSummary = false,
  modelOverride?: string | null,
): Promise<ReducePhaseResponse> {
  const { data } = await http.post<ReducePhaseResponse>(
    `/api/volumes/${volumeId}/continuity/reduce`,
    { skip_ai_summary: skipAiSummary, model_override: modelOverride || null },
  )
  return data
}

export async function fetchVolumeCharacters(
  volumeId: number,
): Promise<CharacterWithState[]> {
  const { data } = await http.get<CharacterWithState[]>(
    `/api/volumes/${volumeId}/characters`,
  )
  return data
}

export async function createCharacter(
  seriesId: number,
  payload: {
    canonical_name: string
    display_name: string
    aliases: string[]
    archetype?: string
    default_pair?: string
    rtas_baseline?: number
    volume_id?: number
    appearance?: CharacterAppearance
  },
): Promise<CharacterWithState> {
  const { data } = await http.post<CharacterWithState>(
    `/api/series/${seriesId}/characters`,
    payload,
  )
  return data
}

export async function updateCharacter(
  characterId: number,
  payload: {
    canonical_name?: string
    display_name?: string
    aliases?: string[]
    archetype?: string
    default_pair?: string
    rtas_baseline?: number
  },
): Promise<void> {
  await http.patch(`/api/characters/${characterId}`, payload)
}

export async function deleteCharacter(characterId: number): Promise<void> {
  await http.delete(`/api/characters/${characterId}`)
}

export async function upsertVolumeCharacterState(
  volumeId: number,
  characterId: number,
  payload: {
    appearance?: CharacterAppearance
    subarc?: string
    current_state?: string
    notes?: string
  },
): Promise<void> {
  await http.put(
    `/api/volumes/${volumeId}/characters/${characterId}/state`,
    payload,
  )
}

export async function fetchRelationships(
  seriesId: number,
): Promise<RelationshipItem[]> {
  const { data } = await http.get<RelationshipItem[]>(
    `/api/series/${seriesId}/relationships`,
  )
  return data
}

export async function createRelationship(
  seriesId: number,
  payload: {
    source_char_id: number
    target_char_id: number
    pair_pronoun: string
    rtas_score?: number
    notes?: string
    evidence_quote?: string
    needs_review?: boolean
    is_locked?: boolean
    last_updated_vol?: number
  },
): Promise<RelationshipItem> {
  const { data } = await http.post<RelationshipItem>(
    `/api/series/${seriesId}/relationships`,
    payload,
  )
  return data
}

export async function updateRelationship(
  relId: number,
  payload: {
    pair_pronoun?: string
    rtas_score?: number
    notes?: string
    evidence_quote?: string
    needs_review?: boolean
    is_locked?: boolean
  },
): Promise<RelationshipItem> {
  const { data } = await http.patch<RelationshipItem>(
    `/api/relationships/${relId}`,
    payload,
  )
  return data
}

export async function approveRelationship(
  relId: number,
  payload: {
    pair_pronoun?: string
    notes?: string
    is_locked?: boolean
  },
): Promise<RelationshipItem> {
  const { data } = await http.post<RelationshipItem>(
    `/api/relationships/${relId}/approve`,
    payload,
  )
  return data
}

export async function deleteRelationship(relId: number): Promise<void> {
  await http.delete(`/api/relationships/${relId}`)
}

export async function fetchContinuityXml(volumeId: number): Promise<string> {
  const { data } = await http.get<string>(
    `/api/volumes/${volumeId}/continuity/xml`,
    { responseType: 'text' },
  )
  return data
}

export function getContinuityXmlDownloadUrl(volumeId: number): string {
  return `${baseURL}/api/volumes/${volumeId}/continuity/xml?download=true`
}

// ---------- Phase 4: Translation Engine & Sensitive Masks ----------

export async function fetchTranslateStatus(
  volumeId: number,
): Promise<TranslateStatusResponse> {
  const { data } = await http.get<TranslateStatusResponse>(
    `/api/volumes/${volumeId}/translate/status`,
  )
  return data
}

export async function startTranslationJob(
  volumeId: number,
  payload: {
    start_chapter?: number | null
    end_chapter?: number | null
    chapter_ids?: number[] | null
    mode?: TranslationMode
    temperature?: number
    hybrid_config?: HybridConfig
    pre_mask?: boolean
    mature_mode?: boolean
    model_override?: string | null
    only_uncompleted?: boolean
    only_failed_or_blocked?: boolean
  },
): Promise<TranslateStatusResponse> {
  const { data } = await http.post<TranslateStatusResponse>(
    `/api/volumes/${volumeId}/translate/start`,
    payload,
  )
  return data
}

export async function pauseTranslationJob(
  volumeId: number,
): Promise<TranslateStatusResponse> {
  const { data } = await http.post<TranslateStatusResponse>(
    `/api/volumes/${volumeId}/translate/pause`,
  )
  return data
}

export async function resumeTranslationJob(
  volumeId: number,
): Promise<TranslateStatusResponse> {
  const { data } = await http.post<TranslateStatusResponse>(
    `/api/volumes/${volumeId}/translate/resume`,
  )
  return data
}

export async function stopTranslationJob(
  volumeId: number,
): Promise<TranslateStatusResponse> {
  const { data } = await http.post<TranslateStatusResponse>(
    `/api/volumes/${volumeId}/translate/stop`,
  )
  return data
}

export function getTranslateEventsUrl(volumeId: number): string {
  return `${baseURL}/api/volumes/${volumeId}/translate/events`
}

export async function retranslateSingleChapter(
  chapterId: number,
  payload?: {
    mode?: TranslationMode
    temperature?: number
    hybrid_config?: HybridConfig
    pre_mask?: boolean
    mature_mode?: boolean
    model_override?: string | null
  },
): Promise<{
  chapter_id: number
  chapter_index: number
  status: string
  used_slot: string | null
  char_ratio: number
  retried_with_fiction_context: boolean
  error_message: string | null
}> {
  const { data } = await http.post(
    `/api/chapters/${chapterId}/retranslate`,
    payload ?? {},
  )
  return data
}

export async function fetchChapterDebugContext(
  chapterId: number,
  params?: {
    mode?: TranslationMode
    use_glossary?: boolean
    use_characters?: boolean
    use_relationships?: boolean
    use_subarc?: boolean
    rolling_context_lines?: number
  },
): Promise<DebugContextResponse> {
  const { data } = await http.get<DebugContextResponse>(
    `/api/chapters/${chapterId}/debug-context`,
    { params },
  )
  return data
}

export async function fetchSensitiveMasks(
  seriesId: number,
): Promise<SensitiveMaskItem[]> {
  const { data } = await http.get<SensitiveMaskItem[]>('/api/masks', {
    params: { series_id: seriesId, include_global: true },
  })
  return data
}

export async function deleteSensitiveMask(maskId: number): Promise<void> {
  await http.delete(`/api/masks/${maskId}`)
}

export async function scanChapterSensitive(
  chapterId: number,
): Promise<SensitiveScanResponse> {
  const { data } = await http.post<SensitiveScanResponse>(
    `/api/chapters/${chapterId}/scan-sensitive`,
  )
  return data
}

export async function applyChapterMasks(
  chapterId: number,
  payload: {
    extra_masks: Array<{ raw_phrase: string; safe_replacement: string }>
    save_to_db: boolean
    scope: 'series' | 'global'
    clear_mask?: boolean
  },
): Promise<ApplyMasksResponse> {
  const { data } = await http.post<ApplyMasksResponse>(
    `/api/chapters/${chapterId}/apply-masks`,
    payload,
  )
  return data
}

// ---------- Phase 5: Proofreading & Publication Export ----------

export async function fetchChapterProofread(
  chapterId: number,
): Promise<ChapterProofreadData> {
  const { data } = await http.get<ChapterProofreadData>(
    `/api/chapters/${chapterId}/proofread`,
  )
  return data
}

export async function saveChapterTranslation(
  chapterId: number,
  translatedText: string,
): Promise<{
  chapter_id: number
  status: string
  char_ratio: number
  translated_chars: number
  updated_at: string
}> {
  const { data } = await http.patch(`/api/chapters/${chapterId}/translation`, {
    translated_text: translatedText,
  })
  return data
}

export async function findReplaceVolume(
  volumeId: number,
  payload: {
    find_text: string
    replace_text: string
    use_regex: boolean
    case_sensitive: boolean
    dry_run: boolean
  },
): Promise<FindReplaceResponse> {
  const { data } = await http.post<FindReplaceResponse>(
    `/api/volumes/${volumeId}/find-replace`,
    payload,
  )
  return data
}

export async function retranslateChapterSelection(
  chapterId: number,
  payload: {
    selected_text: string
    source_side: 'raw' | 'translated'
    instruction?: string
    temperature?: number
    model_override?: string | null
  },
): Promise<RetranslateSelectionResponse> {
  const { data } = await http.post<RetranslateSelectionResponse>(
    `/api/chapters/${chapterId}/retranslate-selection`,
    payload,
  )
  return data
}

export function getVolumeDocxExportUrl(
  volumeId: number,
  font: 'Times New Roman' | 'Cambria' = 'Times New Roman',
): string {
  const sp = new URLSearchParams({ font })
  return `${baseURL}/api/volumes/${volumeId}/export/docx?${sp.toString()}`
}

export function getVolumeEpubExportUrl(volumeId: number): string {
  return `${baseURL}/api/volumes/${volumeId}/export/epub`
}

// ---------- Batch C: Task Models, Sensitive Masks Manager & Reference Packs ----------

export async function fetchTaskModels(): Promise<
  import('../types').TaskModelsResponse
> {
  const { data } = await http.get<import('../types').TaskModelsResponse>(
    '/api/settings/task-models',
  )
  return data
}

export async function updateTaskModels(
  tasks: Record<string, import('../types').TaskModelAssignment>,
): Promise<import('../types').TaskModelsResponse> {
  const { data } = await http.put<import('../types').TaskModelsResponse>(
    '/api/settings/task-models',
    { tasks },
  )
  return data
}

export async function fetchAllSensitiveMasks(params?: {
  series_id?: number | null
  include_global?: boolean
  only_global?: boolean
  source_lang?: import('../types').MaskSourceLang | null
  search?: string
}): Promise<SensitiveMaskItem[]> {
  const query: Record<string, string | number | boolean> = {}
  if (params?.series_id) query.series_id = params.series_id
  if (params?.include_global !== undefined) {
    query.include_global = params.include_global
  }
  if (params?.only_global) query.only_global = true
  if (params?.source_lang && params.source_lang !== 'all') {
    query.source_lang = params.source_lang
  }
  if (params?.search?.trim()) query.search = params.search.trim()
  const { data } = await http.get<SensitiveMaskItem[]>('/api/masks', {
    params: query,
  })
  return data
}

export async function createSensitiveMask(payload: {
  series_id: number | null
  source_lang: import('../types').MaskSourceLang
  raw_phrase: string
  safe_replacement: string
}): Promise<SensitiveMaskItem> {
  const { data } = await http.post<SensitiveMaskItem>('/api/masks', payload)
  return data
}

export async function updateSensitiveMask(
  maskId: number,
  payload: {
    source_lang?: import('../types').MaskSourceLang
    raw_phrase?: string
    safe_replacement?: string
  },
): Promise<SensitiveMaskItem> {
  const { data } = await http.patch<SensitiveMaskItem>(
    `/api/masks/${maskId}`,
    payload,
  )
  return data
}

export async function bulkImportSensitiveMasks(payload: {
  text: string
  series_id: number | null
  source_lang: import('../types').MaskSourceLang
}): Promise<import('../types').SensitiveMaskBulkImportResponse> {
  const { data } = await http.post<
    import('../types').SensitiveMaskBulkImportResponse
  >('/api/masks/bulk-import', payload)
  return data
}

export async function seedDefaultSensitiveMasks(): Promise<
  import('../types').SensitiveMaskBulkImportResponse
> {
  const { data } = await http.post<
    import('../types').SensitiveMaskBulkImportResponse
  >('/api/masks/seed-default')
  return data
}

export async function fetchReferenceFiles(): Promise<
  import('../types').ReferenceFileItem[]
> {
  const { data } = await http.get<import('../types').ReferenceFileItem[]>(
    '/api/references',
  )
  return data
}

export async function fetchReferenceFileDetail(
  refId: number,
): Promise<import('../types').ReferenceFileDetail> {
  const { data } = await http.get<import('../types').ReferenceFileDetail>(
    `/api/references/${refId}`,
  )
  return data
}

export async function uploadReferenceFile(
  file: File,
  options?: {
    pack_name?: string
    use_in_summary?: boolean
    use_in_translate?: boolean
    is_active?: boolean
  },
): Promise<import('../types').ReferenceFileItem> {
  const form = new FormData()
  form.append('file', file)
  form.append('pack_name', options?.pack_name || 'LN-VN Core')
  form.append('use_in_summary', String(options?.use_in_summary ?? false))
  form.append('use_in_translate', String(options?.use_in_translate ?? true))
  form.append('is_active', String(options?.is_active ?? true))
  const { data } = await http.post<import('../types').ReferenceFileItem>(
    '/api/references/upload',
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  )
  return data
}

export async function updateReferenceFile(
  refId: number,
  payload: {
    pack_name?: string
    use_in_summary?: boolean
    use_in_translate?: boolean
    is_active?: boolean
    content?: string
  },
): Promise<import('../types').ReferenceFileItem> {
  const { data } = await http.patch<import('../types').ReferenceFileItem>(
    `/api/references/${refId}`,
    payload,
  )
  return data
}

export async function deleteReferenceFile(refId: number): Promise<void> {
  await http.delete(`/api/references/${refId}`)
}

export async function syncReferenceFilesDisk(): Promise<{
  inserted: number
  total: number
}> {
  const { data } = await http.post<{ inserted: number; total: number }>(
    '/api/references/sync-disk',
  )
  return data
}
