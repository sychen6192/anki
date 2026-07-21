import { lazy, type ComponentType } from 'react'

const RELOAD_KEY = 'chunk-reload-at'
const RELOAD_COOLDOWN = 10_000

export interface ReloadDeps {
  storage: Pick<Storage, 'getItem' | 'setItem'>
  reload: () => void
  now: () => number
}

const browserDeps = (): ReloadDeps => ({
  storage: sessionStorage,
  reload: () => window.location.reload(),
  now: Date.now,
})

/**
 * 分割出去的頁面 chunk 檔名帶 hash,新版部署後舊檔名就不存在了。
 * 如果使用者手上是上一版的 HTML(service worker 還沒換版),點某個 tab 時
 * 那支 chunk 會 404 —— import() 被拒絕,畫面就停在錯誤頁再也回不來。
 *
 * 所以抓不到時先重載一次:重載會拿到新的 HTML 與新的 chunk 檔名,問題自然消失。
 * 用 sessionStorage 記時間戳擋住無限重載 —— 若重載後仍然失敗(例如真的離線),
 * 冷卻時間內就不再重載,讓錯誤正常往上拋給 ErrorBoundary 顯示。
 */
export async function loadChunk<T>(
  load: () => Promise<T>, deps: ReloadDeps = browserDeps(),
): Promise<T> {
  try {
    return await load()
  } catch (e) {
    const last = Number(deps.storage.getItem(RELOAD_KEY) ?? 0)
    if (!(deps.now() - last < RELOAD_COOLDOWN)) {
      deps.storage.setItem(RELOAD_KEY, String(deps.now()))
      deps.reload()
      // 等瀏覽器重載;不要往下拋,免得錯誤頁閃一下才換頁
      return await new Promise<T>(() => {})
    }
    throw e
  }
}

export function lazyRoute<T extends ComponentType<Record<string, never>>>(
  load: () => Promise<{ default: T }>,
) {
  return lazy(() => loadChunk(load))
}

/** 閒置時先把其他頁面的 chunk 抓回來,之後點 tab 就不必等網路 */
export function prefetchRoutes(loaders: (() => Promise<unknown>)[]): void {
  const run = () => { for (const load of loaders) void load().catch(() => {}) }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 })
  else setTimeout(run, 1500)
}
