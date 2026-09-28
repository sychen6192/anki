import { Suspense, useEffect } from 'react'
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom'
import { setupAutoSync } from './lib/sync'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Loading } from './components/Loading'
import { TabBar, type Tab } from './components/TabBar'
import { UpdateBanner } from './components/UpdateBanner'
import { ConfirmProvider } from './components/Confirm'
import { ChartIcon, DecksIcon, GearIcon } from './components/icons'
import { lazyRoute, prefetchRoutes } from './lib/lazyRoute'
import { pageScroller, scrollPageTo } from './lib/scroller'
import DeckList from './pages/DeckList'
import Review from './pages/Review'

// 牌組列表與複習是每天都會用到的,直接打包進主 chunk。
// 其餘頁面(統計、匯入頁帶著 apkg 解析)按需載入,
// 免得每天開 app 都得先下載一份用不到的東西。
const loadDeckDetail = () => import('./pages/DeckDetail')
const loadImportPage = () => import('./pages/ImportPage')
const loadStatsPage = () => import('./pages/StatsPage')
const loadSettingsPage = () => import('./pages/SettingsPage')
const loadGuidePage = () => import('./pages/GuidePage')

const DeckDetail = lazyRoute(loadDeckDetail)
const ImportPage = lazyRoute(loadImportPage)
const StatsPage = lazyRoute(loadStatsPage)
const SettingsPage = lazyRoute(loadSettingsPage)
const GuidePage = lazyRoute(loadGuidePage)

// 三個分頁:每天用的「牌組」、偶爾看的「統計」、很少動的「設定」。
// 匯入從「牌組」右上的 + 進去,說明在設定裡 —— 一年用幾次的東西不佔分頁
const TABS: Tab[] = [
  {
    to: '/', label: '牌組', icon: <DecksIcon />,
    match: (p) => p === '/' || p.startsWith('/deck/') || p.startsWith('/import'),
  },
  { to: '/stats', label: '統計', icon: <ChartIcon />, match: (p) => p.startsWith('/stats'), prefetch: loadStatsPage },
  {
    to: '/settings', label: '設定', icon: <GearIcon />,
    match: (p) => p.startsWith('/settings') || p.startsWith('/guide'), prefetch: loadSettingsPage,
  },
]

function NotFound() {
  return (
    <div className="empty-state" style={{ paddingTop: 'calc(80px + var(--safe-top))' }}>
      <h2>找不到這個頁面</h2>
      <Link to="/" className="btn">回牌組</Link>
    </div>
  )
}

/** 換頁時回到頂端(BrowserRouter 不會自己做,新頁面會停在上一頁的捲動位置) */
function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => { scrollPageTo(0) }, [pathname])
  return null
}

/**
 * 鍵盤蓋住捲動區底部多少,寫進 --kb-inset(base.css 的 .page 底部多留這麼多)。
 * 頁面在內層捲,iPhone 跳出鍵盤時只替整個文件讓位、不替內層的捲動區讓位:
 * 不補的話,搜尋結果的最後幾行、匯入頁欄位下面的按鈕都捲不到鍵盤上面。
 * 放大(雙指縮放)時看得見的範圍也會變小,那不是鍵盤,不算。
 */
function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const update = () => {
      const sc = pageScroller()
      const hidden = sc === null || Math.abs(vv.scale - 1) > 0.01 ? 0
        : Math.round(sc.getBoundingClientRect().bottom - (vv.offsetTop + vv.height))
      root.style.setProperty('--kb-inset', `${hidden > 80 ? hidden : 0}px`)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      root.style.removeProperty('--kb-inset')
    }
  }, [])
}

function Shell() {
  const { pathname, search } = useLocation()
  useKeyboardInset()
  // 複習是專注模式;朋友從分享連結打開的是專用頁 —— 這兩種不放分頁列
  const hideTabbar = pathname.startsWith('/review/')
    || (pathname === '/import' && new URLSearchParams(search).has('share'))
  return (
    <div className={`app${hideTabbar ? ' no-tabbar' : ''}`}>
      <ScrollToTop />
      {/* 分頁列和捲動區是上下兩列(手機:CSS 的 order 把分頁列排到下面;寬螢幕在上面)。
          頁面在 .scroller 裡捲,文件本身不捲:分頁列不疊在捲動區上,iPhone 上頁面還在慣性捲動時
          點分頁才不會被拿去停住捲動(見 lib/scroller.ts) */}
      {!hideTabbar && <TabBar tabs={TABS} />}
      <div className="scroller">
        <main className="page">
          {/* 換網址就收掉錯誤畫面:出錯後點分頁列換頁就重新來過(不然錯誤畫面會一直留著,設定頁的修復工具也到不了)。
              不當 key 用:複習完一副按「繼續複習其他牌組」只是換網址,復原紀錄要留著 */}
          <ErrorBoundary resetKey={pathname}>
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route path="/" element={<DeckList />} />
                <Route path="/deck/:deckId" element={<DeckDetail />} />
                <Route path="/review/:deckId" element={<Review />} />
                <Route path="/import" element={<ImportPage />} />
                <Route path="/stats" element={<StatsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/guide" element={<GuidePage />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <UpdateBanner />
    </div>
  )
}

export default function App() {
  useEffect(() => {
    setupAutoSync()
    // 開場閒下來後先把其他頁面抓回來,點分頁就不用等網路
    prefetchRoutes([loadDeckDetail, loadImportPage, loadStatsPage, loadSettingsPage, loadGuidePage])
  }, [])
  return (
    <BrowserRouter>
      <ConfirmProvider>
        <Shell />
      </ConfirmProvider>
    </BrowserRouter>
  )
}
