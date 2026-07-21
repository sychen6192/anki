import { Suspense, useEffect } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { setupAutoSync } from './lib/sync'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Loading } from './components/Loading'
import { TopNav, type Tab } from './components/TopNav'
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

const DeckDetail = lazyRoute(loadDeckDetail)
const ImportPage = lazyRoute(loadImportPage)
const StatsPage = lazyRoute(loadStatsPage)
const SettingsPage = lazyRoute(loadSettingsPage)

const TABS: Tab[] = [
  { to: '/', label: '牌組' },
  { to: '/import', label: '匯入', prefetch: loadImportPage },
  { to: '/stats', label: '統計', prefetch: loadStatsPage },
  { to: '/settings', label: '設定', prefetch: loadSettingsPage },
]

function NotFound() {
  return (
    <div className="review-done">
      <h1>找不到這個頁面</h1>
      <Link to="/" className="btn">回牌組列表</Link>
    </div>
  )
}

export default function App() {
  useEffect(() => {
    setupAutoSync()
    // 開場閒下來後先把其他頁面抓回來,點 tab 就不用等網路
    prefetchRoutes([loadDeckDetail, loadImportPage, loadStatsPage, loadSettingsPage])
  }, [])
  return (
    <BrowserRouter>
      <TopNav tabs={TABS} />
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
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
    </BrowserRouter>
  )
}
