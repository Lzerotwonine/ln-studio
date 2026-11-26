import axios from 'axios'
import type {
  ApiKeyItem,
  ChapterSummary,
  CharacterAppearance,
  CharacterWithState,
  ContinuityStatus,
  GlossaryExtractResponse,
  GlossaryImportResponse,
  GlossaryListResponse,
  GlossaryStatus,
  GlossaryTerm,
  GlossaryTranslateResponse,
  HealthInfo,
  MapPhaseResponse,
  ModelConfig,
  PromptPreset,
  PromptPresetPayload,
  QuotaStatusResponse,
  ReducePhaseResponse,
  RelationshipItem,
  Series,
  SeriesPayload,
  SplitMode,
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
  },
): Promise<GlossaryTranslateResponse> {
  const { data } = await http.post<GlossaryTranslateResponse>(
    `/api/series/${seriesId}/glossary/translate-new`,
    {
      volume_id: options?.volume_id ?? null,
      batch_size: options?.batch_size ?? 400,
      max_rounds: options?.max_rounds ?? 3,
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
    min_freq?: number
    search?: string
    limit?: number
  },
): Promise<GlossaryListResponse> {
  const query: Record<string, string | number> = {}
  if (params?.volume_id) query.volume_id = params.volume_id
  if (params?.status) query.status = params.status
  if (params?.term_type) query.term_type = params.term_type
  if (params?.min_freq && params.min_freq > 1) query.min_freq = params.min_freq
  if (params?.search?.trim()) query.search = params.search.trim()
  if (params?.limit) query.limit = params.limit

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
  termIds: number[],
  status: GlossaryStatus,
): Promise<{ updated: number }> {
  const { data } = await http.post<{ updated: number }>(
    '/api/glossary/bulk-status',
    { term_ids: termIds, status },
  )
  return data
}

export async function bulkDeleteGlossaryTerms(
  termIds: number[],
): Promise<{ deleted: number }> {
  const { data } = await http.post<{ deleted: number }>(
    '/api/glossary/bulk-delete',
    { term_ids: termIds },
  )
  return data
}

export async function importGlossaryFile(
  seriesId: number,
  file: File,
  defaultStatus: GlossaryStatus = 'approved',
): Promise<GlossaryImportResponse> {
  const form = new FormData()
  form.append('file', file)
  form.append('default_status', defaultStatus)
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
  volumeId?: number | null,
  status?: GlossaryStatus | null,
): string {
  const sp = new URLSearchParams({ format: fmt })
  if (volumeId) sp.set('volume_id', String(volumeId))
  if (status) sp.set('status', status)
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
): Promise<MapPhaseResponse> {
  const { data } = await http.post<MapPhaseResponse>(
    `/api/volumes/${volumeId}/continuity/map`,
    { force_rerun: forceRerun },
  )
  return data
}

export async function runReducePhaseApi(
  volumeId: number,
  skipAiSummary = false,
): Promise<ReducePhaseResponse> {
  const { data } = await http.post<ReducePhaseResponse>(
    `/api/volumes/${volumeId}/continuity/reduce`,
    { skip_ai_summary: skipAiSummary },
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
