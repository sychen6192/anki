// 建置時列出實際打包進 App 的第三方程式碼與授權全文,輸出 third-party-licenses.json 給「授權與資料來源」頁讀。
//
// 清單照打包結果產生,不照 package.json:只有伺服器(worker/)或建置時才用到的套件(hono、wrangler…)不會出現,
// 間接打包進來的(scheduler、react-router…)也不會漏。來源有四種:
//   1. 主程式各個 chunk 的模組 id,與資源檔(wasm)的原始路徑
//   2. web worker 的 chunk(fsrs-browser 的最佳化 worker 另外打包,要在 vite.config.ts 的 worker.plugins 掛 worker())
//   3. Vite / Rolldown 自己塞進去的小段程式(\0vite/preload-helper.js、\0rolldown/runtime.js…)
//   4. service worker:vite-plugin-pwa 交給 workbox-build 另外打包,這裡看不到它的模組,改用 SW_PACKAGES 手動維護;
//      建置完 checkServiceWorker 會掃 dist 裡 workbox 執行檔的模組標記,有沒列到的就讓建置失敗

import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { LICENSES_FILE, type LicensesFile, type PackageNotice } from '../src/lib/licenses'

/**
 * service worker 裡出自別人的程式。每一項是從專案根目錄一路往下找的相依鏈,最後一個是要列出的套件
 * (照 Node 的找法,套件被裝在巢狀 node_modules 裡也找得到)。
 */
export const SW_PACKAGES: readonly (readonly string[])[] = [
  // workbox 執行檔(dist/workbox-*.js):預先快取、路由、快取策略,wasm 快取的過期設定(ExpirationPlugin)
  ['vite-plugin-pwa', 'workbox-build', 'workbox-core'],
  ['vite-plugin-pwa', 'workbox-build', 'workbox-routing'],
  ['vite-plugin-pwa', 'workbox-build', 'workbox-strategies'],
  ['vite-plugin-pwa', 'workbox-build', 'workbox-precaching'],
  ['vite-plugin-pwa', 'workbox-build', 'workbox-expiration'],
  // workbox-expiration 用它把到期時間存進 IndexedDB
  ['vite-plugin-pwa', 'workbox-build', 'workbox-expiration', 'idb'],
  // sw.js 本身:workbox-build 的範本、載入 workbox-*.js 的 AMD 載入器、打包時 Babel 補上的 helper(例如 _extends)
  ['vite-plugin-pwa', 'workbox-build'],
  ['vite-plugin-pwa', 'workbox-build', '@trickfilm400/rollup-plugin-off-main-thread'],
  ['vite-plugin-pwa', 'workbox-build', '@babel/core', '@babel/helpers'],
]

/** Vite / Rolldown 產生的虛擬模組(id 以 \0 開頭)→ 程式出自哪個套件(相依鏈) */
const VIRTUAL_SOURCES: Record<string, readonly string[]> = {
  'vite/': ['vite'], // preload helper、modulepreload polyfill
  'rolldown/': ['vite', 'rolldown'], // 模組之間共用的 runtime helper
}

/** 授權檔裡跟打包進 App 的部分無關、可以省掉的段落 */
const TRIM: Record<string, RegExp> = {
  // Vite 的 LICENSE.md 後面附了一百多 KB「Vite 自己在 Node 端打包的相依套件」的授權;
  // App 裡只有 Vite 本身的 preload helper 與 modulepreload polyfill,留最前面的 Vite core license 就好
  vite: /\n#+ Licenses of bundled dependencies[\s\S]*$/,
}

const NODE_MODULES = '/node_modules/'

