import {
  ArrowRight,
  BookMarked,
  BookOpen,
  CheckCheck,
  Cpu,
  FileCode2,
  Image as ImageIcon,
  Languages,
  ShieldAlert,
  Users,
} from 'lucide-react'
import type { NavSection } from '../types'

interface GuidePageProps {
  onNavigate: (section: NavSection) => void
}

const WORKFLOW_STEPS: Array<{
  step: string
  section: NavSection
  title: string
  icon: typeof BookOpen
  summary: string
  details: string[]
}> = [
  {
    step: '01',
    section: 'dashboard',
    title: 'Quản lý Truyện & Kho Chương',
    icon: BookOpen,
    summary: 'Khởi tạo bộ truyện (JA/ZH/KO), tạo Tập nhãn tự do và nhập nguồn raw.',
    details: [
      'Nhập trực tiếp .epub / .txt / .docx; ảnh minh họa EPUB tự động trích xuất thành Markdown ![image:...](/api/media/...).',
      'Dùng Kho Chương để dán thêm chương, đổi tên trực tiếp, tách chương tại con trỏ, gộp 2 chương kề nhau hoặc xóa lẻ.',
    ],
  },
  {
    step: '02',
    section: 'glossary',
    title: 'Master Glossary (Bảng Thuật ngữ)',
    icon: BookMarked,
    summary: 'Đếm từ thông minh theo ngôn ngữ, lọc riêng từng tập và đồng bộ 2 bước từ Excel.',
    details: [
      'Lọc tuyệt đối theo Tập N (tần suất riêng trong tập) hoặc Toàn Series; hỗ trợ Virtual List cho >5.000 từ.',
      'Chọn dòng kiểu Excel (Click / Shift / Ctrl / Ctrl+Shift) và áp dụng hành động hàng loạt cho toàn bộ kết quả lọc.',
    ],
  },
  {
    step: '03',
    section: 'characters',
    title: 'Nhân vật, Xưng hô & Continuity Pack',
    icon: Users,
    summary: 'Chạy MAP → REDUCE để khóa ma trận xưng hô có hướng A → B và B → A.',
    details: [
      'Bảo vệ 100% các cặp xưng hô đã khóa (Locked) từ tập trước và tự cảnh báo các cặp thiếu chiều ngược.',
      'Tự động dựng volN_continuity_pack.xml hợp lệ 100% từ SQLite.',
    ],
  },
  {
    step: '04',
    section: 'translate',
    title: 'Dịch thuật Đa chế độ & R19',
    icon: Languages,
    summary: 'Hỗ trợ 3 chế độ (LN-VN, Dịch Tự Do, Hybrid) chạy nền với log SSE trực tiếp.',
    details: [
      'Bật Pre-mask để tự động che từ nhạy cảm theo Kho từ nhạy cảm trước khi dịch (giữ nguyên raw gốc).',
      'Bật Mature / R19 để dùng BLOCK_NONE kèm ngữ cảnh văn học ngay từ lần dịch đầu tiên.',
    ],
  },
  {
    step: '05',
    section: 'proofread',
    title: 'Hiệu đính Song song & Xuất bản',
    icon: CheckCheck,
    summary: 'So sánh Raw – Bản dịch, bật Đọc xem trước Markdown kèm ảnh và xuất DOCX/EPUB.',
    details: [
      'Rê chuột lên từ tô sáng ở cột Raw để xem nghĩa Việt + Hán-Việt; bản dịch tự lưu sau 1,5 giây ngừng gõ.',
      'Xuất .docx (Times New Roman / Cambria) và .epub có mục lục chuẩn và tự động nhúng ảnh minh họa thật.',
    ],
  },
]

