/**
 * 深淺色主題:預設跟隨系統,設定頁可鎖定淺色/深色。
 * JS 統一把解析結果寫進 <html data-theme>,CSS 只認 data-theme,
 * 不再直接讀 prefers-color-scheme(兩邊都認會打架)。
 */

export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'theme'
// 和 tokens.css 的 --bg 一致:狀態列跟頁面同色,深色模式才不會在頂端多一條灰帶
const BG = { light: '#f2f2f7', dark: '#000000' } as const

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)')

function apply(pref: ThemePref): void {
  const mode = pref === 'system' ? (systemDark().matches ? 'dark' : 'light') : pref
  document.documentElement.dataset.theme = mode
  // 狀態列/瀏覽器框顏色跟著走(index.html 的 meta 由這裡接手)
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    m.content = BG[mode]
  }
}

export function setThemePref(pref: ThemePref): void {
  if (pref === 'system') localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, pref)
  apply(pref)
}

export function initTheme(): void {
  apply(getThemePref())
  systemDark().addEventListener('change', () => {
    if (getThemePref() === 'system') apply('system')
  })
}
