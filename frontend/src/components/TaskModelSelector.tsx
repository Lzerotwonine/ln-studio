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
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
]

const CUSTOM_SENTINEL = '__custom__'

export function TaskModelSelector({
  taskKey,
  value,
  onChange,
  compact = false,
}: TaskModelSelectorProps) {
  const [defaultModel, setDefaultModel] = useState<string>('')
  const [options, setOptions] = useState<string[]>(FALLBACK_MODELS)
  const [customMode, setCustomMode] = useState(false)
  const [customInput, setCustomInput] = useState('')

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

  const allOptions = value && !options.includes(value) ? [value, ...options] : options

  if (customMode) {
    return (
      <div
        className={`inline-flex items-center gap-1 rounded-xl border border-indigo-300 dark:border-indigo-500/40 bg-white dark:bg-zinc-900 ${
          compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'
        }`}
      >
        <Cpu className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
        <input
          type="text"
          autoFocus
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              const trimmed = customInput.trim()
              if (trimmed) onChange(trimmed)
              setCustomMode(false)
            } else if (e.key === 'Escape') {
              setCustomMode(false)
            }
          }}
          placeholder="VD: gemini-3-pro..."
          className="w-36 bg-transparent font-mono focus:outline-none text-slate-800 dark:text-zinc-100"
        />
        <button
          type="button"
          onClick={() => {
            const trimmed = customInput.trim()
            if (trimmed) onChange(trimmed)
            setCustomMode(false)
          }}
          className="px-1.5 py-0.5 rounded bg-indigo-600 text-white text-[10px] font-semibold cursor-pointer"
        >
          OK
        </button>
        <button
          type="button"
          onClick={() => setCustomMode(false)}
          className="px-1 text-slate-400 hover:text-slate-600 text-[10px] cursor-pointer"
        >
          Hủy
        </button>
      </div>
    )
  }

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
        onChange={(e) => {
          if (e.target.value === CUSTOM_SENTINEL) {
            setCustomInput(value)
            setCustomMode(true)
            return
          }
          onChange(e.target.value)
        }}
        className="bg-transparent text-slate-700 dark:text-zinc-200 font-medium focus:outline-none cursor-pointer max-w-[205px]"
      >
        <option value="" className="bg-white dark:bg-zinc-900">
          Mặc định{defaultModel ? ` (${defaultModel})` : ''}
        </option>
        {allOptions.map((m) => (
          <option key={m} value={m} className="bg-white dark:bg-zinc-900">
            {m}
          </option>
        ))}
        <option value={CUSTOM_SENTINEL} className="bg-white dark:bg-zinc-900">
          + Nhập mã model mới...
        </option>
      </select>
    </div>
  )
}
