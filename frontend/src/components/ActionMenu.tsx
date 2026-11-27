import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export interface ActionMenuItem {
  label: string
  icon?: React.ReactNode
  onClick?: () => void
  href?: string
  disabled?: boolean
  danger?: boolean
  dividerBefore?: boolean
}

interface ActionMenuProps {
  label: string
  icon?: React.ReactNode
  items: ActionMenuItem[]
  align?: 'left' | 'right'
}

export function ActionMenu({
  label,
  icon,
  items,
  align = 'right',
}: ActionMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
      >
        {icon}
        <span>{label}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          className={`absolute z-40 mt-1.5 min-w-[210px] rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg py-1.5 ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {items.map((item, idx) => {
            const baseCls = `w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-left transition-colors ${
              item.disabled
                ? 'opacity-40 pointer-events-none'
                : item.danger
                  ? 'text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 cursor-pointer'
                  : 'text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer'
            }`

            return (
              <div key={`${item.label}-${idx}`}>
                {item.dividerBefore && (
                  <div className="my-1 border-t border-slate-100 dark:border-zinc-800" />
                )}
                {item.href ? (
                  <a
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className={baseCls}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </a>
                ) : (
                  <button
                    type="button"
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(false)
                      item.onClick?.()
                    }}
                    className={baseCls}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
