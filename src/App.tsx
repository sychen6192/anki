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
import DeckList from './pages/DeckList'
import Review from './pages/Review'

// 牌組列表與複習是每天都會用到的,直接打包進主 chunk。
// 其餘頁面(統計頁帶著 recharts、匯入頁帶著 apkg 解析)按需載入,
// 免得每天開 app 都得先下載一份用不到的圖表函式庫。
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
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return null
}

function Shell() {
  const { pathname, search } = useLocation()
  // 複習是專注模式;朋友從分享連結打開的是專用頁 —— 這兩種不放分頁列
  const hideTabbar = pathname.startsWith('/review/')
    || (pathname === '/import' && new URLSearchParams(search).has('share'))
  return (
    <div className={`app${hideTabbar ? ' no-tabbar' : ''}`}>
      <ScrollToTop />
      {/* DOM 放在內容前面:手機上是 fixed 在底部,位置不受影響;寬螢幕時 sticky 在頂端要排第一個 */}
      {!hideTabbar && <TabBar tabs={TABS} />}
      <main className="page">
        <ErrorBoundary>
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
