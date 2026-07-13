import { useEffect } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { setupAutoSync } from './lib/sync'
import DeckList from './pages/DeckList'
import DeckDetail from './pages/DeckDetail'
import Review from './pages/Review'
import ImportPage from './pages/ImportPage'
import StatsPage from './pages/StatsPage'
import SettingsPage from './pages/SettingsPage'

export default function App() {
  useEffect(() => { setupAutoSync() }, [])
  return (
    <BrowserRouter>
      <nav className="topnav">
        <Link to="/">牌組</Link>
        <Link to="/import">匯入</Link>
        <Link to="/stats">統計</Link>
        <Link to="/settings">設定</Link>
      </nav>
      <main className="page">
        <Routes>
          <Route path="/" element={<DeckList />} />
          <Route path="/deck/:deckId" element={<DeckDetail />} />
          <Route path="/review/:deckId" element={<Review />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </BrowserRouter>
  )
}
