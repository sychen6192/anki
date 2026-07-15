import { useEffect } from 'react'
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
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
        <NavLink to="/" end>牌組</NavLink>
        <NavLink to="/import">匯入</NavLink>
        <NavLink to="/stats">統計</NavLink>
        <NavLink to="/settings">設定</NavLink>
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