function normalizeId(id: string): string {
  return id.replace(/^\0/, '').replace(/[?#].*$/, '').replace(/\\/g, '/')
}

/** 模組 id 或檔案路徑 → 所在套件的根目錄與名稱(巢狀 node_modules 取最裡面那層);不在 node_modules 裡就是 null */
export function locatePackage(id: string): { root: string; name: string } | null {
  let file = normalizeId(id)
  if (file.startsWith('node_modules/')) file = `/${file}`
  const at = file.lastIndexOf(NODE_MODULES)
  if (at < 0) return null
  const parts = file.slice(at + NODE_MODULES.length).split('/')
  const n = parts[0].startsWith('@') ? 2 : 1
  const segs = parts.slice(0, n)
  // .vite/deps(開發時預先打包的)、.pnpm 這類不是套件本身
  if (segs.length < n || segs.some((s) => s === '' || s.startsWith('.'))) return null
  const name = segs.join('/')
  return { root: file.slice(0, at + NODE_MODULES.length) + name, name }
}

/** \0vite/preload-helper.js 這類虛擬模組 → 出自哪個套件(相依鏈);一般模組是 null */
export function virtualSource(id: string): readonly string[] | null {
  if (!id.startsWith('\0')) return null
  for (const [prefix, chain] of Object.entries(VIRTUAL_SOURCES)) {
    if (id.startsWith(`\0${prefix}`)) return chain
  }
  return null
}

/**
 * wasm-bindgen 把 Rust crate 附帶的 JS 放在 <套件>/snippets/<crate>-<16 位 hash>/,
 * 授權跟外層套件不一定一樣(fsrs-browser 是 BSD,裡面的 wasm-bindgen-rayon 是 Apache-2.0)
 */
export function snippetCrate(id: string): string | null {
  const m = /\/node_modules\/(?:@[^/]+\/)?[^/]+\/snippets\/([\w-]+)-[0-9a-f]{16}\//.exec(normalizeId(id))
  return m ? m[1] : null
}

const LICENSE_NAME = /^(?:licen[cs]e|copying)(?:[.-][\w.-]*)?$/i
const STANDARD_LICENSE_NAME = /^(?:licen[cs]e|copying)(?:\.(?:md|markdown|txt))?$/i
const NOTICE_NAME = /^notice(?:\.(?:md|markdown|txt))?$/i
const CODE_FILE = /\.(?:[cm]?[jt]sx?|json|map)$/i

/** 套件根目錄的檔名裡哪些是授權檔(不分大小寫);LICENSE、LICENSE.md 這種標準檔名排前面,LICENSE-MIT 之類排後面 */
export function licenseFiles(files: readonly string[]): string[] {
  const rank = (f: string) => (STANDARD_LICENSE_NAME.test(f) ? 0 : 1)
  return files
    .filter((f) => LICENSE_NAME.test(f) && !CODE_FILE.test(f))
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
}

/** Apache-2.0 要求一併附上的 NOTICE 檔 */
export function noticeFiles(files: readonly string[]): string[] {
  return files.filter((f) => NOTICE_NAME.test(f)).sort()
}

interface PackageJson {
  name?: string
  version?: string
  license?: unknown
  licenses?: unknown
  author?: unknown
  homepage?: unknown
  repository?: unknown
}

/** package.json 的授權欄位(新的 "license": "MIT",舊的 {type} 或 "licenses": [...])→ 授權代號 */
export function licenseId(pkg: PackageJson): string {
  const typeOf = (v: unknown) =>
    typeof v === 'string' ? v
      : v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string' ? (v as { type: string }).type
        : ''
  const v = pkg.license ?? pkg.licenses
  const id = Array.isArray(v) ? v.map(typeOf).filter(Boolean).join(' OR ') : typeOf(v)
  return id || 'UNKNOWN'
}

/** author 欄位("名字 <email> (網址)" 或 {name})→ 名字 */
export function personName(p: unknown): string | undefined {
  if (typeof p === 'string') return p.replace(/<[^>]*>|\([^)]*\)/g, '').trim() || undefined
  if (p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string') {
    return (p as { name: string }).name.trim() || undefined
  }
  return undefined
}

/** repository 網址(git+https、git://、git@host:、github:owner/repo、owner/repo)→ 瀏覽器打得開的網址 */
export function repoUrl(repo: string): string | undefined {
  const s = repo.trim()
  const short = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/.exec(s)
  if (short) {
    const host = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }[short[1] ?? 'github']
    return `https://${host}/${short[2].replace(/\.git$/, '')}`
  }
  const url = s
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:/]+):/, 'https://$1/')
    .replace(/\.git$/, '')
  return /^https?:\/\//.test(url) ? url : undefined
}

