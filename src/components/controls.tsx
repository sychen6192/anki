import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

/** 分段控制(iOS segmented control),語意上是一組單選 */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
  label: string
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const i = options.findIndex(([v]) => v === value)
    const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length]
    onChange(next[0])
    const buttons = e.currentTarget.querySelectorAll('button')
    buttons[options.indexOf(next)]?.focus()
  }
  return (
    <div className="segmented" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={v === value}
          tabIndex={v === value ? 0 : -1} onClick={() => onChange(v)}><span>{text}</span></button>
      ))}
    </div>
  )
}

/** 開關:原生 checkbox 換 iOS 外觀,讀螢幕軟體念成「開關」 */
export function Switch({ checked, onChange, label, disabled }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <input type="checkbox" role="switch" className="switch" aria-label={label}
      checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
  )
}

/** 分組列表的一段:小標題 + 白底圓角列表 + 底下小字 */
export function ListSection({ header, footer, children, withIcons, className }: {
  header?: ReactNode
  footer?: ReactNode
  children: ReactNode
  withIcons?: boolean
  className?: string
}) {
  return (
    <section className={`list-section${className ? ` ${className}` : ''}`}>
      {header !== undefined && <h2 className="list-header">{header}</h2>}
      <div className={`list${withIcons ? ' with-icons' : ''}`}>{children}</div>
      {footer !== undefined && <div className="list-footer">{footer}</div>}
    </section>
  )
}

export interface ToastAction { label: string; onClick: () => void }

/**
 * 底部的短暫提示。show() 顯示幾秒後自己消失,可以帶一顆動作鈕(例如「復原」);回傳的 node 放在頁面最後面。
 * 有動作的留久一點(至少 8 秒),滑鼠移上去或焦點在上面時暫停倒數 —— 用鍵盤或讀螢幕的人要一點時間才走得到「復原」。
 * 讀螢幕唸的是一塊一直都在的 live region(剛插進頁面的 role=status 在 iOS VoiceOver 常常不唸)。
 * focusAction:原本的焦點跟著動作消失了(例如刪掉的那一列),把焦點放到「復原」上,不讓它掉到頁首。
 */
export function useToast(duration = 4000) {
  const [toast, setToast] = useState<{ text: string; action?: ToastAction } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const timer = useRef(0)
  const current = useRef<{ text: string; action?: ToastAction } | null>(null)
  const held = useRef(false) // 滑鼠在上面或焦點在裡面
  const actionRef = useRef<HTMLButtonElement>(null)
  const wantFocus = useRef(false)
  useEffect(() => () => clearTimeout(timer.current), [])
  const arm = useCallback(() => {
    clearTimeout(timer.current)
    const t = current.current
    if (t === null || held.current) return
    timer.current = window.setTimeout(() => { current.current = null; setToast(null) }, t.action ? Math.max(duration, 8000) : duration)
  }, [duration])
  const show = useCallback((text: string, action?: ToastAction, opts?: { focusAction?: boolean }) => {
    current.current = { text, action }
    held.current = false
    wantFocus.current = opts?.focusAction === true && action !== undefined
    setToast(current.current)
    setAnnouncement(action ? `${text}（可以按「${action.label}」）` : text)
    arm()
  }, [arm])
  useEffect(() => {
    if (toast === null || !wantFocus.current) return
    wantFocus.current = false
    actionRef.current?.focus()
  }, [toast])
  const hide = useCallback(() => {
    clearTimeout(timer.current)
    current.current = null
    held.current = false
    setToast(null)
  }, [])
  const hold = () => { held.current = true; clearTimeout(timer.current) }
  const release = () => { held.current = false; arm() }
  const node = (
    <>
      <p className="visually-hidden" aria-live="polite">{announcement}</p>
      {toast !== null && (
        <div className={`toast${toast.action ? '' : ' no-action'}`}
          onMouseEnter={hold} onMouseLeave={release} onFocus={hold} onBlur={release}>
          <span>{toast.text}</span>
          {toast.action && (
            <button ref={actionRef} type="button" className="link" onClick={() => { hide(); toast.action?.onClick() }}>
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </>
  )
  return { node, show, hide, visible: toast !== null }
}
