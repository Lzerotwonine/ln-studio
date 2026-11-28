import {
  ArrowRight,
  BookMarked,
  BookOpen,
  CheckCheck,
  Cpu,
  FileCode2,
  FileStack,
  HelpCircle,
  Image as ImageIcon,
  Languages,
  Palette,
  ShieldAlert,
  Users,
} from 'lucide-react'
import { GLOSSARY_OF_TERMS } from '../data/guides'
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
    title: 'Quản lý truyện',
    icon: BookOpen,
    summary: 'Tạo bộ truyện mới, chọn ngôn ngữ nguồn, phong cách dịch và thêm các tập hoặc quyển.',
    details: [
      'Hỗ trợ truyện tiếng Nhật, tiếng Trung và tiếng Hàn với nhãn tập đặt tự do theo nhu cầu.',
      'Chọn sẵn Mẫu lệnh dịch phù hợp từng thể loại hoặc tự viết hướng dẫn văn phong riêng.',
    ],
  },
  {
    step: '02',
    section: 'chapters',
    title: 'Kho chương',
    icon: FileStack,
    summary: 'Nhập tệp sách EPUB, TXT hoặc Word và sắp xếp lại danh sách chương trước khi dịch.',
    details: [
      'Với tệp EPUB, hệ thống tự động ưu tiên tên chương từ mục lục, trích xuất ảnh bìa và lưu ảnh minh họa gọn sạch.',
      'Hỗ trợ dán thêm chương mới, đổi tên trực tiếp, tách chương dài tại vị trí con trỏ, gộp hai chương kề nhau hoặc xóa lẻ.',
    ],
  },
  {
    step: '03',
    section: 'glossary',
    title: 'Kho thuật ngữ',
    icon: BookMarked,
    summary: 'Đếm từ tự động, dịch hàng loạt bằng AI và giữ đồng nhất tên riêng xuyên suốt nhiều tập.',
    details: [
      'Lọc riêng thuật ngữ xuất hiện trong từng tập hoặc xem toàn bộ truyện, hỗ trợ danh sách hàng nghìn từ mượt mà.',
      'Hỗ trợ nhập kho cũ từ bảng tính TSV/CSV có xem trước 3 dòng mẫu và xác nhận đúng cột Hán-Việt, Nghĩa tiếng Anh.',
    ],
  },
  {
    step: '04',
    section: 'characters',
    title: 'Nhân vật và Xưng hô',
    icon: Users,
    summary: 'Phân tích từng chương rồi tổng hợp cả tập để khóa chặt cách xưng hô hai chiều giữa các nhân vật.',
    details: [
      'Tự động giữ lại toàn bộ cặp xưng hô đã khóa từ các tập trước và cảnh báo các cặp mới thiếu chiều ngược.',
      'Đọc ngay trích dẫn câu thoại gốc để duyệt và khóa cặp đại từ chính xác.',
    ],
  },
  {
    step: '05',
    section: 'translate',
    title: 'Dịch thuật',
    icon: Languages,
    summary: 'Dịch tự động nhiều chương qua API hoặc dùng chế độ Dịch qua Web với Gemini Web và Google AI Studio.',
    details: [
      'Hỗ trợ Tự che từ nhạy cảm trước khi gửi AI (bản gốc vẫn giữ nguyên) và Chế độ 18+ cho nội dung trưởng thành.',
      'Tự động bảo vệ vị trí ảnh minh họa trong lúc dịch và khôi phục chính xác khi lưu kết quả.',
    ],
  },
  {
    step: '06',
    section: 'proofread',
    title: 'Hiệu đính và Xuất bản',
    icon: CheckCheck,
    summary: 'Đối chiếu Bản gốc – Bản dịch tiếng Việt, xem trước định dạng kèm ảnh và xuất Word hoặc EPUB.',
    details: [
      'Cột Bản gốc có chế độ Bản đọc giống sách điện tử, giữ phiên âm trên đầu chữ và tô sáng thuật ngữ khi rê chuột.',
      'Hỗ trợ in đậm, in nghiêng, đổi kiểu dấu ngoặc, tìm thay thế toàn tập và tự động nhúng ảnh thật vào tệp Word / EPUB.',
    ],
  },
]