/** 專案網頁:有 homepage 用 homepage,不然用原始碼庫 */
export function projectUrl(pkg: PackageJson): string | undefined {
  if (typeof pkg.homepage === 'string' && /^https?:\/\//.test(pkg.homepage)) return pkg.homepage
  const repo = typeof pkg.repository === 'string' ? pkg.repository
    : pkg.repository && typeof pkg.repository === 'object' ? (pkg.repository as { url?: unknown }).url : undefined
  return typeof repo === 'string' ? repoUrl(repo) : undefined
}

/** 檔案開頭的區塊註解(去掉每行的 *)—— snippet 的授權聲明寫在這裡 */
export function leadingComment(code: string): string {
  const m = /^\s*\/\*([\s\S]*?)\*\//.exec(code)
  return m ? m[1].split('\n').map((line) => line.replace(/^\s*\*+ ?/, '')).join('\n').trim() : ''
}

/** workbox 執行檔的每個模組都留著 self["workbox:<模組>:<版本>"] 標記 → 用到的 workbox 套件 */
export function workboxModules(code: string): string[] {
  return [...new Set([...code.matchAll(/workbox:([a-z-]+):\d/g)].map((m) => `workbox-${m[1]}`))].sort()
}

/** 照 Node 的找法:從 from 往上一層層找 node_modules/<name> */
function findPackageDir(name: string, from: string): string | null {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate)
    if (path.dirname(dir) === dir) return null
  }
}

/** 相依鏈(['vite-plugin-pwa', 'workbox-build', 'workbox-core'])→ 最後那個套件的目錄;找不到是 null */
export function resolveChain(chain: readonly string[], root: string): string | null {
  let dir: string | null = root
  for (const name of chain) {
    if (dir === null) return null
    dir = findPackageDir(name, dir)
  }
  return dir
}

function readText(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim()
}

/** 讀一個套件的 package.json 與授權檔 */
export function readPackage(dir: string): PackageNotice {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as PackageJson
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile())
  const name = pkg.name ?? path.basename(dir)
  let text = [...licenseFiles(files), ...noticeFiles(files)].map((f) => readText(path.join(dir, f))).join('\n\n')
  if (TRIM[name]) text = text.replace(TRIM[name], '').trim()
  return {
    name,
    version: pkg.version,
    license: licenseId(pkg),
    author: personName(pkg.author),
    url: projectUrl(pkg),
    text,
  }
}

/** snippet 的授權聲明 → 授權代號 */
function guessLicense(notice: string): string {
  if (/Apache License,? Version 2\.0/i.test(notice)) return 'Apache-2.0'
  if (/\bMIT\b/.test(notice)) return 'MIT'
  return 'UNKNOWN'
}

/**
 * 模組 id、資源檔路徑 → 每個套件的授權資料(依名稱排序,同名同版只留一筆)。
 * extraChains:看不到模組、要另外列的套件(service worker 的)。missing 是沒附授權全文的套件,建置時會警告。
 */
export function collectNotices(
  ids: Iterable<string>, root: string, extraChains: readonly (readonly string[])[] = [],
): { packages: PackageNotice[]; missing: string[] } {
  const dirs = new Set<string>()
  const snippets = new Map<string, { file: string; dir: string }>()
  const addChain = (chain: readonly string[]) => {
    const dir = resolveChain(chain, root)
    if (dir === null) throw new Error(`找不到套件 ${chain.join(' > ')}`)
    dirs.add(dir)
  }
  for (const id of ids) {
    const chain = virtualSource(id)
    if (chain) { addChain(chain); continue }
    const pkg = locatePackage(id)
    if (!pkg || !fs.existsSync(path.join(pkg.root, 'package.json'))) continue
    const dir = fs.realpathSync(pkg.root)
    dirs.add(dir)
    const crate = snippetCrate(id)
    if (crate && !snippets.has(crate)) snippets.set(crate, { file: normalizeId(id), dir })
  }
  extraChains.forEach(addChain)

  const byKey = new Map<string, PackageNotice>()
  for (const dir of dirs) {
    const notice = readPackage(dir)
    byKey.set(`${notice.name}@${notice.version ?? ''}`, notice)
  }
  const packages = [...byKey.values()]

  // snippet 的授權聲明只說「依 Apache License 2.0」,條款全文借用清單裡別的套件附的那份
  const apacheText = packages
    .map((p) => /Apache License\s+Version 2\.0, January 2004[\s\S]*?END OF TERMS AND CONDITIONS/.exec(p.text)?.[0])
    .find((t) => t !== undefined)
  for (const [crate, { file, dir }] of snippets) {
    const notice = fs.existsSync(file) ? leadingComment(fs.readFileSync(file, 'utf8')) : ''
    const license = guessLicense(notice)
    packages.push({
      name: crate,
      license,
      url: `https://crates.io/crates/${crate}`,
      bundledIn: readPackage(dir).name,
      text: [notice, license === 'Apache-2.0' ? apacheText : undefined].filter(Boolean).join('\n\n'),
    })
  }

  packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { packages, missing: packages.filter((p) => p.text === '').map((p) => p.name) }
}

