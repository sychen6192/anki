import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { setupServiceWorkerInBrowser } from './lib/sw'
import { initTheme } from './lib/theme'
import './styles.css'

initTheme()
// dev server 不產 sw.js,註冊只會在 console 印 MIME type 錯誤 —— 只在正式版註冊
if (!import.meta.env.DEV) setupServiceWorkerInBrowser()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
)
