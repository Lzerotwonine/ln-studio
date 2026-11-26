import axios from 'axios'
import type {
  ApiKeyItem,
  HealthInfo,
  ModelConfig,
  PromptPreset,
  PromptPresetPayload,
  QuotaStatusResponse,
  Series,
  SeriesPayload,
  Volume,
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