/** generateBundle 拿到的輸出:chunk 看 moduleIds(Rolldown 的 OutputChunk 有,沒有就退回 modules 的 key),資源檔看原始路徑 */
type BundleLike = Record<string,
  | { type: 'chunk'; moduleIds?: readonly string[]; modules: Record<string, unknown> }
  | { type: 'asset'; originalFileNames?: readonly string[] }>

function bundleSources(bundle: BundleLike, root: string, into: Set<string>): void {
  for (const out of Object.values(bundle)) {
    if (out.type === 'chunk') for (const id of out.moduleIds ?? Object.keys(out.modules)) into.add(id)
    else for (const f of out.originalFileNames ?? []) into.add(path.resolve(root, f))
  }
}

/**
 * 建置完核對 service worker:workbox 執行檔用到的模組都要在 SW_PACKAGES 裡,
 * 套件清單也要在預先快取裡(globPatterns 預設只收 js/css/html)。回傳問題,沒問題是空陣列。
 */
export function checkServiceWorker(outDir: string): string[] {
  if (!fs.existsSync(path.join(outDir, 'sw.js'))) return ['dist 裡沒有 sw.js,沒辦法核對 service worker']
  const files = fs.readdirSync(outDir).filter((f) => f === 'sw.js' || /^workbox-[\w-]+\.js$/.test(f))
  const code = files.map((f) => fs.readFileSync(path.join(outDir, f), 'utf8')).join('\n')
  const listed = new Set(SW_PACKAGES.map((chain) => chain[chain.length - 1]))
  const problems = workboxModules(code).filter((m) => !listed.has(m))
    .map((m) => `service worker 用到 ${m},請加進 vite-plugins/thirdPartyLicenses.ts 的 SW_PACKAGES`)
  if (!code.includes(LICENSES_FILE)) {
    problems.push(`${LICENSES_FILE} 不在 service worker 的預先快取裡,請檢查 vite.config.ts 的 workbox.globPatterns`)
  }
  return problems
}

/**
 * 用法(vite.config.ts):
 *   const licenses = thirdPartyLicenses()
 *   plugins: [..., licenses.main, VitePWA(...)], worker: { plugins: () => [licenses.worker()] }
 */
export function thirdPartyLicenses(): { main: Plugin; worker: () => Plugin } {
  let root = process.cwd()
  let outDir = path.join(root, 'dist')
  let isBuild = false
  // worker 在主程式 transform 時就先打包完了,它的模組先存在這裡,等主程式 generateBundle 一起整理
  const fromWorkers = new Set<string>()

  const main: Plugin = {
    name: 'third-party-licenses',
    configResolved(config) {
      root = config.root
      outDir = path.resolve(config.root, config.build.outDir)
      isBuild = config.command === 'build'
    },
    // 開發模式沒有打包結果:先列 package.json 的直接相依(可能多列伺服器才用的套件),頁面會註明不完整
    configureServer(server) {
      const url = `${server.config.base}${LICENSES_FILE}`
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== url) return next()
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { dependencies?: object }
        const chains = Object.keys(pkg.dependencies ?? {}).map((name) => [name])
        const data: LicensesFile = { partial: true, packages: collectNotices([], root, chains).packages }
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(data))
      })
    },
    generateBundle(_, bundle) {
      const ids = new Set(fromWorkers)
      bundleSources(bundle, root, ids)
      const { packages, missing } = collectNotices(ids, root, SW_PACKAGES)
      if (missing.length) this.warn(`這些套件沒附授權全文,頁面上只會顯示授權代號:${missing.join(', ')}`)
      const data: LicensesFile = { packages }
      this.emitFile({ type: 'asset', fileName: LICENSES_FILE, source: JSON.stringify(data) })
    },
    // vite-plugin-pwa 在 closeBundle 才產生 service worker:排在它後面核對
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        if (!isBuild) return // 開發伺服器關掉時也會呼叫
        const problems = checkServiceWorker(outDir)
        if (problems.length) throw new Error(`[third-party-licenses]\n${problems.join('\n')}`)
      },
    },
  }

  const worker = (): Plugin => ({
    name: 'third-party-licenses:worker',
    generateBundle(_, bundle) {
      bundleSources(bundle, root, fromWorkers)
    },
  })

  return { main, worker }
}
