// 手動部署:打包之後依序 列出待套 migration → 套用 → 部署,和 CI 同一個順序,任何一步失敗就停。
// - 列出那一步保持互動:沒登入或有多個帳號時,wrangler 會在這裡登入 / 選帳號並記住
// - 套用那一步關掉 stdin:wrangler 視為非互動,「繼續嗎?」自動回答 yes(和 CI 一樣)。
//   互動模式下回答 no 時 wrangler 仍回傳 0,接著就會部署出用到新欄位、資料庫卻還沒有的程式
// 用 Node 呼叫而不是在 package.json 寫 `< /dev/null`,Windows 的 cmd.exe 也能跑。
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const DB = 'anki-pwa'

function wranglerBin() {
  // 測試時可以換成假的 wrangler;平常用專案裝的那一版
  if (process.env.DEPLOY_WRANGLER_BIN) return process.env.DEPLOY_WRANGLER_BIN
  const require = createRequire(import.meta.url)
  const pkgPath = require.resolve('wrangler/package.json')
  const bin = require(pkgPath).bin
  return join(dirname(pkgPath), typeof bin === 'string' ? bin : bin.wrangler)
}

const steps = [
  { args: ['d1', 'migrations', 'list', DB, '--remote'], stdin: 'inherit' },
  { args: ['d1', 'migrations', 'apply', DB, '--remote'], stdin: 'ignore' },
  { args: ['deploy'], stdin: 'inherit' },
]

const bin = wranglerBin()
for (const { args, stdin } of steps) {
  const r = spawnSync(process.execPath, [bin, ...args], { stdio: [stdin, 'inherit', 'inherit'] })
  if (r.status !== 0) {
    console.error(`\n✗ wrangler ${args.join(' ')} 失敗,停止部署`)
    process.exit(r.status ?? 1)
  }
}
