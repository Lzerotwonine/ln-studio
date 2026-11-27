import { Cpu } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fetchTaskModels } from '../lib/api'
import type { TaskModelKey } from '../types'

interface TaskModelSelectorProps {
  taskKey: TaskModelKey
  value: string
  onChange: (modelId: string) => void
  compact?: boolean
}

const FALLBACK_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
]

export function TaskModelSelector({
  taskKey,
  value,
  onChange,
  compact = false,
}: TaskModelSelectorProps) {
  const [defaultModel, setDefaultModel] = useState<string>('')
  const [options, setOptions] = useState<string[]>(FALLBACK_MODELS)

  useEffect(() => {
    let active = true
    fetchTaskModels()
      .then((res) => {
        if (!active) return
        const assigned = res.tasks?.[taskKey]
        if (assigned?.primary) {
          setDefaultModel(assigned.primary)
        }
        const merged = Array.from(
          new Set([...(res.available_models ?? []), ...FALLBACK_MODELS]),
        )
        setOptions(merged)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [taskKey])

  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 ${
        compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs'
      }`}
      title="Đổi nhanh Model AI cho riêng lần chạy này (để Mặc định sẽ dùng cấu hình theo tác vụ trong Cài đặt)"
    >
      <Cpu className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
      <select
        aria-label={`Chọn model cho ${taskKey}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-slate-700 dark:text-zinc-200 font-medium focus:outline-none cursor-pointer max-w-[195px]"
      >
        <option value="" className="bg-white dark:bg-zinc-900">
          Mặc định{defaultModel ? ` (${defaultModel})` : ''}
        </option>
        {options.map((m) => (
          <option key={m} value={m} className="bg-white dark:bg-zinc-900">
            {m}
          </option>
        ))}
      </select>
    </div>
  )
}
