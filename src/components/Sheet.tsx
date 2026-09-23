import { useEffect, useRef, type MouseEvent, type ReactNode, type SyntheticEvent } from 'react'

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

/** 共用:用原生 <dialog> 的 showModal(焦點鎖在裡面、Esc 關閉、背景不能點) */
function useModalDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (d === null) return
    if (open && !d.open) {
      // jsdom 或很舊的瀏覽器沒有 showModal:退回 open 屬性,至少看得到
      if (typeof d.showModal === 'function') d.showModal()
      else d.setAttribute('open', '')
    } else if (!open && d.open) {
      d.close()
    }
  }, [open])
  useScrollLock(open)
  const dialogProps = {
    ref,
    // Esc:交給父層決定要不要關(不讓瀏覽器自己關,狀態才不會不同步)
    onCancel: (e: SyntheticEvent) => { e.preventDefault(); onClose() },
    // 點到 dialog 本身(= 背景那層)就關閉;點到內容的事件 target 會是裡面的元素
    onClick: (e: MouseEvent) => { if (e.target === e.currentTarget) onClose() },
  }
  return dialogProps
}

interface SheetProps {
  open: boolean
  onClose: () => void
  title: string
  /** 表單用:幾乎滿版、貼齊上方,鍵盤跳出時欄位不會被擋住 */
  full?: boolean
  /** 左上角,預設是「取消」 */
  start?: ReactNode
  /** 右上角(例如「儲存」「完成」) */
  end?: ReactNode
  children: ReactNode
}

/** 底部面板:新增/編輯卡片、牌組設定、分享…。關起來時不渲染內容,下次打開是乾淨的狀態 */
export function Sheet({ open, onClose, title, full, start, end, children }: SheetProps) {
  const dialogProps = useModalDialog(open, onClose)
  return (
    <dialog {...dialogProps} className={`sheet${full ? ' full' : ''}`} aria-label={title}>
      {open && (
        <>
          <div className="sheet-grabber" aria-hidden="true" />
          <div className="sheet-header">
            <div className="start">
              {start ?? <button type="button" className="btn plain" onClick={onClose}>取消</button>}
            </div>
            <div className="sheet-title">{title}</div>
            <div className="end">{end}</div>
          </div>
          <div className="sheet-body">{children}</div>
        </>
      )}
    </dialog>
  )
}

export interface SheetAction {
  label: string
  icon?: ReactNode
  onSelect: () => void
  destructive?: boolean
  disabled?: boolean
}

interface ActionSheetProps {
  open: boolean
  onClose: () => void
  title?: string
  message?: string
  actions: (SheetAction | false | null | undefined)[]
}

/** iOS 的動作選單:一列一個動作,危險動作紅字,下面分開一顆「取消」 */
export function ActionSheet({ open, onClose, title, message, actions }: ActionSheetProps) {
  const dialogProps = useModalDialog(open, onClose)
  const items = actions.filter((a): a is SheetAction => Boolean(a))
  return (
    <dialog {...dialogProps} className="action-sheet" aria-label={title ?? '動作'}>
      {open && (
        <>
          <div className="action-group">
            {(title !== undefined || message !== undefined) && (
              <div className="action-head">
                {title !== undefined && <div className="action-title">{title}</div>}
                {message !== undefined && <div className="action-message">{message}</div>}
              </div>
            )}
            {items.map((a) => (
              <button key={a.label} type="button" disabled={a.disabled}
                className={`action${a.destructive ? ' destructive' : ''}`}
                onClick={() => { onClose(); a.onSelect() }}>
                {a.icon}{a.label}
              </button>
            ))}
          </div>
          <div className="action-group">
            <button type="button" className="action cancel" onClick={onClose}>取消</button>
          </div>
        </>
      )}
    </dialog>
  )
}

export { useModalDialog }
