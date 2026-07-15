import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '字卡',
        short_name: '字卡',
        lang: 'zh-TW',
        display: 'standalone',
        theme_color: '#5b57d6',
        background_color: '#f5f5f6',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // 關鍵:API 請求不可被 SPA fallback 攔截,否則離線時 sync 錯誤會被 sw 吃掉
      workbox: { navigateFallbackDenylist: [/^\/api\//] },
    }),
  ],
  server: { proxy: { '/api': 'http://localhost:8787' } },
})
