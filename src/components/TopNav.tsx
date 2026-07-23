import { useTransition } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'

export interface Tab { to: string; label: string; prefetch?: () => Promise<unknown> }

/**
 * React Router 預設把導覽包在 startTransition 裡,所以在頁面 chunk 載入完成前,
 * 畫面會**停在舊頁面**不動 —— Suspense 的 fallback 不會出現,使用者看到的是
 * 「點了沒反應」。這裡自己拿 useTransition 的 isPending,在導覽列下方畫一條
 * 進度條,至少讓「已經收到你的點擊、正在載入」這件事看得見。
 *
 * 另外在 pointerdown 就開始抓那一頁的 chunk:手指按下到放開通常有 100ms 以上,
 * 這段時間足夠把小 chunk 抓回來,實際上多半根本不會看到進度條。
 */
export function TopNav({ tabs }: { tabs: Tab[] }) {
  const navigate = useNavigate()
  const [pending, startTransition] = useTransition()
  // 背景同步失敗時在「設定」分頁掛個紅點,不打斷正在複習的人
  const syncError = useLiveQuery(() => db.meta.get('sync_error'), [])

  return (
    <>
      <nav className="topnav">
        {tabs.map(({ to, label, prefetch }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            onPointerDown={() => { void prefetch?.().catch(() => {}) }}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
              e.preventDefault()
              startTransition(() => navigate(to))
            }}
          >
            {label}
            {to === '/settings' && syncError !== undefined && (
              <span className="sync-error-dot" title="上次同步失敗" aria-label="上次同步失敗" />
            )}
          </NavLink>
        ))}
      </nav>
      <div className={`route-progress${pending ? ' active' : ''}`} aria-hidden="true" />
    </>
  )
}
