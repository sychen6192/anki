import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { setupServiceWorkerInBrowser } from './lib/sw'
import './styles.css'

setupServiceWorkerInBrowser()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
)
