import { useTransition, type ReactNode } from 'react'
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

/**
 * 底部分頁列(寬螢幕時 CSS 把它移到頂端)。
 *
 * React Router 預設把導覽包在 startTransition 裡,所以在頁面 chunk 載入完成前,
 * 畫面會**停在舊頁面**不動 —— 使用者看到的是「點了沒反應」。這裡自己拿 useTransition
 * 的 isPending,在分頁列上緣畫一條進度條,讓「已經收到你的點擊」看得見。
 * 另外在 pointerdown 就開始抓那一頁的 chunk,多半根本不會看到進度條。
 *
 * 在子頁面(例如牌組詳情)再點一次所在的分頁,會回到分頁的第一層,跟 iOS 一樣。
 */
export function TabBar({ tabs }: { tabs: Tab[] }) {
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  const [pending, startTransition] = useTransition()
  // 背景同步失敗時在「設定」分頁掛個紅點,不打斷正在複習的人
  const syncError = useLiveQuery(() => db.meta.get('sync_error'), [])

  return (
    <nav className="tabbar" aria-label="主要分頁">
      {tabs.map(({ to, label, icon, match, prefetch }) => {
        const active = match(pathname)
        const atRoot = pathname === to && search === ''
        return (
          <Link
            key={to}
            to={to}
            className={active ? 'active' : undefined}
            aria-current={active ? 'page' : undefined}
            onPointerDown={() => { void prefetch?.().catch(() => {}) }}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
              e.preventDefault()
              if (atRoot) { window.scrollTo({ top: 0, behavior: scrollBehavior() }); return }
              startTransition(() => navigate(to))
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
