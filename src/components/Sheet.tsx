import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { useConfirm } from './Confirm'
import { useModalDialog } from './useModalDialog'

/**
 * 面板跟著「看得見的那一塊」走:iPhone 鍵盤跳出來時 100dvh 不會變,只有 visualViewport 變小 ——
 * 不跟著縮的話,滿版表單會被整個往上推、標題列的「儲存」被推出畫面,半高的面板則被鍵盤蓋住。
 * 高度與位置寫成 CSS 變數給 .sheet 用,焦點所在的欄位捲到看得見的地方。
 */
function useVisualViewport(ref: RefObject<HTMLDialogElement | null>, active: boolean) {
  useEffect(() => {
    const vv = window.visualViewport
    const d = ref.current
    if (!active || vv == null || d === null) return
    const update = () => {
      d.style.setProperty('--vvh', `${vv.height}px`)
      d.style.setProperty('--vv-top', `${vv.offsetTop}px`)
      const focused = document.activeElement
      if (focused instanceof HTMLElement && d.contains(focused)) focused.scrollIntoView({ block: 'nearest' })
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      d.style.removeProperty('--vvh')
      d.style.removeProperty('--vv-top')
    }
  }, [ref, active])
}

interface SheetProps {
  open: boolean
  onClose: () => void
  title: string
  /** 表單用:幾乎滿版、貼齊上方,鍵盤跳出時欄位不會被擋住 */
  full?: boolean
  /** 左上角,預設是「取消」 */
  start?: ReactNode
  /** 預設左上角按鈕的字(例如連續新增後是「完成」) */
  cancelLabel?: string
  /** 右上角(例如「儲存」「完成」) */
  end?: ReactNode
  /** 有沒存的變更:點背景、Esc、「取消」都先問要不要捨棄,不會默默丟掉打到一半的東西 */
  dirty?: boolean
  children: ReactNode
}

/** 底部面板:新增/編輯卡片、牌組設定、分享…。關起來時不渲染內容,下次打開是乾淨的狀態 */
export function Sheet({ open, onClose, title, full, start, cancelLabel, end, dirty, children }: SheetProps) {
  const confirm = useConfirm()
  const asking = useRef(false)
  const requestClose = async () => {
    if (!dirty) { onClose(); return }
    if (asking.current) return
    asking.current = true
    try {
      if (await confirm({ title: '捨棄沒存的變更？', confirmLabel: '捨棄', cancelLabel: '繼續編輯', destructive: true })) {
        // 等確認框先關好再關面板:同一次一起關,焦點還不回打開面板的那一列,會掉到頁首
        requestAnimationFrame(() => onClose())
      } else {
        // 繼續編輯:瀏覽器可能已經自己把面板關掉了(擋不下來的關閉要求,例如 Android 的返回手勢),重新打開
        const d = dialogProps.ref.current
        if (d !== null && !d.open && typeof d.showModal === 'function') d.showModal()
      }
    } finally {
      asking.current = false
    }
  }
  const dialogProps = useModalDialog(open, () => void requestClose())
  useVisualViewport(dialogProps.ref, open)
  return (
    <dialog {...dialogProps} className={`sheet${full ? ' full' : ''}`} aria-label={title}>
      {open && (
        <>
          <div className="sheet-header">
            <div className="start">
              {start ?? <button type="button" className="btn plain" onClick={() => void requestClose()}>{cancelLabel ?? '取消'}</button>}
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

