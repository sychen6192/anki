import {
  useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type SyntheticEvent,
} from 'react'

// 好幾層疊在一起(確認框開在面板上)時,各自記「開之前的值」再寫回去會互相蓋掉,
// 關掉的順序一亂頁面就一直捲不動:用計數器,第一層打開時鎖、最後一層關掉才還原
let lockCount = 0
let savedOverflow = ''

/** 開著 sheet 的時候鎖住底下頁面的捲動(iPhone 上拖背景會帶著整頁跑) */
function useScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return
    const html = document.documentElement
    if (lockCount++ === 0) {
      savedOverflow = html.style.overflow
      html.style.overflow = 'hidden'
    }
    return () => {
      if (--lockCount === 0) html.style.overflow = savedOverflow
    }
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
