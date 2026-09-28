import { scrollBehavior } from './motion'

/**
 * 頁面在 App 殼層的 .scroller 裡捲動,整個文件本身不捲(見 App.tsx 的 Shell 與 base.css)。
 * 分頁列放在捲動區外面:iPhone 上頁面還在慣性捲動時點分頁,WebKit 會把「落在正在減速的
 * 那個捲動區」的點擊拿去停住捲動、完全不送給網頁 —— 分頁列不在捲動區上,就不會被吃掉。
 * 沒有殼層的時候(測試)退回 window。
 */
export function pageScroller(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.scroller')
}

export function pageScrollTop(): number {
  const el = pageScroller()
  return el !== null ? el.scrollTop : window.scrollY
}

/** smooth:照使用者的「減少動態效果」決定要不要動畫 */
export function scrollPageTo(top: number, smooth = false): void {
  const opts: ScrollToOptions = { top, behavior: smooth ? scrollBehavior() : 'auto' }
  const el = pageScroller()
  if (el !== null) el.scrollTo(opts)
  else window.scrollTo(opts)
}

export function onPageScroll(listener: () => void): () => void {
  const target: HTMLElement | Window = pageScroller() ?? window
  target.addEventListener('scroll', listener, { passive: true })
  return () => target.removeEventListener('scroll', listener)
}
