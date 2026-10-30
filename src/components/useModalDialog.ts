import {
  useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type SyntheticEvent,
} from 'react'

/** 正在播關閉動畫的對話框。order:打開的先後(後開的疊在上面) */
interface Exit { order: number; finish: () => void; timer: number }
const exits = new Set<Exit>()
let openedCount = 0
// 只是保險:animationend 沒來(分頁在背景)也照樣收掉。不能貼著 .2s 設:動畫從下一次畫面更新才開始算,
// 量過慢的機器晚了七十幾 ms 才播完,設 250ms 會把最後一截切掉
const EXIT_FALLBACK_MS = 400

/** 把還在播關閉動畫的對話框直接收掉:要打開另一個對話框時用,畫面和以前一樣是「舊的不見、新的升起」 */
export function finishClosingDialogs(): void {
  for (const x of [...exits]) x.finish()
}

/**
 * 共用:用原生 <dialog> 的 showModal(焦點鎖在裡面、Esc 關閉、背景不能點)。
 *
 * 打開用 layout effect:點按鈕 → setState → React 在同一個點擊事件裡同步 commit,
 * showModal 與 focus 也就還在「使用者手勢」之內 —— iOS 只有這樣才會把鍵盤叫出來。
 * 要一打開就聚焦的欄位標 data-autofocus(React 的 autoFocus 會在 dialog 還沒打開時就 focus,沒用)。
 *
 * 關閉動畫(反著播進場,見 components.css 的 data-closing)只是畫面:對話框照舊當下就 close(),
 * 焦點還給打開它的那顆、底下的頁面也馬上能用,和沒有動畫時一模一樣 —— 頁面在這時候搬焦點也搬得動
 * (刪掉一個字後焦點放到「復原」、複習頁換到下一張卡)。要是等動畫播完才 close(),
 * 那 0.2 秒裡頁面還被 modal 擋著,這些 focus() 都會默默失敗。
 * 關掉之後同一個元素改用 manual popover 留在最上層播完動畫(不是 modal,不擋頁面、不搶焦點),
 * 設成 inert,點擊、鍵盤、讀螢幕都碰不到;這段期間 visible 還是 true,呼叫端照畫內容。
 * 「減少動態效果」或沒有 popover 的瀏覽器(iOS 16 以前)照舊直接關。
 *
 * 不必另外鎖住底下頁面的捲動:文件本身不捲,頁面在 .scroller 裡捲(見 lib/scroller.ts),
 * 而 dialog 在最上層、不在 .scroller 裡 —— 拖背景、捲到面板盡頭都傳不到頁面。
 * (以前把 .scroller 設成 overflow: hidden 來鎖,iPhone 上每開關一次面板就要重建一次整頁的捲動層)
 */
export function useModalDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null)
  // 打開過、還沒收完(包含關閉動畫那段)。打開的那一次 render 就設好:關的那一次 render 內容才不會先被拿掉
  const [shown, setShown] = useState(open)
  if (open && !shown) setShown(true)
  const order = useRef(0)
  const exit = useRef<Exit | null>(null)

  useLayoutEffect(() => {
    const d = ref.current
    if (d === null) return
    if (open) {
      // 關閉動畫播到一半又要打開(例如複習頁按 E):收掉動畫,照常打開
      exit.current?.finish()
      if (d.open) return
      // 另一個還在播關閉動畫(選單的「牌組設定」:同一下點擊裡先關選單、再開面板):收掉,不和新的疊在一起
      finishClosingDialogs()
      order.current = ++openedCount
      // jsdom 或很舊的瀏覽器沒有 showModal:退回 open 屬性,至少看得到
      if (typeof d.showModal === 'function') d.showModal()
      else d.setAttribute('open', '')
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus()
      return
    }
    if (exit.current !== null) return
    // 瀏覽器自己關掉的(擋不下來的關閉要求)也要把內容拿掉,下次打開才是乾淨的
    if (!d.open) { setShown(false); return }
    d.close()
    if (typeof d.showPopover !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setShown(false)
      return
    }
    d.setAttribute('popover', 'manual')
    d.inert = true
    try {
      d.showPopover()
    } catch {
      // 叫不出來就算了,和沒有動畫時一樣直接關(不能讓 layout effect 丟錯把整頁弄壞)
      d.removeAttribute('popover')
      d.inert = false
      setShown(false)
      return
    }
    d.dataset.closing = ''
    const me: Exit = {
      order: order.current,
      timer: 0,
      finish: () => {
        if (exit.current !== me) return
        exit.current = null
        exits.delete(me)
        clearTimeout(me.timer)
        d.removeEventListener('animationend', onEnd)
        // showModal 不能開在還是 popover 的元素上:屬性一起拿掉
        if (d.matches(':popover-open')) d.hidePopover()
        d.removeAttribute('popover')
        delete d.dataset.closing
        d.inert = false
        setShown(false)
      },
    }
    // 只認對話框自己(和它的 ::backdrop)的動畫:裡面的轉圈、提示的動畫也會冒泡上來
    const onEnd = (e: AnimationEvent) => { if (e.target === d) me.finish() }
    d.addEventListener('animationend', onEnd)
    me.timer = window.setTimeout(me.finish, EXIT_FALLBACK_MS)
    exit.current = me
    exits.add(me)
    // 剛 showPopover 的排在最上層:原本疊在它上面、也在播關閉動畫的(「捨棄」的確認框,下一格面板才關)
    // 會被它蓋住,直接收掉
    for (const x of [...exits]) if (x.order > me.order) x.finish()
    // 沒有關閉動畫可播(CSS 沒套上):不必乾等保險的計時器
    if (typeof d.getAnimations === 'function' && d.getAnimations().length === 0) me.finish()
  }, [open])

  // 關到一半整頁被換掉(例如選單裡的「匯入」):計時器別留著
  useEffect(() => () => {
    const x = exit.current
    if (x === null) return
    clearTimeout(x.timer)
    exits.delete(x)
    exit.current = null
  }, [])

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
  return { dialogProps, visible: open || shown }
}

/** 關閉動畫期間照畫最後一次打開時的內容:父層關的同時就把表單清空、標題換掉,滑下去的不該是一張空白的面板 */
export function useLastOpen<T>(open: boolean, value: T): T {
  const last = useRef(value)
  if (open) last.current = value
  return last.current
}
