import type { CloudDeleteResult, SpaceProblem, SyncResult } from './sync'

/** 瀏覽器的「連不上」:Chrome 是 Failed to fetch,Safari 是 Load failed,Firefox 是 NetworkError… */
const NETWORK_ERROR = /load failed|failed to fetch|networkerror|network request failed|network connection|typeerror/i

/**
 * 同步以外的錯誤訊息(分享、查字典、自動標註):連不上網路時講人話,其他照原本的訊息。
 * 不然朋友在收訊差的地方打開分享連結,看到的是一行「Failed to fetch」。
 */
export function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return NETWORK_ERROR.test(message) ? '連不上伺服器，確認網路後再試一次' : message
}

/**
 * 同步錯誤翻成人話:發生什麼 → 資料安不安全 → 接下來會怎樣。
 * 原始錯誤是給開發者看的(`push failed: 500`、Safari 的 `Load failed`),直接秀出來只會嚇人。
 */
export function humanizeSyncError(error: string): string {
  const status = /(?:push|pull) failed: (\d{3})/.exec(error)
  if (status !== null) {
    const code = Number(status[1])
    // 舊版自訂的金鑰(雲端還沒有資料的那種)不能再開新空間
    if (error.includes('(invalid space)')) return '這組金鑰是舊版自訂的格式，不能再用來同步；到「設定 → 同步金鑰」換一組新的。資料都還在這台'
    if (code === 429) return '同步得太頻繁，伺服器請這台等一下，稍後會自動再試；資料都還在這台'
    if (code >= 500) return '伺服器暫時有問題，稍後會自動再試；資料都還在這台'
    if (code === 401 || code === 403) return `伺服器拒絕同步（代碼 ${code}），請檢查同步設定；資料都還在這台`
    return `同步沒有成功（代碼 ${code}）；資料都還在這台`
  }
  if (NETWORK_ERROR.test(error)) {
    return '連不上伺服器，連上網路後會自動同步；資料都還在這台'
  }
  return `同步沒有成功（${error}）；資料都還在這台`
}

/** 手動同步的結果寫成一句話;成功時用 okText */
export function syncMessage(r: SyncResult, okText: string): string {
  if (r.ok) return okText
  if (r.reason === 'local-only') return '還沒開啟同步，資料只存在這台裝置'
  if (r.reason === 'offline') return '目前離線，連上網路後會自動同步'
  if (r.reason === 'switched') return '同步途中換了金鑰，這次先停下來'
  if (r.reason === 'busy') return '另一個同步正在進行，稍後會自動再同步'
  if (r.reason === 'deleted') return '這組金鑰的雲端資料已經刪除了，這台改成只存在這台；資料都還在'
  return humanizeSyncError(r.error ?? '')
}

/** 連上金鑰之前問不到空間時,跟使用者說什麼(什麼都還沒改) */
export function spaceProblemText(problem: SpaceProblem): string {
  if (problem === 'deleted') return '這組金鑰的雲端資料已經刪除了，不能再用。要同步的話，在其中一台產生新的金鑰'
  if (problem === 'invalid') return '這不是字卡產生的金鑰。金鑰是 12 個英文字母或數字，格式像 abcd-efgh-jkmn，再確認一次有沒有打錯'
  if (problem === 'busy') return '試太多次了，等一分鐘再試；這台什麼都沒改'
  return '連不上伺服器，這台什麼都沒改；連上網路後再試一次'
}

/** 刪除雲端資料沒成功時的說明(成功時由畫面自己說) */
export function cloudDeleteText(r: Exclude<CloudDeleteResult, 'ok'>): string {
  if (r === 'busy') return '試太多次了，等一分鐘再試；雲端資料還在'
  if (r === 'failed') return '伺服器暫時有問題，沒有刪掉；雲端資料還在，稍後再試一次'
  return '連不上伺服器，沒有刪掉；連上網路後再試一次'
}