export function GuidePage({ onNavigate }: GuidePageProps) {
  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="space-y-1.5">
        <div className="text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
          LN-Studio Handbook
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
          Hướng dẫn Tổng quan Quy trình Dịch Light Novel
        </h2>
        <p className="text-sm text-slate-500 dark:text-zinc-400">
          Quy trình 5 bước khép kín từ nhập sách gốc đến xuất bản phẩm `.docx` /
          `.epub` sạch đẹp, đồng nhất thuật ngữ và xưng hô xuyên suốt hàng chục
          tập.
        </p>
      </div>

      {/* 5-step workflow cards */}
      <div className="space-y-3">
        {WORKFLOW_STEPS.map((item) => {
          const Icon = item.icon
          return (
            <div
              key={item.step}
              className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 shadow-xs flex flex-col sm:flex-row sm:items-start justify-between gap-4"
            >
              <div className="flex items-start gap-4">
                <div className="w-11 h-11 rounded-xl bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 flex flex-col items-center justify-center shrink-0">
                  <Icon className="w-5 h-5" />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] font-bold px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300">
                      BƯỚC {item.step}
                    </span>
                    <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">
                      {item.title}
                    </h3>
                  </div>
                  <p className="text-xs font-medium text-slate-600 dark:text-zinc-300">
                    {item.summary}
                  </p>
                  <ul className="list-disc pl-4 space-y-1 text-xs text-slate-500 dark:text-zinc-400">
                    {item.details.map((d, idx) => (
                      <li key={idx}>{d}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <button
                type="button"
                onClick={() => onNavigate(item.section)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border border-slate-200 dark:border-zinc-700 hover:bg-indigo-50 dark:hover:bg-indigo-500/15 hover:text-indigo-700 dark:hover:text-indigo-300 shrink-0 cursor-pointer self-start"
              >
                Mở tab
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )
        })}
      </div>

      {/* Feature Highlights Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-2">
          <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-zinc-100">
            <Cpu className="w-4 h-4 text-indigo-500" />
            Phân bổ Model theo 6 Tác vụ
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400 leading-relaxed">
            Vào <strong>Cài đặt → Model ưu tiên</strong> để gán model nhẹ
            (Flash-Lite / Flash) cho Glossary, MAP PHASE và Quét nhạy cảm; dành
            model mạnh (Pro) cho Dịch chương chính. Tại mỗi tab vẫn có dropdown
            đổi nhanh model trước khi chạy.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-2">
          <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-zinc-100">
            <ShieldAlert className="w-4 h-4 text-rose-500" />
            Kho từ nhạy cảm & Chế độ R19
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400 leading-relaxed">
            Vào <strong>Cài đặt → Kho từ nhạy cảm</strong> để nạp sẵn bộ từ mẫu
            tiếng Nhật (seed) hoặc dán hàng loạt danh sách theo định dạng{' '}
            <code>từ gốc = từ thay thế</code>. Kết hợp Pre-mask + Mature/R19 để
            giảm tối đa lỗi chặn bộ lọc.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-2">
          <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-zinc-100">
            <FileCode2 className="w-4 h-4 text-emerald-500" />
            LN-VN Reference Packs
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400 leading-relaxed">
            Quản lý các tệp tham chiếu chuyên sâu (Primer, ICL Samples, Kanji
            DB...) trong <strong>Cài đặt → Reference Packs</strong>, chọn bật/tắt
            riêng cho pha Tóm tắt và pha Dịch ở chế độ LN-VN.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-2">
          <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-zinc-100">
            <ImageIcon className="w-4 h-4 text-sky-500" />
            Ảnh minh họa EPUB & GIF Hướng dẫn
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400 leading-relaxed">
            Ảnh từ EPUB được lưu tại <code>data/media/vol_&#123;id&#125;/</code>
            , giữ nguyên qua quá trình dịch và nhúng lại vào `.docx`/`.epub`. Bạn
            cũng có thể đặt ảnh/GIF hướng dẫn cá nhân vào{' '}
            <code>frontend/public/guides/&#123;tab&#125;.gif</code>.
          </p>
        </div>
      </div>
    </div>
  )
}
