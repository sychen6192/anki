export interface SwDeps {
  /** 註冊當下是否已經有 service worker 在控制這個頁面 */
  hadController: boolean
  register: () => void
  onControllerChange: (fn: () => void) => void
  reload: () => void
}

/**
 * service worker 用的是 skipWaiting + clientsClaim,新版一裝好就會接管
 * **當下已經開著的頁面**。但那個頁面的 HTML 還是舊版的,指向的分割 chunk
 * 檔名在新部署裡已經不存在 —— 點 tab 就會抓不到而卡住。
 *
 * 所以新的 SW 接手時要重新載入,讓 HTML 與 SW 的 precache 對得起來。
 * 第一次安裝(原本沒有 controller)時 clientsClaim 也會觸發 controllerchange,
 * 那次不能重載,否則每個新使用者第一次開都會莫名其妙閃一下。
 */
export function setupServiceWorker(deps: SwDeps): void {
  deps.register()
  let reloading = false
  deps.onControllerChange(() => {
    if (!deps.hadController || reloading) return
    reloading = true
    deps.reload()
  })
}

export function setupServiceWorkerInBrowser(): void {
  if (!('serviceWorker' in navigator)) return
  setupServiceWorker({
    hadController: navigator.serviceWorker.controller !== null,
    register: () => {
      window.addEventListener('load', () => {
        void navigator.serviceWorker.register('/sw.js', { scope: '/' })
      })
    },
    onControllerChange: (fn) => navigator.serviceWorker.addEventListener('controllerchange', fn),
    reload: () => window.location.reload(),
  })
}
