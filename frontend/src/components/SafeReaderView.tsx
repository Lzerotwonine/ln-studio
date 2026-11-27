import { Image as ImageIcon, X } from 'lucide-react'
import React, { useMemo, useState } from 'react'
import type { GlossaryHighlightItem } from '../types'
import { resolveDisplayMediaUrl } from './MarkdownPreview'

interface SafeReaderViewProps {
  sourceHtml?: string
  rawText: string
  volumeId?: number | null
  fontSize?: number
  glossaryHighlights: GlossaryHighlightItem[]
  searchQuery?: string
  searchCaseSensitive?: boolean
  activeSearchIndex?: number
  onHoverTerm: (term: GlossaryHighlightItem, rect: DOMRect) => void
  onLeaveTerm: () => void
}

const IMAGE_LINE_RE =
  /^!\[([^\]]*)\]\((images\/[^/\s)]+|\/api\/media\/vol_\d+\/[^/\s)]+|https?:\/\/[^\s)]+)\)$/

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface CompiledGlossary {
  regex: RegExp | null
  map: Map<string, GlossaryHighlightItem>
}

function compileGlossary(highlights: GlossaryHighlightItem[]): CompiledGlossary {
  const map = new Map<string, GlossaryHighlightItem>()
  const patterns: string[] = []
  const sorted = [...highlights].sort(
    (a, b) => b.source_term.length - a.source_term.length,
  )
  for (const item of sorted) {
    const key = item.source_term
    if (!key || map.has(key)) continue
    map.set(key, item)
    patterns.push(escapeRegExp(key))
    if (patterns.length >= 400) break
  }
  return {
    regex: patterns.length > 0 ? new RegExp(`(${patterns.join('|')})`, 'g') : null,
    map,
  }
}

function renderSearchDecorated(
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
  return parts.map((p, idx) => {
    if (!p) return null
    const isMatch = caseSensitive
      ? p === searchQuery
      : p.toLowerCase() === searchQuery.toLowerCase()
    if (!isMatch) return <React.Fragment key={`${keyPrefix}-s${idx}`}>{p}</React.Fragment>
    const mIdx = counter.current++
    const isActive = mIdx === activeIndex
    return (
      <mark
        key={`${keyPrefix}-m${idx}`}
        data-raw-search-match={mIdx}
        className={`rounded px-0.5 ${
          isActive
            ? 'bg-orange-400 text-slate-950 ring-2 ring-orange-500'
            : 'bg-yellow-200 dark:bg-yellow-500/40 text-inherit'
        }`}
      >
        {p}
      </mark>
    )
  })
}

