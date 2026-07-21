import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // 註冊由 src/lib/sw.ts 自己做:新 SW 接手時要重新載入頁面,
      // 否則舊 HTML 會配上新 precache,分割出去的 chunk 就抓不到了
      injectRegister: null,
      manifest: {
        // id 固定住已安裝 app 的身分,之後改 start_url 或圖示也不會被當成另一個 app
        id: '/',
        name: '字卡',
        short_name: '字卡',
        description: '以 FSRS 排程的日文單字閃卡,離線可用、跨裝置同步',
        lang: 'zh-TW',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#5b57d6',
        background_color: '#f5f5f6',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 關鍵:API 請求不可被 SPA fallback 攔截,否則離線時 sync 錯誤會被 sw 吃掉
        navigateFallbackDenylist: [/^\/api\//],
        // sql.js 的 wasm 約 1.2MB,只有匯入 .apkg 才用得到 — 不進 precache,
        // 改成第一次用到時才抓、抓過就留著(之後離線也能匯入)
        globIgnores: ['**/*.wasm'],
        runtimeCaching: [{
          urlPattern: /\.wasm$/,
          handler: 'CacheFirst',
          options: { cacheName: 'wasm-cache', expiration: { maxEntries: 4 } },
        }],
      },
    }),
  ],
  server: { proxy: { '/api': 'http://localhost:8787' } },
})
