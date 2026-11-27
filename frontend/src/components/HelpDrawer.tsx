import { BookOpen, CheckCircle2, ImageOff, Lightbulb, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { TAB_GUIDES } from '../data/guides'
import type { NavSection } from '../types'

interface HelpDrawerProps {
  open: boolean
  activeSection: NavSection
  onClose: () => void
  onOpenFullGuide: () => void
}

export function HelpDrawer({
  open,
  activeSection,
  onClose,
  onOpenFullGuide,
}: HelpDrawerProps) {
  const guide = TAB_GUIDES[activeSection] ?? TAB_GUIDES.dashboard
  const [gifFailed, setGifFailed] = useState(false)

  useEffect(() => {
    setGifFailed(false)
  }, [guide.gifPath, open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/45 backdrop-blur-xs">
      <div
        className="flex-1"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="w-full max-w-md h-full bg-white dark:bg-zinc-900 border-l border-slate-200 dark:border-zinc-800 shadow-2xl flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
              Hướng dẫn nhanh
            </div>
            <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100 mt-0.5">
              {guide.title}
            </h3>
            <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
              {guide.subtitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng hướng dẫn"
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-sm">
          {/* Optional GIF / Screenshot preview from frontend/public/guides/{tab}.gif */}
          {!gifFailed ? (
            <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950">
              <img
                src={guide.gifPath}
                alt={`Minh họa ${guide.title}`}
                onError={() => setGifFailed(true)}
                className="w-full h-auto block"
              />
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-950/60 px-3.5 py-2.5 flex items-center gap-2.5 text-[11px] text-slate-400 dark:text-zinc-500">
              <ImageOff className="w-4 h-4 shrink-0" />
              <span>
                Có thể thêm ảnh/GIF minh họa tại{' '}
                <code className="font-mono text-slate-500 dark:text-zinc-400">
                  frontend/public{guide.gifPath}
                </code>
              </span>
            </div>
          )}

          {/* Step-by-step */}
          <div className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-zinc-400">
              Các bước thao tác
            </div>
            {guide.steps.map((step, i) => (
              <div
                key={i}
                className="rounded-xl border border-slate-200/80 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-950/50 p-3.5 space-y-1"
              >
                <div className="flex items-center gap-1.5 font-semibold text-xs text-slate-900 dark:text-zinc-100">
                  <CheckCircle2 className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                  <span>{step.title}</span>
                </div>
                <p className="text-xs text-slate-600 dark:text-zinc-400 leading-relaxed pl-5">
                  {step.desc}
                </p>
              </div>
            ))}
          </div>

          {/* Tips */}
          {guide.tips.length > 0 && (
            <div className="rounded-xl border border-amber-200/70 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 p-3.5 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
                <Lightbulb className="w-3.5 h-3.5" />
                Mẹo sử dụng nhanh
              </div>
              <ul className="list-disc pl-5 space-y-1 text-xs text-amber-900/90 dark:text-amber-200/90">
                {guide.tips.map((tip, i) => (
                  <li key={i}>{tip}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-slate-200 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-950/60 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              onClose()
              onOpenFullGuide()
            }}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
          >
            <BookOpen className="w-3.5 h-3.5" />
            Xem Hướng dẫn tổng quan
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-900 dark:bg-zinc-100 text-white dark:text-zinc-900 cursor-pointer"
          >
            Đã hiểu
          </button>
        </div>
      </aside>
    </div>
  )
}
