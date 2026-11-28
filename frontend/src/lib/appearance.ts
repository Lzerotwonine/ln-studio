export type ThemePreset = 'light' | 'sepia' | 'soft-gray' | 'dark' | 'midnight'
export type FontPreset = 'system' | 'serif' | 'sans' | 'mono'
export type FontScale = 95 | 100 | 112 | 125
export type DensityMode = 'comfortable' | 'compact'
export type IconScale = 'normal' | 'large'

export interface AppearanceSettings {
  themePreset: ThemePreset
  fontPreset: FontPreset
  fontScale: FontScale
  density: DensityMode
  iconScale: IconScale
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  themePreset: 'light',
  fontPreset: 'system',
  fontScale: 100,
  density: 'comfortable',
  iconScale: 'normal',
}

const STORAGE_APPEARANCE_KEY = 'ln-studio-appearance'
const LEGACY_THEME_KEY = 'ln-studio-theme'

export const THEME_PRESETS: Array<{
  id: ThemePreset
  label: string
  desc: string
  isDark: boolean
  swatchBg: string
  swatchSurface: string
  swatchText: string
  swatchAccent: string
}> = [
  {
    id: 'light',
    label: 'Sáng gọn',
    desc: 'Nền trắng sáng, tương phản rõ nét',
    isDark: false,
    swatchBg: '#f8fafc',
    swatchSurface: '#ffffff',
    swatchText: '#0f172a',
    swatchAccent: '#4f46e5',
  },
  {
    id: 'sepia',
    label: 'Giấy vàng dịu mắt',
    desc: 'Tông giấy sách ấm, giảm mỏi mắt khi đọc lâu',
    isDark: false,
    swatchBg: '#f4ecd8',
    swatchSurface: '#fbf6ea',
    swatchText: '#332618',
    swatchAccent: '#9a5b13',
  },
  {
    id: 'soft-gray',
    label: 'Xám dịu',
    desc: 'Nền xám nhẹ bớt chói, dễ tập trung',
    isDark: false,
    swatchBg: '#eaedf2',
    swatchSurface: '#f6f7f9',
    swatchText: '#1e293b',
    swatchAccent: '#4f46e5',
  },
  {
    id: 'dark',
    label: 'Tối',
    desc: 'Nền tối chuẩn, cân bằng dịu mắt',
    isDark: true,
    swatchBg: '#09090b',
    swatchSurface: '#18181b',
    swatchText: '#f4f4f5',
    swatchAccent: '#6366f1',
  },
  {
    id: 'midnight',
    label: 'Đêm sâu',
    desc: 'Nền xanh đen sâu, dịu mắt ban đêm',
    isDark: true,
    swatchBg: '#03060d',
    swatchSurface: '#0c1322',
    swatchText: '#e6edf8',
    swatchAccent: '#818cf8',
  },
]

export const FONT_PRESETS: Array<{
  id: FontPreset
  label: string
  desc: string
  previewFamily: string
}> = [
  {
    id: 'system',
    label: 'Hệ thống',
    desc: 'Phông chữ gốc sắc nét trên thiết bị',
    previewFamily: "Inter, 'Segoe UI', system-ui, -apple-system, sans-serif",
  },
  {
    id: 'serif',
    label: 'Đọc sách',
    desc: 'Chữ có chân mềm mại, giống sách in',
    previewFamily: "Georgia, 'Noto Serif', 'Times New Roman', serif",
  },
  {
    id: 'sans',
    label: 'Hiện đại',
    desc: 'Chữ không chân thoáng và tròn nét',
    previewFamily: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  },
  {
    id: 'mono',
    label: 'Đơn cách',
    desc: 'Chữ đều bề rộng cho khung soạn thảo và đối chiếu',
    previewFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
  },
]

export const FONT_SCALE_OPTIONS: Array<{ value: FontScale; label: string }> = [
  { value: 95, label: 'Nhỏ (95%)' },
  { value: 100, label: 'Vừa (100%)' },
  { value: 112, label: 'Lớn (112%)' },
  { value: 125, label: 'Rất lớn (125%)' },
]

export function isDarkPreset(preset: ThemePreset): boolean {
  return preset === 'dark' || preset === 'midnight'
}

export function loadAppearanceSettings(): AppearanceSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_APPEARANCE }
  try {
    const raw = window.localStorage.getItem(STORAGE_APPEARANCE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppearanceSettings>
      const validThemes: ThemePreset[] = [
        'light',
        'sepia',
        'soft-gray',
        'dark',
        'midnight',
      ]
      const validFonts: FontPreset[] = ['system', 'serif', 'sans', 'mono']
      const validScales: FontScale[] = [95, 100, 112, 125]
      return {
        themePreset: validThemes.includes(parsed.themePreset as ThemePreset)
          ? (parsed.themePreset as ThemePreset)
          : DEFAULT_APPEARANCE.themePreset,
        fontPreset: validFonts.includes(parsed.fontPreset as FontPreset)
          ? (parsed.fontPreset as FontPreset)
          : DEFAULT_APPEARANCE.fontPreset,
        fontScale: validScales.includes(parsed.fontScale as FontScale)
          ? (parsed.fontScale as FontScale)
          : DEFAULT_APPEARANCE.fontScale,
        density:
          parsed.density === 'compact' || parsed.density === 'comfortable'
            ? parsed.density
            : DEFAULT_APPEARANCE.density,
        iconScale:
          parsed.iconScale === 'large' || parsed.iconScale === 'normal'
            ? parsed.iconScale
            : DEFAULT_APPEARANCE.iconScale,
      }
    }
  } catch {
    // ignore malformed localStorage
  }

  // Migrate legacy light/dark preference cleanly
  const legacy = window.localStorage.getItem(LEGACY_THEME_KEY)
  if (legacy === 'dark') {
    return { ...DEFAULT_APPEARANCE, themePreset: 'dark' }
  }
  if (legacy === 'light') {
    return { ...DEFAULT_APPEARANCE, themePreset: 'light' }
  }
  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return { ...DEFAULT_APPEARANCE, themePreset: 'dark' }
  }
  return { ...DEFAULT_APPEARANCE }
}

export function saveAppearanceSettings(settings: AppearanceSettings): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      STORAGE_APPEARANCE_KEY,
      JSON.stringify(settings),
    )
    window.localStorage.setItem(
      LEGACY_THEME_KEY,
      isDarkPreset(settings.themePreset) ? 'dark' : 'light',
    )
  } catch {
    // ignore quota errors
  }
}

export function applyAppearanceToDom(settings: AppearanceSettings): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const dark = isDarkPreset(settings.themePreset)

  root.classList.toggle('dark', dark)
  root.setAttribute('data-theme-preset', settings.themePreset)
  root.setAttribute('data-font-preset', settings.fontPreset)
  root.setAttribute('data-density', settings.density)
  root.setAttribute('data-icon-size', settings.iconScale)

  root.style.setProperty('--app-font-scale', String(settings.fontScale / 100))
  root.style.setProperty(
    '--app-icon-scale',
    settings.iconScale === 'large' ? '1.18' : '1',
  )
}
