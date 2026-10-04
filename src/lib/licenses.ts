// 「授權與資料來源」頁的套件清單:vite-plugins/thirdPartyLicenses.ts 建置時照實際打包進去的模組產生,
// 放在 dist 根目錄、由 service worker 預先快取(離線也看得到)。只有這一頁(按需載入的 chunk)會讀它。

/** 檔名:建置外掛輸出、頁面讀取、workbox 預先快取都用這一個 */
export const LICENSES_FILE = 'third-party-licenses.json'

/** 一個打包進 App 的套件 */
export interface PackageNotice {
  name: string
  /** 夾帶在別的套件裡的程式碼(例如 fsrs-browser 裡的 wasm-bindgen-rayon)沒有自己的版本 */
  version?: string
  /** 授權代號(SPDX),例如 MIT */
  license: string
  author?: string
  /** 專案網頁或原始碼庫 */
  url?: string
  /** 夾帶在哪個套件裡 */
  bundledIn?: string
  /** 授權條款全文(LICENSE、NOTICE 等檔案接在一起);套件沒附就是空字串 */
  text: string
}

export interface LicensesFile {
  /** 開發模式沒有打包結果,只列 package.json 的直接相依 */
  partial?: boolean
  packages: PackageNotice[]
}

// 這種行要自成一行:縮排的(Apache 條款)、標題、清單、底線、Copyright 行
const KEEP_LINE = /^(?:\s|#|[-*•+]\s|\d+[.)]\s|\([a-z0-9]+\)\s|={3,}|-{3,}|copyright\b|\(c\)|©)/i
const UNDERLINE = /^\s*(?:={3,}|-{3,})\s*$/

/**
 * 授權全文大多每 80 字左右就硬換行,手機上再自動換行就變成一長一短的鋸齒。
 * 顯示時把同一段裡的換行接成空白:只動排版、不動文字;空行分段、縮排、標題、Copyright 行照原樣。
 */
export function reflow(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  lines.forEach((line, i) => {
    const prev = lines[i - 1]
    const join = prev !== undefined && prev.trim() !== '' && line.trim() !== ''
      && !KEEP_LINE.test(prev) && !KEEP_LINE.test(line) && !UNDERLINE.test(lines[i + 1] ?? '')
    if (join) out[out.length - 1] += ` ${line}`
    else out.push(line)
  })
  return out.join('\n')
}

export async function loadLicenses(fetcher: typeof fetch = fetch): Promise<LicensesFile> {
  const res = await fetcher(`${import.meta.env.BASE_URL}${LICENSES_FILE}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // 拿到的不是 JSON(例如被導回 index.html)時 json() 會丟錯,一樣當成讀不到
  const data = (await res.json()) as Partial<LicensesFile> | null
  if (!data || !Array.isArray(data.packages)) throw new Error('套件清單格式不對')
  return { partial: data.partial === true, packages: data.packages }
}
