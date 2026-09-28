import {
  useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type SyntheticEvent,
} from 'react'

/**
 * 共用:用原生 <dialog> 的 showModal(焦點鎖在裡面、Esc 關閉、背景不能點)。
 *
 * 打開用 layout effect:點按鈕 → setState → React 在同一個點擊事件裡同步 commit,
 * showModal 與 focus 也就還在「使用者手勢」之內 —— iOS 只有這樣才會把鍵盤叫出來。
 * 要一打開就聚焦的欄位標 data-autofocus(React 的 autoFocus 會在 dialog 還沒打開時就 focus,沒用)。
 *
 * 不必另外鎖住底下頁面的捲動:文件本身不捲,頁面在 .scroller 裡捲(見 lib/scroller.ts),
 * 而 dialog 在最上層、不在 .scroller 裡 —— 拖背景、捲到面板盡頭都傳不到頁面。
 * (以前把 .scroller 設成 overflow: hidden 來鎖,iPhone 上每開關一次面板就要重建一次整頁的捲動層)
 */
export function useModalDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const d = ref.current
    if (d === null) return
    if (open && !d.open) {
      // jsdom 或很舊的瀏覽器沒有 showModal:退回 open 屬性,至少看得到
      if (typeof d.showModal === 'function') d.showModal()
      else d.setAttribute('open', '')
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    } else if (!open && d.open) {
      d.close()
    }
  }, [open])
  // 按下去也在背景上才算「點背景」:在輸入框裡拖選文字、放開時滑到面板外,
  // click 會落在兩者共同的祖先(dialog 本身),不能因此把面板關掉
  const downOnBackdrop = useRef(false)
  const dialogProps = {
    ref,
    // Esc 自己接:瀏覽器的 cancel 只讓網頁擋一次(Chrome 要有新的使用者操作才能再擋),連按幾次 Esc
    // 瀏覽器就自己把對話框關掉,React 卻還以為它開著 —— 頁面鎖著捲不動、面板再也叫不出來。
    // 選字中的 Esc 是取消選字,不算。這一下 Esc 到此為止:關掉的狀態已經生效,再往外傳,
    // 頁面自己的 Esc(例如複習畫面的「離開」)會以為沒有對話框開著而接著動作
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.nativeEvent.isComposing || e.keyCode === 229) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    },
    // 其他關閉要求(Android 的返回手勢):同樣交給父層決定要不要關。擋不下來時瀏覽器會自己關,
    // 見 Sheet 的「繼續編輯」會把它重新打開
    onCancel: (e: SyntheticEvent) => { e.preventDefault(); onClose() },
    onPointerDown: (e: PointerEvent) => { downOnBackdrop.current = e.target === e.currentTarget },
    // 點到 dialog 本身(= 背景那層)就關閉;點到內容的事件 target 會是裡面的元素
    onClick: (e: MouseEvent) => {
      const onBackdrop = e.target === e.currentTarget && downOnBackdrop.current
      downOnBackdrop.current = false
      if (onBackdrop) onClose()
    },
  }
  return dialogProps
}
