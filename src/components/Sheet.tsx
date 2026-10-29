import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { useConfirm } from './Confirm'
import { finishClosingDialogs, useLastOpen, useModalDialog } from './useModalDialog'

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
        // 繼續編輯:瀏覽器可能已經自己把面板關掉了(擋不下來的關閉要求,例如 Android 的返回手勢),重新打開。
        // 確認框這時還在播關閉動畫:先關好它,面板才不會疊到它上面
        const d = dialogProps.ref.current
        if (d !== null && !d.open && typeof d.showModal === 'function') { finishClosingDialogs(); d.showModal() }
      }
    } finally {
      asking.current = false
    }
  }
  const { dialogProps, visible } = useModalDialog(open, () => void requestClose())
  // 關閉動畫期間 --vvh 照留:拿掉的話滑到一半會突然換成整個畫面的高度
  useVisualViewport(dialogProps.ref, visible)
  const s = useLastOpen(open, { title, full, start, cancelLabel, end, children })
  return (
    <dialog {...dialogProps} className={`sheet${s.full ? ' full' : ''}`} aria-label={s.title}>
      {visible && (
        <>
          <div className="sheet-header">
            <div className="start">
              {s.start ?? <button type="button" className="btn plain" onClick={() => void requestClose()}>{s.cancelLabel ?? '取消'}</button>}
            </div>
            <div className="sheet-title">{s.title}</div>
            <div className="end">{s.end}</div>
          </div>
          <div className="sheet-body">{s.children}</div>
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
  /** 目前選中的那一個(例如現在的排序):讀螢幕唸成「目前」;畫面上的勾由呼叫端放進 icon,不寫進 label */
  current?: boolean
  /** 鍵盤快捷鍵(例如複習頁的 E):只在有實體鍵盤的裝置顯示(.kbd-hint) */
  hint?: string
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
  const { dialogProps, visible } = useModalDialog(open, onClose)
  const s = useLastOpen(open, { title, message, items: actions.filter((a): a is SheetAction => Boolean(a)) })
  return (
    <dialog {...dialogProps} className="action-sheet" aria-label={s.title ?? '動作'}>
      {visible && (
        <>
          <div className="action-group">
            {(s.title !== undefined || s.message !== undefined) && (
              <div className="action-head">
                {s.title !== undefined && <div className="action-title">{s.title}</div>}
                {s.message !== undefined && <div className="action-message">{s.message}</div>}
              </div>
            )}
            {s.items.map((a) => (
              <button key={a.label} type="button" disabled={a.disabled} aria-current={a.current || undefined}
                aria-keyshortcuts={a.hint} className={`action${a.destructive ? ' destructive' : ''}`}
                onClick={() => { onClose(); a.onSelect() }}>
                {/* 快捷鍵交給 aria-keyshortcuts 唸,字母本身不算進名稱(不然唸成「編輯這張E」) */}
                {a.icon}{a.label}{a.hint !== undefined && <span className="kbd-hint" aria-hidden="true">{a.hint}</span>}
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

