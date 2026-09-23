import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useModalDialog } from './useModalDialog'

export interface ConfirmOptions {
  title: string
  message?: string
  /** 確定鈕的字,預設「確定」;危險動作請寫清楚,例如「刪除」 */
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

// 沒包 Provider 的地方(例如單元測試)退回瀏覽器原生的 confirm
const fallback: ConfirmFn = async (o) =>
  typeof window !== 'undefined' && window.confirm(o.message ? `${o.title}\n${o.message}` : o.title)

const ConfirmContext = createContext<ConfirmFn>(fallback)

/** 取代 window.confirm():iOS 主畫面 App 裡原生的確認框會頂著網址,又不能把危險鈕標紅 */
export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext)
}

interface Pending extends ConfirmOptions { resolve: (ok: boolean) => void }

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const pendingRef = useRef<Pending | null>(null)
  pendingRef.current = pending

  const confirm = useCallback<ConfirmFn>((options) => new Promise<boolean>((resolve) => {
    // 同時又來一個:前一個當作取消
    pendingRef.current?.resolve(false)
    setPending({ ...options, resolve })
  }), [])

  const finish = useCallback((ok: boolean) => {
    const p = pendingRef.current
    if (p === null) return
    p.resolve(ok)
    setPending(null)
  }, [])

  // 卸載時別讓等待中的 promise 永遠懸著
  useEffect(() => () => pendingRef.current?.resolve(false), [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog pending={pending} onFinish={finish} />
    </ConfirmContext.Provider>
  )
}

function ConfirmDialog({ pending, onFinish }: { pending: Pending | null; onFinish: (ok: boolean) => void }) {
  const dialogProps = useModalDialog(pending !== null, () => onFinish(false))
  return (
    <dialog {...dialogProps} className="alert" role="alertdialog"
      aria-labelledby="confirm-title" aria-describedby={pending?.message ? 'confirm-message' : undefined}>
      {pending !== null && (
        <>
          <div className="alert-body">
            <div className="alert-title" id="confirm-title">{pending.title}</div>
            {pending.message && <div className="alert-message" id="confirm-message">{pending.message}</div>}
          </div>
          <div className="alert-actions">
            <button type="button" onClick={() => onFinish(false)}>{pending.cancelLabel ?? '取消'}</button>
            {/* 危險動作不給預設焦點,免得按 Enter 就刪掉 */}
            <button type="button" data-autofocus={pending.destructive ? undefined : ''}
              className={pending.destructive ? 'destructive' : 'primary'}
              onClick={() => onFinish(true)}>{pending.confirmLabel ?? '確定'}</button>
          </div>
        </>
      )}
    </dialog>
  )
}
