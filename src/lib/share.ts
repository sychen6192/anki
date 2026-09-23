import type { ParsedRow } from './csv'

/**
 * 分享牌組的前端邏輯:上傳、讀取、從貼上的文字找分享碼、判斷執行環境。
 * 從頁面抽出來是為了能單元測試 —— 頁面只管畫面與使用者手勢。
 */

export interface SharedDeck { name: string; rows: ParsedRow[] }

/**
 * 從貼上的文字找分享碼:完整網址、只有 ?share=… 的片段、或裸的分享碼都認。
 * 分享碼是伺服器產的小寫英數(目前 8 字),大小寫一律轉小寫;認不出來回 null。
 */
export function parseShareCode(input: string): string | null {
  const s = input.trim()
  if (s === '') return null
  const fromUrl = s.match(/[?&]share=([A-Za-z0-9]+)/)
  if (fromUrl) return fromUrl[1].toLowerCase()
  if (/^[A-Za-z0-9]{6,32}$/.test(s)) return s.toLowerCase()
  return null
}

export const shareUrlFor = (origin: string, code: string): string => `${origin}/import?share=${code}`

/** 伺服器已驗過形狀,這裡再做一次 mapRows 等級的清理:修剪空白、丟掉缺單字或意思的列 */
export function normalizeSharedRows(rows: unknown): ParsedRow[] {
  if (!Array.isArray(rows)) return []
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      expression: str(r.expression), reading: str(r.reading), meaning: str(r.meaning), accent: str(r.accent),
    }))
    .filter((r) => r.expression !== '' && r.meaning !== '')
}

/** 上傳牌組內容,回傳分享碼。大牌組的 JSON 有幾十 KB,行動網路上行慢 —— 能壓就壓(約剩 1/3) */
export async function createShare(
  name: string, rows: ParsedRow[], fetchFn: typeof fetch = fetch,
): Promise<string> {
  const json = JSON.stringify({ name, rows })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  let body: BodyInit = json
  if (typeof CompressionStream === 'function') {
    body = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).blob()
    headers['x-body-gzip'] = '1'
  }
  const res = await fetchFn('/api/share', { method: 'POST', headers, body })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json() as { code?: unknown }
  if (typeof data.code !== 'string' || data.code === '') throw new Error('伺服器沒有回傳分享碼')
  return data.code
}

/** 分享不存在(貼錯或過期):重試也沒用,畫面據此不顯示「重試」 */
export class ShareNotFoundError extends Error {}

/** 讀取分享內容;404 講人話,其餘錯誤帶狀態碼 */
export async function fetchShare(code: string, fetchFn: typeof fetch = fetch): Promise<SharedDeck> {
  const res = await fetchFn(`/api/share/${encodeURIComponent(code)}`)
  if (res.status === 404) throw new ShareNotFoundError('找不到這個分享,連結可能貼錯了或已經過期')
  if (!res.ok) throw new Error(`讀取分享失敗(HTTP ${res.status})`)
  const data = await res.json() as { name?: unknown; rows?: unknown }
  return {
    name: typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : '分享的牌組',
    rows: normalizeSharedRows(data.rows),
  }
}

/** 觸控為主的裝置(手機、平板):系統分享面板只給這種裝置用 */
export function isTouchDevice(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(hover: none)').matches
}

/** 是不是從主畫面打開的 App(而不是瀏覽器分頁或 LINE 之類的內建瀏覽器) */
export function isStandaloneApp(): boolean {
  if (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) return true
  return typeof navigator !== 'undefined' && (navigator as { standalone?: boolean }).standalone === true
}

/**
 * 看起來是 App 的內建瀏覽器(LINE、Facebook、Instagram、Threads、TikTok、微信…):
 * 資料只存在那個內建瀏覽器裡,使用者平常開字卡的地方看不到。
 * - Android:幾乎都是系統 WebView,UA 帶 "; wv)"。少數一般瀏覽器(例如 Vivo 瀏覽器)也用 WebView,
 *   會被誤認 —— 所以提醒文字要保留「這就是你平常用的瀏覽器就直接匯入」的出路
 * - iOS:WKWebView 做的內建瀏覽器 UA 沒有 "Safari/",真的 Safari 與 iOS 版 Chrome/Firefox/Edge 都有。
 *   主畫面的 App 也沒有,但那時不會顯示提醒(isStandaloneApp)
 */
export function isInAppBrowser(ua: string): boolean {
  return /; wv\)|\bLine\/|FBAN|FBAV|Instagram|MicroMessenger|Twitter|KAKAOTALK|\bBarcelona\b|musical_ly|Bytedance|Snapchat/i.test(ua)
    || /(iPhone|iPod|iPad)(?!.*Safari\/)/.test(ua)
}

/**
 * 在這個瀏覽器匯入的資料,會不會和另外裝的字卡 App 分開存。
 * - iPhone/iPad:主畫面的 App 與 Safari(以及 iOS 上的 Chrome 等)各有各的儲存空間
 * - Mac 的 Safari:「加入 Dock」的網頁 App 也不和 Safari 共用資料
 * - Mac/Linux 的 Firefox:這兩個平台的 Firefox 不能安裝網頁 App,App 一定裝在別的瀏覽器
 * - App 的內建瀏覽器:自己一份
 * Android 的 Chrome、桌機的 Chrome/Edge 與從它安裝的 App 共用資料,不必提醒。
 */
export function storageSeparateFromApp(ua: string, maxTouchPoints: number): boolean {
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
  const macSafari = /Macintosh/.test(ua) && /Version\/[\d.]+ .*Safari\//.test(ua)
    && !/Chrome\/|Chromium\/|Edg\/|Firefox\/|OPR\//.test(ua)
  const desktopFirefox = /Firefox\//.test(ua) && /Macintosh|X11/.test(ua)
  return iOS || macSafari || desktopFirefox || isInAppBrowser(ua)
}
