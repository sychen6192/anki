export interface SwWorker {
  state: string
  postMessage: (msg: unknown) => void
  addEventListener: (type: 'statechange', fn: () => void) => void
}
export interface SwRegistration {
  waiting: SwWorker | null
  installing: SwWorker | null
  update: () => Promise<unknown>
  addEventListener: (type: 'updatefound', fn: () => void) => void
}
export interface SwDeps {
  hasController: () => boolean
  register: () => Promise<SwRegistration | null>
  onControllerChange: (fn: () => void) => void
  reload: () => void
  /** 有新版在等待時呼叫,傳入「套用更新」的動作讓 UI 綁到按鈕 */
  onUpdateReady: (apply: () => void) => void
  /** 註冊「該檢查更新了」的時機(回到前景、定時);時機到會去問伺服器有沒有新版 */
  onCheckForUpdates: (check: () => void) => void
}

/**
 * PWA 更新採 prompt 模式:新版裝好後不自動接管,而是先在畫面上提示,
 * 由使用者按下更新才 skipWaiting。這樣做有兩個好處:
 *   1. 不會在複習到一半時毫無預警地重載頁面。
 *   2. 更新前舊 SW 一直供應舊的分割 chunk,不會出現「舊 HTML 配新 precache、
 *      chunk 抓不到」而卡住的情形。
 *
 * controllerchange 只在「使用者主動套用更新」後才觸發重載;第一次安裝
 * (若瀏覽器有 clientsClaim)也會觸發 controllerchange,那次不重載。
 */
export async function setupServiceWorker(deps: SwDeps): Promise<void> {
  let applied = false
  deps.onControllerChange(() => {
    if (applied) deps.reload()
  })

  const reg = await deps.register()
  if (reg === null) return

  // 瀏覽器只在「整頁導航」時檢查 sw.js 有沒有新版;安裝在手機上的 PWA
  // 常常一開就是好幾天不重載,等於永遠不會發現新版、也就永遠看不到更新提示。
  // 所以回到前景與定時都主動問一次。離線時 update() 會失敗,安靜跳過即可。
  deps.onCheckForUpdates(() => { void reg.update().catch(() => {}) })

  const announce = (waiting: SwWorker) => {
    deps.onUpdateReady(() => {
      applied = true
      waiting.postMessage({ type: 'SKIP_WAITING' })
    })
  }

  // 開頁時就已經有等待中的新版(上次沒更新就關掉了)
  if (reg.waiting !== null && deps.hasController()) announce(reg.waiting)

  reg.addEventListener('updatefound', () => {
    const installing = reg.installing
    if (installing === null) return
    installing.addEventListener('statechange', () => {
      // installed + 已有 controller = 這是「更新」而非首次安裝
      if (installing.state === 'installed' && deps.hasController() && reg.waiting !== null) {
        announce(reg.waiting)
      }
    })
  })
}

// --- 讓 React 訂閱「有更新可套用」 ---

type ApplyUpdate = () => void
const subscribers = new Set<(apply: ApplyUpdate | null) => void>()
let pendingUpdate: ApplyUpdate | null = null

export function subscribeUpdate(cb: (apply: ApplyUpdate | null) => void): () => void {
  subscribers.add(cb)
  cb(pendingUpdate)
  return () => { subscribers.delete(cb) }
}

function publishUpdate(apply: ApplyUpdate): void {
  pendingUpdate = apply
  for (const cb of subscribers) cb(apply)
}

export function setupServiceWorkerInBrowser(): void {
  if (!('serviceWorker' in navigator)) return
  void setupServiceWorker({
    hasController: () => navigator.serviceWorker.controller !== null,
    register: () => new Promise((resolve) => {
      const doRegister = () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' })
          .then((reg) => resolve(reg as unknown as SwRegistration))
          .catch(() => resolve(null))
      }
      // main.tsx 在 load 之前就跑,但若已經 complete 就直接註冊
      if (document.readyState === 'complete') doRegister()
      else window.addEventListener('load', doRegister, { once: true })
    }),
    onControllerChange: (fn) => navigator.serviceWorker.addEventListener('controllerchange', fn),
    reload: () => window.location.reload(),
    onUpdateReady: (apply) => publishUpdate(apply),
    onCheckForUpdates: (check) => {
      // 切分頁/切 app 會讓 visibilitychange 連發,60 秒內只問一次就好
      let lastAsk = 0
      const guarded = () => {
        if (Date.now() - lastAsk < 60_000) return
        lastAsk = Date.now()
        check()
      }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') guarded()
      })
      setInterval(guarded, 60 * 60 * 1000)
    },
  })
}
