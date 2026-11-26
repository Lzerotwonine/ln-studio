import { ArrowLeft, Construction } from 'lucide-react'
import type { NavSection, Series, Volume } from '../types'

interface PlaceholderPageProps {
  section: Exclude<
    NavSection,
    'dashboard' | 'glossary' | 'characters' | 'translate' | 'settings'
  >
  selectedSeries: Series | null
  selectedVolume: Volume | null
  onBackToDashboard: () => void
}

const SECTION_DETAILS: Record<
  Exclude<
    NavSection,
    'dashboard' | 'glossary' | 'characters' | 'translate' | 'settings'
  >,
  { title: string; phase: string; description: string; highlights: string[] }
> = {
  proofread: {
    title: 'Hiệu đính & Xuất bản',
    phase: 'Phase 5',
    description:
      'So sánh song ngữ Raw — Bản dịch, kiểm tra tỷ lệ độ dài (char_ratio), rà soát nhất quán thuật ngữ/xưng hô và xuất file EPUB/DOCX hoàn chỉnh.',
    highlights: [
      'Biên tập song song tối ưu cho các phiên đọc dài',
      'Cảnh báo lỗi thiếu câu, lệch thuật ngữ hoặc đổi xưng hô',
      'Xuất bản sạch sẽ sang EPUB / DOCX / TXT',
    ],
  },
}

export function PlaceholderPage({
  section,
  selectedSeries,
  selectedVolume,
  onBackToDashboard,
}: PlaceholderPageProps) {
  const info = SECTION_DETAILS[section]

  return (
    <div className="max-w-3xl mx-auto py-12 px-6">
      <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 shadow-xs">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-11 h-11 rounded-xl bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
            <Construction className="w-5 h-5" />
          </div>
          <div>
            <span className="inline-block text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
              Lộ trình {info.phase}
            </span>
            <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">
              {info.title}
            </h2>
          </div>
        </div>

        <p className="text-sm text-slate-600 dark:text-zinc-400 leading-relaxed mb-6">
          {info.description}
        </p>

        <div className="rounded-xl bg-slate-50 dark:bg-zinc-950/70 border border-slate-200 dark:border-zinc-800 p-4 mb-6">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-zinc-400 mb-2">
            Tính năng chính sẽ mở khóa
          </div>
          <ul className="space-y-1.5 text-sm text-slate-700 dark:text-zinc-300 list-disc pl-5">
            {info.highlights.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-zinc-800">
          <div className="text-xs text-slate-500 dark:text-zinc-400">
            {selectedSeries ? (
              <span>
                Đang chọn:{' '}
                <strong className="text-slate-800 dark:text-zinc-200">
                  {selectedSeries.title}
                </strong>
                {selectedVolume
                  ? ` — Tập ${selectedVolume.volume_number}: ${selectedVolume.title}`
                  : ''}
              </span>
            ) : (
              <span>Chưa chọn bộ truyện nào.</span>
            )}
          </div>
          <button
            type="button"
            onClick={onBackToDashboard}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            Quay lại Quản lý Truyện
          </button>
        </div>
      </div>
    </div>
  )
}
