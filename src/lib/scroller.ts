import { scrollBehavior } from './motion'

/**
 * 頁面在 App 殼層的 .scroller 裡捲動,整個文件本身不捲(見 App.tsx 的 Shell 與 base.css)。
 * 分頁列放在捲動區外面:iPhone 上頁面還在慣性捲動時點分頁,WebKit 會把「落在正在減速的
 * 那個捲動區」的點擊拿去停住捲動、完全不送給網頁 —— 分頁列不在捲動區上,就不會被吃掉。
 * 沒有殼層的時候(測試)退回 window。
 */
export function pageScroller(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const el = document.querySelector<HTMLElement>('.scroller')
  if (el !== null) trackScrolling(el)
  return el
}

// 最近一次捲動的時間:還在捲(慣性)的時候跳到頂端,要先把慣性停掉(見 scrollPageTo)
const lastScrollAt = new WeakMap<HTMLElement, number>()
function trackScrolling(el: HTMLElement) {
  if (lastScrollAt.has(el)) return
  lastScrollAt.set(el, 0)
  el.addEventListener('scroll', () => { lastScrollAt.set(el, performance.now()) }, { passive: true })
}

export function pageScrollTop(): number {
  const el = pageScroller()
  return el !== null ? el.scrollTop : window.scrollY
}

/**
 * 捲到 top。smooth:照使用者的「減少動態效果」決定要不要動畫。
 * iOS 27 起,scrollTo 不再打斷使用者的慣性捲動(Safari 27 release notes 41949531):
 * 在慣性捲動時換頁,新頁面會接著往下滑。所以剛捲過的話,先讓捲動區暫時不能捲 ——
 * WebKit 會拆掉它的捲動層,慣性跟著停 —— 過兩個 frame 再放開、捲過去。
 * stopMomentum:不管剛才有沒有收到捲動事件都先停(換頁用:主執行緒忙的時候捲動事件會晚到,光看時間會漏)。
 * 只在觸控裝置上這樣做:桌機沒有慣性問題,切 overflow 反而讓捲軸閃一下、版面跳動。
 *
 * 另外,頁面在內層捲之後 iPhone 點狀態列捲回頂端不管用了(WebKit 把內層捲動區的 scrollsToTop 關掉):
 * 改成點所在的分頁、點導覽列的小標題、複習時點進度條捲回頂端。
 */
export function scrollPageTo(top: number, smooth = false, stopMomentum = false): void {
  const behavior: ScrollBehavior = smooth ? scrollBehavior() : 'auto'
  const el = pageScroller()
  if (el === null) { window.scrollTo({ top, behavior }); return }
  const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0
  const moving = performance.now() - (lastScrollAt.get(el) ?? 0) < 150
    || (stopMomentum && Math.abs(el.scrollTop - top) > 1)
  if (!touch || !moving || el.style.overflowY === 'hidden') { el.scrollTo({ top, behavior }); return }
  el.style.overflowY = 'hidden'
  if (behavior === 'auto') el.scrollTop = top
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.overflowY = ''
    el.scrollTo({ top, behavior })
  }))
}

export function onPageScroll(listener: () => void): () => void {
  const target: HTMLElement | Window = pageScroller() ?? window
  target.addEventListener('scroll', listener, { passive: true })
  return () => target.removeEventListener('scroll', listener)
}
