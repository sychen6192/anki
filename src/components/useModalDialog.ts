import { useEffect, useLayoutEffect, useRef, type MouseEvent, type PointerEvent, type SyntheticEvent } from 'react'

/** 開著 sheet 的時候鎖住底下頁面的捲動(iPhone 上拖背景會帶著整頁跑) */
function useScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return
    const html = document.documentElement
    const prev = html.style.overflow
    html.style.overflow = 'hidden'
    return () => { html.style.overflow = prev }
  }, [locked])
}

/**
 * 共用:用原生 <dialog> 的 showModal(焦點鎖在裡面、Esc 關閉、背景不能點)。
 *
 * 打開用 layout effect:點按鈕 → setState → React 在同一個點擊事件裡同步 commit,
 * showModal 與 focus 也就還在「使用者手勢」之內 —— iOS 只有這樣才會把鍵盤叫出來。
 * 要一打開就聚焦的欄位標 data-autofocus(React 的 autoFocus 會在 dialog 還沒打開時就 focus,沒用)。
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
  useScrollLock(open)
  // 按下去也在背景上才算「點背景」:在輸入框裡拖選文字、放開時滑到面板外,
  // click 會落在兩者共同的祖先(dialog 本身),不能因此把面板關掉
  const downOnBackdrop = useRef(false)
  const dialogProps = {
    ref,
    // Esc:交給父層決定要不要關(不讓瀏覽器自己關,狀態才不會不同步)
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
