import { useOptimistic, useRef, useTransition, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { scrollBehavior } from '../lib/motion'

export interface Tab {
  to: string
  label: string
  icon: ReactNode
  /** 這個分頁底下還有哪些頁面(例如牌組詳情、匯入都算「牌組」) */
  match: (pathname: string) => boolean
  prefetch?: () => Promise<unknown>
}

/** 手指按下到放開移動超過這個距離就不算點(和瀏覽器的 touch slop 差不多) */
const TAP_SLOP = 10
/** 手指放開後等瀏覽器自己的 click 多久,沒等到才自己補 */
const CLICK_WAIT_MS = 80
/** 自己補做之後才晚到的 click 算同一下,不再換一次頁 */
const LATE_CLICK_MS = 1000

/**
 * 底部分頁列(寬螢幕時 CSS 把它移到頂端)。
 *
 * React Router 預設把導覽包在 startTransition 裡,新頁面畫好之前畫面會**停在舊頁面**,
 * useLocation 也還是舊的網址。所以點下去的分頁用 useOptimistic 立刻亮起來,
 * 分頁列上緣還有一條進度條(isPending);pointerdown 就開始抓那一頁的 chunk。
 *
 * Android 的 Chrome:頁面還在慣性捲動時按下去的那一下只拿來停住捲動,瀏覽器不送 click
 * (pointerdown / pointerup 照送)。手指在同一個分頁上按下又放開、沒有滑動,
 * 等一下還沒等到 click 就自己補做。iPhone 那種情況連 pointer 事件都不給網頁,這裡救不到。
 *
 * 在子頁面(例如牌組詳情)再點一次所在的分頁,會回到分頁的第一層,跟 iOS 一樣;
 * 已經在第一層就捲回頂端。
 */
export function TabBar({ tabs }: { tabs: Tab[] }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [pending, startTransition] = useTransition()
  const [shownPath, setShownPath] = useOptimistic(pathname)
  // 背景同步失敗時在「設定」分頁掛個紅點,不打斷正在複習的人
  const syncError = useLiveQuery(() => db.meta.get('sync_error'), [])
  const press = useRef<{ id: number; to: string; x: number; y: number } | null>(null)
  const fallback = useRef<number | undefined>(undefined)
  const filledIn = useRef<{ to: string; at: number } | null>(null)

  const go = (to: string) => {
    // 看 window.location 不看 useLocation:別的換頁還在畫的時候,網址已經換過去了
    if (window.location.pathname === to && window.location.search === '') {
      window.scrollTo({ top: 0, behavior: scrollBehavior() })
      return
    }
    startTransition(() => {
      setShownPath(to)
      navigate(to)
    })
  }

  return (
    <nav className="tabbar" aria-label="主要分頁">
      {tabs.map(({ to, label, icon, match, prefetch }) => {
        const active = match(shownPath)
        return (
          <Link
            key={to}
            to={to}
            className={active ? 'active' : undefined}
            aria-current={match(pathname) ? 'page' : undefined}
            onPointerDown={(e) => {
              void prefetch?.().catch(() => {})
              clearTimeout(fallback.current)
              filledIn.current = null
              press.current = e.pointerType !== 'mouse' && e.isPrimary
                ? { id: e.pointerId, to, x: e.clientX, y: e.clientY }
                : null
            }}
            onPointerCancel={() => { press.current = null }}
            onPointerUp={(e) => {
              const p = press.current
              press.current = null
              if (p === null || p.id !== e.pointerId || p.to !== to) return
              if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLOP) return
              const r = e.currentTarget.getBoundingClientRect()
              if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return
              clearTimeout(fallback.current)
              fallback.current = window.setTimeout(() => {
                filledIn.current = { to, at: performance.now() }
                go(to)
              }, CLICK_WAIT_MS)
            }}
            onClick={(e) => {
              clearTimeout(fallback.current)
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
              e.preventDefault()
              const f = filledIn.current
              filledIn.current = null
              if (f !== null && f.to === to && performance.now() - f.at < LATE_CLICK_MS) return
              go(to)
            }}
          >
            {icon}
            <span>{label}</span>
            {to === '/settings' && syncError !== undefined && (
              <span className="tab-dot" role="img" aria-label="上次同步失敗" />
            )}
          </Link>
        )
      })}
      <div className={`route-progress${pending ? ' active' : ''}`} aria-hidden="true" />
    </nav>
  )
}
