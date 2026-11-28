import { Bug, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { extractErrorMessage, fetchChapterDebugContext } from '../lib/api'
import type {
  DebugContextResponse,
  HybridConfig,
  TranslateChapterRow,
  TranslationMode,
} from '../types'

interface DebugContextModalProps {
  chapter: TranslateChapterRow
  mode: TranslationMode
  hybridConfig: HybridConfig
  onClose: () => void
}

export function DebugContextModal({
  chapter,
  mode,
  hybridConfig,
  onClose,
}: DebugContextModalProps) {
  const [data, setData] = useState<DebugContextResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    fetchChapterDebugContext(chapter.id, {
      mode,
      use_glossary: hybridConfig.use_glossary,
      use_characters: hybridConfig.use_characters,
      use_relationships: hybridConfig.use_relationships,
      use_subarc: hybridConfig.use_subarc,
      rolling_context_lines: hybridConfig.rolling_context_lines,
    })
      .then((res) => {
        if (active) setData(res)
      })
      .catch((err) => {
        if (active) setErrorMsg(extractErrorMessage(err))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [chapter.id, mode, hybridConfig])

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Bug className="w-5 h-5 text-indigo-500" />
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">
                Xem ngữ cảnh gửi AI — Chương {chapter.chapter_index}: {chapter.title}
              </h3>
              <p className="text-xs text-slate-500 dark:text-zinc-400">
                Chế độ: <strong>{mode}</strong>
                {data?.using_masked_text ? ' · Đang dùng bản đã che từ nhạy cảm' : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-4 text-xs">
          {loading && (
            <div className="py-10 text-center text-sm text-slate-400">
              Đang dựng ngữ cảnh thực tế...
            </div>
          )}

          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-500/30">
              {errorMsg}
            </div>
          )}

          {data && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-xl border border-slate-200 dark:border-zinc-800 p-3 bg-slate-50 dark:bg-zinc-950/60">
                  <div className="text-slate-400">Nhân vật khớp</div>
                  <div className="text-lg font-bold text-slate-900 dark:text-zinc-100">
                    {data.matched_characters.length}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-zinc-800 p-3 bg-slate-50 dark:bg-zinc-950/60">
                  <div className="text-slate-400">Quan hệ khớp</div>
                  <div className="text-lg font-bold text-slate-900 dark:text-zinc-100">
                    {data.matched_relationships.length}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-zinc-800 p-3 bg-slate-50 dark:bg-zinc-950/60">
                  <div className="text-slate-400">Thuật ngữ approved</div>
                  <div className="text-lg font-bold text-slate-900 dark:text-zinc-100">
                    {data.matched_glossary.length}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-zinc-800 p-3 bg-slate-50 dark:bg-zinc-950/60">
                  <div className="text-slate-400">System Instruction</div>
                  <div className="text-lg font-bold text-indigo-600 dark:text-indigo-400">
                    {data.system_instruction_length.toLocaleString('vi-VN')} ký tự
                  </div>
                </div>
              </div>

              {data.ignored_shared_parts.length > 0 && (
                <div className="px-3.5 py-2 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 text-amber-800 dark:text-amber-300">
                  <strong>Họ chung đã tự động loại bỏ khỏi Alias Index:</strong>{' '}
                  {data.ignored_shared_parts.join(', ')}
                </div>
              )}

              {data.matched_characters.length > 0 && (
                <div>
                  <div className="font-semibold text-slate-700 dark:text-zinc-300 mb-1.5">
                    Nhân vật nhận diện trong chương:
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {data.matched_characters.map((c) => (
                      <span
                        key={c.id}
                        className="px-2.5 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30"
                      >
                        <strong>{c.display_name}</strong> ({c.matched_aliases.join(', ')})
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="font-semibold text-slate-700 dark:text-zinc-300 mb-1.5">
                  User Prompt thực tế gửi lên Gemini ({data.user_prompt.length.toLocaleString('vi-VN')} ký tự):
                </div>
                <pre className="p-4 rounded-xl bg-slate-950 text-slate-100 font-mono text-[11px] overflow-x-auto max-h-[42vh] overflow-y-auto whitespace-pre-wrap leading-relaxed">
                  {data.user_prompt}
                </pre>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
