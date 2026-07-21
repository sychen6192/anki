import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom'
import { setupAutoSync } from './lib/sync'
import { ErrorBoundary } from './components/ErrorBoundary'
import DeckList from './pages/DeckList'
import Review from './pages/Review'

// 牌組列表與複習是每天都會用到的,直接打包進主 chunk。
// 其餘頁面(統計頁帶著 recharts、匯入頁帶著 apkg 解析)按需載入,
// 免得每天開 app 都得先下載一份用不到的圖表函式庫。
const DeckDetail = lazy(() => import('./pages/DeckDetail'))
const ImportPage = lazy(() => import('./pages/ImportPage'))
const StatsPage = lazy(() => import('./pages/StatsPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))

function NotFound() {
  return (
    <div className="review-done">
      <h1>找不到這個頁面</h1>
      <Link to="/" className="btn">回牌組列表</Link>
    </div>
  )
}

export default function App() {
  useEffect(() => { setupAutoSync() }, [])
  return (
    <BrowserRouter>
      <nav className="topnav">
        <NavLink to="/" end>牌組</NavLink>
        <NavLink to="/import">匯入</NavLink>
        <NavLink to="/stats">統計</NavLink>
        <NavLink to="/settings">設定</NavLink>
      </nav>
      <main className="page">
        <ErrorBoundary>
          <Suspense fallback={<p className="hint">載入中…</p>}>
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
