import { Image as ImageIcon, X } from 'lucide-react'
import { useState } from 'react'

interface MarkdownPreviewProps {
  content: string
  volumeId?: number | null
  fontSize?: number
  emptyPlaceholder?: string
  searchQuery?: string
  searchCaseSensitive?: boolean
  activeSearchIndex?: number
}

const IMAGE_LINE_RE =
  /^!\[([^\]]*)\]\((images\/[^/\s)]+|\/api\/media\/vol_\d+\/[^/\s)]+|https?:\/\/[^\s)]+)\)$/
const INLINE_RE = /(\*\*\*[^*\n]+?\*\*\*|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*|`[^`\n]+?`)/g

export function resolveDisplayMediaUrl(
  rawSrc: string,
  volumeId?: number | null,
): string {
  const cleaned = (rawSrc || '').trim()
  if (cleaned.startsWith('images/') && volumeId) {
    const fname = cleaned.slice('images/'.length)
    return `/api/media/vol_${volumeId}/${fname}`
  }
  return cleaned
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlightPlainText(
  text: string,
  searchQuery: string,
  caseSensitive: boolean,
  counter: { current: number },
  activeIndex: number,
  keyPrefix: string,
): React.ReactNode {
  if (!searchQuery) return text
  const re = new RegExp(`(${escapeRegExp(searchQuery)})`, caseSensitive ? 'g' : 'gi')
  const parts = text.split(re)
  if (parts.length === 1) return text
  return parts.map((p, i) => {
    if (!p) return null
    const isMatch = caseSensitive
      ? p === searchQuery
      : p.toLowerCase() === searchQuery.toLowerCase()
    if (!isMatch) return <span key={`${keyPrefix}-${i}`}>{p}</span>
    const matchIdx = counter.current++
    const isActive = matchIdx === activeIndex
    return (
      <mark
        key={`${keyPrefix}-${i}`}
        data-search-match={matchIdx}
        className={`rounded px-0.5 ${
          isActive
            ? 'bg-orange-400 text-slate-950 ring-2 ring-orange-500'
            : 'bg-yellow-200 dark:bg-yellow-500/35 text-inherit'
        }`}
      >
        {p}
      </mark>
    )
  })
}

function renderInlineMarkdown(
  text: string,
  searchQuery: string,
  caseSensitive: boolean,
  counter: { current: number },
  activeIndex: number,
  lineIdx: number,
): React.ReactNode[] {
  const parts = text.split(INLINE_RE)
  return parts.map((part, idx) => {
    if (!part) return null
    const kp = `${lineIdx}-${idx}`
    if (part.startsWith('***') && part.endsWith('***') && part.length > 6) {
      return (
        <strong key={idx} className="font-bold italic">
          {highlightPlainText(part.slice(3, -3), searchQuery, caseSensitive, counter, activeIndex, kp)}
        </strong>
      )
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={idx} className="font-bold">
          {highlightPlainText(part.slice(2, -2), searchQuery, caseSensitive, counter, activeIndex, kp)}
        </strong>
      )
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return (
        <em key={idx} className="italic">
          {highlightPlainText(part.slice(1, -1), searchQuery, caseSensitive, counter, activeIndex, kp)}
        </em>
      )
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={idx}
          className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 font-mono text-[0.88em]"
        >
          {highlightPlainText(part.slice(1, -1), searchQuery, caseSensitive, counter, activeIndex, kp)}
        </code>
      )
    }
    return (
      <span key={idx}>
        {highlightPlainText(part, searchQuery, caseSensitive, counter, activeIndex, kp)}
      </span>
    )
  })
}

export function MarkdownPreview({
  content,
  volumeId = null,
  fontSize = 15,
  emptyPlaceholder = 'Chưa có nội dung để xem trước.',
  searchQuery = '',
  searchCaseSensitive = false,
  activeSearchIndex = -1,
}: MarkdownPreviewProps) {
  const [zoomImg, setZoomImg] = useState<{ src: string; alt: string } | null>(
    null,
  )

  const trimmed = (content || '').trim()
  if (!trimmed) {
    return (
      <div className="p-6 text-sm text-slate-400 italic">{emptyPlaceholder}</div>
    )
  }

  const lines = trimmed.replace(/\r\n/g, '\n').split('\n')
  const matchCounter = { current: 0 }

  return (
    <>
      <article
        style={{ fontSize: `${fontSize}px` }}
        className="p-6 leading-relaxed font-serif text-slate-900 dark:text-zinc-100 space-y-3.5"
      >
        {lines.map((rawLine, idx) => {
          const line = rawLine.trim()
          if (!line) return null

          const imgMatch = line.match(IMAGE_LINE_RE)
          if (imgMatch) {
            const alt = imgMatch[1] || 'Minh họa'
            const src = resolveDisplayMediaUrl(imgMatch[2], volumeId)
            return (
              <figure
                key={idx}
                className="my-5 flex flex-col items-center gap-1.5"
              >
                <button
                  type="button"
                  onClick={() => setZoomImg({ src, alt })}
                  className="group relative rounded-xl overflow-hidden border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 shadow-xs cursor-zoom-in"
                >
                  <img
                    src={src}
                    alt={alt}
                    loading="lazy"
                    className="max-h-[460px] w-auto object-contain block"
                  />
                </button>
                <figcaption className="inline-flex items-center gap-1 text-[11px] font-sans text-slate-400">
                  <ImageIcon className="w-3 h-3" />
                  {alt}
                </figcaption>
              </figure>
            )
          }

          if (line === '---' || line === '***' || line === '___') {
            return (
              <hr
                key={idx}
                className="my-5 border-slate-200 dark:border-zinc-800"
              />
            )
          }

          if (line.startsWith('### ')) {
            return (
              <h3
                key={idx}
                className="text-lg font-bold text-slate-900 dark:text-zinc-100 pt-2"
              >
                {renderInlineMarkdown(line.slice(4), searchQuery, searchCaseSensitive, matchCounter, activeSearchIndex, idx)}
              </h3>
            )
          }

          if (line.startsWith('## ')) {
            return (
              <h2
                key={idx}
                className="text-xl font-bold text-slate-900 dark:text-zinc-100 pt-2"
              >
                {renderInlineMarkdown(line.slice(3), searchQuery, searchCaseSensitive, matchCounter, activeSearchIndex, idx)}
              </h2>
            )
          }

          if (line.startsWith('# ')) {
            return (
              <h1
                key={idx}
                className="text-2xl font-bold text-center text-slate-900 dark:text-zinc-100 py-2"
              >
                {renderInlineMarkdown(line.slice(2), searchQuery, searchCaseSensitive, matchCounter, activeSearchIndex, idx)}
              </h1>
            )
          }

          if (line.startsWith('> ')) {
            return (
              <blockquote
                key={idx}
                className="pl-4 border-l-3 border-indigo-400/70 italic text-slate-600 dark:text-zinc-300"
              >
                {renderInlineMarkdown(line.slice(2), searchQuery, searchCaseSensitive, matchCounter, activeSearchIndex, idx)}
              </blockquote>
            )
          }

          return (
            <p key={idx} className="indent-6 text-justify">
              {renderInlineMarkdown(line, searchQuery, searchCaseSensitive, matchCounter, activeSearchIndex, idx)}
            </p>
          )
        })}
      </article>

      {zoomImg && (
        <div
          onClick={() => setZoomImg(null)}
          className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-xs flex items-center justify-center p-6 cursor-zoom-out"
        >
          <button
            type="button"
            onClick={() => setZoomImg(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={zoomImg.src}
            alt={zoomImg.alt}
            className="max-w-[92vw] max-h-[90vh] object-contain rounded-xl shadow-2xl"
          />
        </div>
      )}
    </>
  )
}
