import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

/** 分段控制(iOS segmented control),語意上是一組單選 */
export function Segmented<T extends string>({ value, options, onChange, label, disabled }: {
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
  label: string
  disabled?: boolean
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
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
        <button key={v} type="button" role="radio" aria-checked={v === value} disabled={disabled}
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
 * 現在的焦點是不是用鍵盤走過去的(:focus-visible)。滑鼠、手指點的不算;不認得這個選擇器的舊瀏覽器當不是。
 * 要在動作一開始就讀(確認框、busy 停用按鈕之前),之後焦點已經不在原處了。
 */
export function keyboardFocused(el: Element | null = document.activeElement): boolean {
  if (!(el instanceof HTMLElement)) return false
  try {
    return el.matches(':focus-visible')
  } catch {
    return false
  }
}

/**
 * 底部的短暫提示。show() 顯示幾秒後自己消失,可以帶一顆動作鈕(例如「復原」);回傳的 node 放在頁面最後面。
 * 有動作的留久一點(至少 8 秒),滑鼠移上去、或用鍵盤走到上面時暫停倒數 —— 用鍵盤或讀螢幕的人要一點時間才走得到「復原」。
 * 讀螢幕唸的是一塊一直都在的 live region(剛插進頁面的 role=status 在 iOS VoiceOver 常常不唸)。
 * focusAction:用鍵盤做的動作,原本的焦點跟著消失了(例如刪掉的那一列),把焦點放到「復原」上,不讓它掉到頁首。
 * 滑鼠、觸控不要傳(見 keyboardFocused):焦點被放到「復原」上,之後按空白鍵捲頁就變成按了「復原」。
 */
export function useToast(duration = 4000) {
  const [toast, setToast] = useState<{ text: string; action?: ToastAction } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const timer = useRef(0)
  const announceTimer = useRef(0)
  const current = useRef<{ text: string; action?: ToastAction } | null>(null)
  const held = useRef(false) // 滑鼠在上面或鍵盤焦點在裡面
  const boxRef = useRef<HTMLDivElement>(null)
  const actionRef = useRef<HTMLButtonElement>(null)
  const wantFocus = useRef(false)
  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(announceTimer.current) }, [])
  // 播報先清空再寫(稍等一下,讀螢幕才不會把兩次改動併成一次):同一句話再說一次也會唸。
  // 提示條收掉時也清掉,不留一句已經按不到的「可以按「復原」」
  const announce = useCallback((text: string) => {
    clearTimeout(announceTimer.current)
    setAnnouncement('')
    if (text !== '') announceTimer.current = window.setTimeout(() => setAnnouncement(text), 100)
  }, [])
  const hide = useCallback(() => {
    clearTimeout(timer.current)
    current.current = null
    held.current = false
    setToast(null)
    announce('')
  }, [announce])
  const arm = useCallback(() => {
    clearTimeout(timer.current)
    const t = current.current
    if (t === null || held.current) return
    timer.current = window.setTimeout(hide, t.action ? Math.max(duration, 8000) : duration)
  }, [duration, hide])
  const show = useCallback((text: string, action?: ToastAction, opts?: { focusAction?: boolean }) => {
    current.current = { text, action }
    held.current = false
    wantFocus.current = opts?.focusAction === true && action !== undefined
    setToast(current.current)
    announce(action ? `${text}（可以按「${action.label}」）` : text)
    arm()
  }, [arm, announce])
  useEffect(() => {
    if (toast === null || !wantFocus.current) return
    wantFocus.current = false
    actionRef.current?.focus()
  }, [toast])
  const hold = () => { held.current = true; clearTimeout(timer.current) }
  // 滑鼠移開時鍵盤焦點還在「復原」上:繼續等(不然提示條在焦點底下消失,焦點又掉到頁首)
  const release = () => {
    if (boxRef.current?.contains(document.activeElement)) return
    held.current = false
    arm()
  }
  const node = (
    <>
      <p className="visually-hidden" aria-live="polite">{announcement}</p>
      {toast !== null && (
        <div ref={boxRef} className={`toast${toast.action ? '' : ' no-action'}`}
          onMouseEnter={hold} onMouseLeave={release} onBlur={release}
          onFocus={(e) => { if (keyboardFocused(e.target)) hold() }}>
          {/* 內容已經由上面的 live region 唸過,滑過去時不必再唸一次 */}
          <span aria-hidden="true">{toast.text}</span>
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