export function GuidePage({ onNavigate }: GuidePageProps) {
  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-8">
      <div className="space-y-1.5">
        <div className="text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
          Cẩm nang sử dụng LN-Studio
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
          Hướng dẫn quy trình dịch truyện
        </h2>
        <p className="text-sm text-slate-500 dark:text-zinc-400">
          Quy trình 6 bước khép kín từ nhập sách gốc đến xuất bản tệp Word và
          EPUB sạch đẹp, giữ đồng nhất thuật ngữ và xưng hô qua nhiều tập.
        </p>
      </div>

      {/* 6-step workflow cards */}
      <div className="space-y-3">
        {WORKFLOW_STEPS.map((item) => {
          const Icon = item.icon
          return (
            <div
              key={item.step}
              className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 shadow-xs flex flex-col sm:flex-row sm:items-start justify-between gap-4"
            >
              <div className="flex items-start gap-4">
                <div className="w-11 h-11 rounded-xl bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                  <Icon className="w-5 h-5" />
                </div>
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] font-bold px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300">
                      BƯỚC {item.step}
                    </span>
                    <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">
                      {item.title}
                    </h3>
                  </div>
                  <p className="text-sm text-slate-600 dark:text-zinc-300">
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
                Mở mục này
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
            <Palette className="w-4 h-4 text-amber-500" />
            Tùy biến Giao diện hiển thị
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400 leading-relaxed">
            Vào <strong>Cài đặt → Giao diện hiển thị</strong> để chọn màu nền
            Giấy vàng dịu mắt, Xám dịu, Tối hoặc Đêm sâu, cùng phông chữ, cỡ chữ
            và mật độ hiển thị thoải mái cho cả máy tính lẫn điện thoại.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-2">
          <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-zinc-100">
            <Cpu className="w-4 h-4 text-indigo-500" />
            Phân bổ Model theo từng tác vụ
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400 leading-relaxed">
            Vào <strong>Cài đặt → Model ưu tiên</strong> để tải danh sách Model
            khả dụng từ API, thử gọi trực tiếp và phân bổ Model nhẹ cho tác vụ
            phụ, dành Model mạnh cho phần dịch chính văn.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-2">
          <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-zinc-100">
            <ShieldAlert className="w-4 h-4 text-rose-500" />
            Kho từ nhạy cảm và Chế độ 18+
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400 leading-relaxed">
            Vào <strong>Cài đặt → Kho từ nhạy cảm</strong> để nạp sẵn bộ từ mẫu
            tiếng Nhật hoặc dán hàng loạt cặp{' '}
            <code>từ gốc = từ thay thế</code>. Kết hợp Tự che từ nhạy cảm và Chế
            độ 18+ để giảm tối đa lỗi bị bộ lọc chặn.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-2">
          <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-zinc-100">
            <FileCode2 className="w-4 h-4 text-emerald-500" />
            Tài liệu tham chiếu và Ảnh minh họa
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400 leading-relaxed">
            Quản lý các tệp quy tắc dịch trong{' '}
            <strong>Cài đặt → Tài liệu tham chiếu</strong>. Ảnh minh họa từ sách
            EPUB được lưu sạch dạng <code>images/...</code> và tự động nhúng lại
            khi xuất Word hoặc EPUB.
          </p>
        </div>
      </div>

      {/* Glossary of Terms & Shortcuts */}
      <section className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 sm:p-6 space-y-4 shadow-xs">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
            <HelpCircle className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-zinc-100">
              Giải thích thuật ngữ và Phím tắt
            </h3>
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              Giải nghĩa nhanh các tên tệp kỹ thuật, khái niệm AI thường gặp và
              phím tắt thao tác nhanh trong ứng dụng.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {GLOSSARY_OF_TERMS.map((entry) => (
            <div
              key={entry.term}
              className="rounded-xl border border-slate-200/80 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-950/60 p-4 space-y-1"
            >
              <div className="font-semibold text-sm text-slate-900 dark:text-zinc-100">
                {entry.term}
              </div>
              <div className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
                {entry.meaning}
              </div>
              <p className="text-xs text-slate-600 dark:text-zinc-400 leading-relaxed">
                {entry.detail}
              </p>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 pt-2 text-xs text-slate-500 dark:text-zinc-400">
          <ImageIcon className="w-4 h-4 text-sky-500 shrink-0" />
          <span>
            Mẹo: Bạn có thể đặt ảnh động hướng dẫn cá nhân vào thư mục{' '}
            <code>frontend/public/guides/</code> theo tên từng mục (ví dụ{' '}
            <code>chapters.gif</code>, <code>proofread.gif</code>) để hiển thị
            ngay trong ngăn Hướng dẫn bên phải.
          </span>
        </div>
      </section>
    </div>
  )
}