function renderTextWithGlossaryAndSearch(
  text: string,
  compiled: CompiledGlossary,
  searchQuery: string,
  caseSensitive: boolean,
  counter: { current: number },
  activeIndex: number,
  onHoverTerm: (term: GlossaryHighlightItem, rect: DOMRect) => void,
  onLeaveTerm: () => void,
  keyPrefix: string,
): React.ReactNode {
  if (!text) return null
  if (!compiled.regex) {
    return renderSearchDecorated(
      text,
      searchQuery,
      caseSensitive,
      counter,
      activeIndex,
      keyPrefix,
    )
  }

  const parts = text.split(compiled.regex)
  return parts.map((part, idx) => {
    if (!part) return null
    const term = compiled.map.get(part)
    const inner = renderSearchDecorated(
      part,
      searchQuery,
      caseSensitive,
      counter,
      activeIndex,
      `${keyPrefix}-g${idx}`,
    )
    if (!term) {
      return <React.Fragment key={`${keyPrefix}-p${idx}`}>{inner}</React.Fragment>
    }
    return (
      <mark
        key={`${keyPrefix}-t${idx}`}
        onMouseEnter={(e) => onHoverTerm(term, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={onLeaveTerm}
        className="rounded px-0.5 bg-amber-200/60 dark:bg-amber-500/25 text-inherit border-b border-amber-500/70 cursor-help transition-colors hover:bg-amber-300/80 dark:hover:bg-amber-500/40"
      >
        {inner}
      </mark>
    )
  })
}

export function SafeReaderView({
  sourceHtml,
  rawText,
  volumeId = null,
  fontSize = 15,
  glossaryHighlights,
  searchQuery = '',
  searchCaseSensitive = false,
  activeSearchIndex = -1,
  onHoverTerm,
  onLeaveTerm,
}: SafeReaderViewProps) {
  const [zoomImg, setZoomImg] = useState<{ src: string; alt: string } | null>(
    null,
  )

  const compiled = useMemo(
    () => compileGlossary(glossaryHighlights),
    [glossaryHighlights],
  )

  const parsedDoc = useMemo(() => {
    const htmlStr = (sourceHtml || '').trim()
    if (!htmlStr || typeof DOMParser === 'undefined') return null
    try {
      const parser = new DOMParser()
      return parser.parseFromString(`<div>${htmlStr}</div>`, 'text/html')
    } catch {
      return null
    }
  }, [sourceHtml])

  const matchCounter = { current: 0 }

  const renderDomNode = (
    node: Node,
    key: string,
    insideRubyText = false,
  ): React.ReactNode => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ''
      if (!text) return null
      if (insideRubyText) {
        return text
      }
      return renderTextWithGlossaryAndSearch(
        text,
        compiled,
        searchQuery,
        searchCaseSensitive,
        matchCounter,
        activeSearchIndex,
        onHoverTerm,
        onLeaveTerm,
        key,
      )
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return null
    const el = node as Element
    const tag = el.tagName.toLowerCase()

    if (tag === 'img') {
      const rawSrc = el.getAttribute('src') || ''
      const src = resolveDisplayMediaUrl(rawSrc, volumeId)
      if (!src) return null
      const alt = el.getAttribute('alt') || 'Minh họa'
      return (
        <button
          key={key}
          type="button"
          onClick={() => setZoomImg({ src, alt })}
          className="my-4 mx-auto block rounded-xl overflow-hidden border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xs cursor-zoom-in"
        >
          <img
            src={src}
            alt={alt}
            loading="lazy"
            className="max-h-[440px] w-auto object-contain block"
          />
        </button>
      )
    }

    if (tag === 'br') return <br key={key} />
    if (tag === 'hr') {
      return <hr key={key} className="my-5 border-slate-300 dark:border-zinc-700" />
    }

    const nextInsideRt = insideRubyText || tag === 'rt' || tag === 'rp' || tag === 'rtc'
    const children = Array.from(el.childNodes).map((child, idx) =>
      renderDomNode(child, `${key}-${idx}`, nextInsideRt),
    )

    switch (tag) {
      case 'h1':
        return (
          <h1 key={key} className="text-xl font-bold text-center py-2 text-slate-900 dark:text-zinc-100">
            {children}
          </h1>
        )
      case 'h2':
        return (
          <h2 key={key} className="text-lg font-bold pt-3 pb-1 text-slate-900 dark:text-zinc-100">
            {children}
          </h2>
        )
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return (
          <h3 key={key} className="text-base font-bold pt-2 text-slate-900 dark:text-zinc-100">
            {children}
          </h3>
        )
      case 'p':
        return (
          <p key={key} className="my-2.5 leading-[1.9]">
            {children}
          </p>
        )
      case 'blockquote':
        return (
          <blockquote
            key={key}
            className="my-3 pl-4 border-l-3 border-indigo-400/70 italic text-slate-700 dark:text-zinc-300"
          >
            {children}
          </blockquote>
        )
      case 'figure':
        return (
          <figure key={key} className="my-4 flex flex-col items-center gap-1.5">
            {children}
          </figure>
        )
      case 'figcaption':
        return (
          <figcaption key={key} className="text-[11px] font-sans text-slate-400">
            {children}
          </figcaption>
        )
      case 'ruby':
        return (
          <ruby key={key} className="ruby-align">
            {children}
          </ruby>
        )
      case 'rb':
        return <span key={key}>{children}</span>
      case 'rt':
        return (
          <rt key={key} className="text-[0.58em] text-slate-500 dark:text-zinc-400 select-none">
            {children}
          </rt>
        )
      case 'rp':
        return <rp key={key}>{children}</rp>
      case 'strong':
      case 'b':
        return (
          <strong key={key} className="font-bold">
            {children}
          </strong>
        )
      case 'em':
      case 'i':
        return (
          <em key={key} className="italic">
            {children}
          </em>
        )
      case 'u':
        return <u key={key}>{children}</u>
      case 's':
      case 'del':
        return <s key={key}>{children}</s>
      case 'sub':
        return <sub key={key}>{children}</sub>
      case 'sup':
        return <sup key={key}>{children}</sup>
      case 'ul':
        return (
          <ul key={key} className="list-disc pl-6 my-2 space-y-1">
            {children}
          </ul>
        )
      case 'ol':
        return (
          <ol key={key} className="list-decimal pl-6 my-2 space-y-1">
            {children}
          </ol>
        )
      case 'li':
        return <li key={key}>{children}</li>
      case 'table':
        return (
          <div key={key} className="overflow-x-auto my-3">
            <table className="w-full border-collapse border border-slate-200 dark:border-zinc-700 text-sm">
              {children}
            </table>
          </div>
        )
      case 'thead':
        return <thead key={key}>{children}</thead>
      case 'tbody':
        return <tbody key={key}>{children}</tbody>
      case 'tr':
        return (
          <tr key={key} className="border-b border-slate-200 dark:border-zinc-700">
            {children}
          </tr>
        )
      case 'th':
        return (
          <th key={key} className="px-2.5 py-1.5 text-left font-semibold bg-slate-100 dark:bg-zinc-800">
            {children}
          </th>
        )
      case 'td':
        return (
          <td key={key} className="px-2.5 py-1.5 border-r border-slate-200 dark:border-zinc-700 last:border-r-0">
            {children}
          </td>
        )
      case 'pre':
        return (
          <pre key={key} className="p-3 rounded-lg bg-slate-100 dark:bg-zinc-900 font-mono text-xs overflow-x-auto my-2">
            {children}
          </pre>
        )
      case 'code':
        return (
          <code key={key} className="px-1 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 font-mono text-[0.88em]">
            {children}
          </code>
        )
      case 'div':
      case 'section':
      case 'article':
        return (
          <div key={key} className="my-1.5">
            {children}
          </div>
        )
      default:
        return <span key={key}>{children}</span>
    }
  }

  // Fallback: render Markdown / plain rawText as EPUB-style reader blocks with images + glossary + search
  const renderMarkdownFallback = () => {
    const lines = (rawText || '').replace(/\r\n/g, '\n').split('\n')
    return lines.map((rawLine, idx) => {
      const line = rawLine.trim()
      if (!line) return null
      const imgMatch = line.match(IMAGE_LINE_RE)
      if (imgMatch) {
        const alt = imgMatch[1] || 'Minh họa'
        const src = resolveDisplayMediaUrl(imgMatch[2], volumeId)
        return (
          <figure key={idx} className="my-4 flex flex-col items-center gap-1.5">
            <button
              type="button"
              onClick={() => setZoomImg({ src, alt })}
              className="rounded-xl overflow-hidden border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xs cursor-zoom-in"
            >
              <img
                src={src}
                alt={alt}
                loading="lazy"
                className="max-h-[440px] w-auto object-contain block"
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
        return <hr key={idx} className="my-5 border-slate-300 dark:border-zinc-700" />
      }
      const rendered = renderTextWithGlossaryAndSearch(
        line,
        compiled,
        searchQuery,
        searchCaseSensitive,
        matchCounter,
        activeSearchIndex,
        onHoverTerm,
        onLeaveTerm,
        `fb-${idx}`,
      )
      return (
        <p key={idx} className="my-2.5 leading-[1.9]">
          {rendered}
        </p>
      )
    })
  }

  return (
    <>
      <article
        style={{ fontSize: `${fontSize}px` }}
        className="p-6 font-serif text-slate-800 dark:text-zinc-200 select-text"
      >
        {parsedDoc?.body?.firstElementChild
          ? Array.from(parsedDoc.body.firstElementChild.childNodes).map(
              (child, idx) => renderDomNode(child, `r-${idx}`, false),
            )
          : renderMarkdownFallback()}
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
