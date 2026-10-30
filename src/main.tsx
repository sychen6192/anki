import React from 'react'
import ReactDOM from 'react-dom/client'
// 共用樣式一定要在 App 之前 import:App 會直接帶進首頁與複習的 CSS,CSS 的先後就照 import 的順序。
// 放在後面的話,頁面 CSS 跟 .row、.card、.btn 同權重時反而被元件蓋掉(dev 與打包後都一樣)
import './styles.css'
import App from './App'
import { setupServiceWorkerInBrowser } from './lib/sw'
import { initTheme } from './lib/theme'

initTheme()
// dev server 不產 sw.js,註冊只會在 console 印 MIME type 錯誤 —— 只在正式版註冊
if (!import.meta.env.DEV) setupServiceWorkerInBrowser()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
)
