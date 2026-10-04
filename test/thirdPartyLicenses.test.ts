import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  SW_PACKAGES, checkServiceWorker, collectNotices, leadingComment, licenseFiles, licenseId, locatePackage,
  noticeFiles, personName, projectUrl, repoUrl, resolveChain, snippetCrate, virtualSource, workboxModules,
} from '../vite-plugins/thirdPartyLicenses'
import { reflow } from '../src/lib/licenses'

// 授權頁的套件清單是建置時從打包結果推出來的:模組 id → 套件、套件 → 授權檔,這兩步錯了就會漏列或列錯

const ROOT = process.cwd()

describe('模組 id → 套件', () => {
  it('一般套件、scoped 套件', () => {
    expect(locatePackage('/app/node_modules/react/cjs/react.production.js'))
      .toEqual({ root: '/app/node_modules/react', name: 'react' })
    expect(locatePackage('/app/node_modules/@babel/helpers/lib/index.js'))
      .toEqual({ root: '/app/node_modules/@babel/helpers', name: '@babel/helpers' })
  })

  it('巢狀 node_modules 取最裡面那層(pnpm 的路徑也是)', () => {
    expect(locatePackage('/app/node_modules/workbox-build/node_modules/pretty-bytes/index.js'))
      .toEqual({ root: '/app/node_modules/workbox-build/node_modules/pretty-bytes', name: 'pretty-bytes' })
    expect(locatePackage('/app/node_modules/.pnpm/react@19.2.7/node_modules/react/index.js'))
      .toEqual({ root: '/app/node_modules/.pnpm/react@19.2.7/node_modules/react', name: 'react' })
  })

  it('去掉 \\0 前綴、?url 這類查詢字串;Windows 路徑、相對路徑也認得', () => {
    expect(locatePackage('\0/app/node_modules/sql.js/dist/sql-wasm.wasm?url')?.name).toBe('sql.js')
    expect(locatePackage('C:\\app\\node_modules\\@scope\\pkg\\index.js'))
      .toEqual({ root: 'C:/app/node_modules/@scope/pkg', name: '@scope/pkg' })
    expect(locatePackage('../../node_modules/fsrs-browser/fsrs_browser_bg.wasm')?.name).toBe('fsrs-browser')
    expect(locatePackage('node_modules/fflate/esm/browser.js')?.name).toBe('fflate')
  })

  it('專案自己的檔案、Vite 預先打包的 .vite/deps、不完整的 scoped 路徑都不算', () => {
    expect(locatePackage('/app/src/lib/csv.ts')).toBeNull()
    expect(locatePackage('/app/node_modules/.vite/deps/react.js')).toBeNull()
    expect(locatePackage('/app/node_modules/@scope')).toBeNull()
  })

  it('Vite / Rolldown 塞進去的虛擬模組對到它們自己的套件', () => {
    expect(virtualSource('\0vite/preload-helper.js')).toEqual(['vite'])
    expect(virtualSource('\0vite/modulepreload-polyfill.js')).toEqual(['vite'])
    expect(virtualSource('\0rolldown/runtime.js')).toEqual(['vite', 'rolldown'])
    expect(virtualSource('/app/src/main.tsx')).toBeNull()
    expect(virtualSource('\0commonjs-helpers')).toBeNull()
  })

  it('wasm-bindgen 的 snippets 認得出 crate 名稱', () => {
    expect(snippetCrate('/app/node_modules/fsrs-browser/snippets/wasm-bindgen-rayon-38edf6e439f6d70d/src/workerHelpers.js'))
      .toBe('wasm-bindgen-rayon')
    expect(snippetCrate('/app/node_modules/fsrs-browser/fsrs_browser.js')).toBeNull()
  })
})

describe('授權檔', () => {
  it('不分大小寫認得 LICENSE、LICENCE、COPYING 與副檔名,標準檔名排前面;程式檔不算', () => {
    const files = ['README.md', 'LICENSE-MIT', 'license.js', 'package.json', 'COPYING', 'Licence.txt', 'LICENSE', 'license',
      'LICENSE.md', 'NOTICE', 'licenses.d.ts']
    expect(licenseFiles(files)).toEqual(['COPYING', 'LICENSE', 'LICENSE.md', 'Licence.txt', 'license', 'LICENSE-MIT'])
    expect(noticeFiles(files)).toEqual(['NOTICE'])
  })

  it('package.json 的授權欄位:字串、舊式 {type}、licenses 陣列', () => {
    expect(licenseId({ license: 'MIT' })).toBe('MIT')
    expect(licenseId({ license: { type: 'ISC' } })).toBe('ISC')
    expect(licenseId({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0')
    expect(licenseId({})).toBe('UNKNOWN')
  })

  it('作者名字去掉 email 與網址', () => {
    expect(personName('Remix Software <hello@remix.run>')).toBe('Remix Software')
    expect(personName('Yusuke Wada <y@example.com> (https://github.com/yusukebe)')).toBe('Yusuke Wada')
    expect(personName({ name: 'Matthew Holt', url: 'https://twitter.com/mholt6' })).toBe('Matthew Holt')
    expect(personName(undefined)).toBeUndefined()
  })

  it('原始碼庫網址轉成打得開的網址', () => {
    expect(repoUrl('git+https://github.com/dexie/Dexie.js.git')).toBe('https://github.com/dexie/Dexie.js')
    expect(repoUrl('git://github.com/jakearchibald/idb.git')).toBe('https://github.com/jakearchibald/idb')
    expect(repoUrl('git@github.com:owner/repo.git')).toBe('https://github.com/owner/repo')
    expect(repoUrl('github:owner/repo')).toBe('https://github.com/owner/repo')
    expect(repoUrl('owner/repo')).toBe('https://github.com/owner/repo')
    expect(repoUrl('not a url')).toBeUndefined()
    expect(projectUrl({ homepage: 'https://react.dev/', repository: 'facebook/react' })).toBe('https://react.dev/')
    expect(projectUrl({ repository: { type: 'git', url: 'https://github.com/remix-run/react-router' } }))
      .toBe('https://github.com/remix-run/react-router')
  })

  it('檔案開頭的區塊註解', () => {
    expect(leadingComment('/*\n * Copyright 2022 Google Inc.\n * Licensed under X\n */\nexport {}'))
      .toBe('Copyright 2022 Google Inc.\nLicensed under X')
    expect(leadingComment('export {}')).toBe('')
  })
})

describe('讀套件資料夾', () => {
  const dir = mkdtempSync(join(tmpdir(), 'licenses-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const write = (rel: string, content: string) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  write('node_modules/alpha/package.json', JSON.stringify({ name: 'alpha', version: '1.0.0', license: 'MIT' }))
  write('node_modules/alpha/licence.md', 'MIT alpha text')
  write('node_modules/alpha/index.js', '')
  write('node_modules/@s/beta/package.json', JSON.stringify({ name: '@s/beta', version: '2.0.0', license: 'Apache-2.0' }))
  write('node_modules/@s/beta/COPYING', 'beta license')
  write('node_modules/@s/beta/NOTICE.txt', 'beta notice')
  write('node_modules/@s/beta/lib/x.js', '')
  // 巢狀:alpha 自己帶了另一版的 beta
  write('node_modules/alpha/node_modules/@s/beta/package.json', JSON.stringify({ name: '@s/beta', version: '1.0.0', license: 'MIT' }))
  write('node_modules/alpha/node_modules/@s/beta/LICENSE', 'old beta')
  write('node_modules/gamma/package.json', JSON.stringify({ name: 'gamma', version: '0.1.0', license: 'ISC' }))
  write('node_modules/gamma/license', 'gamma license')
  // 沒附授權檔的套件
  write('node_modules/delta/package.json', JSON.stringify({ name: 'delta', version: '3.0.0', license: 'MIT' }))

  it('照模組 id 收套件,讀出授權全文(含 NOTICE),同名不同版各列一筆,沒附授權檔的回報出來', () => {
    const { packages, missing } = collectNotices([
      join(dir, 'node_modules/alpha/index.js'),
      join(dir, 'node_modules/alpha/index.js?url'),
      join(dir, 'node_modules/@s/beta/lib/x.js'),
      join(dir, 'node_modules/alpha/node_modules/@s/beta/index.js'),
      join(dir, 'node_modules/delta/index.js'),
      join(dir, 'src/main.tsx'),
    ], dir, [['alpha', '@s/beta']])
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual(['@s/beta@2.0.0', '@s/beta@1.0.0', 'alpha@1.0.0', 'delta@3.0.0'])
    expect(packages.find((p) => p.name === 'alpha')?.text).toBe('MIT alpha text')
    expect(packages.find((p) => p.version === '2.0.0')?.text).toBe('beta license\n\nbeta notice')
    expect(missing).toEqual(['delta'])
  })

  it('相依鏈照 Node 的找法:先找巢狀的,沒有才往上', () => {
    expect(resolveChain(['alpha', '@s/beta'], dir)).toMatch(/alpha[/\\]node_modules[/\\]@s[/\\]beta$/)
    expect(resolveChain(['gamma', '@s/beta'], dir)).toMatch(/node_modules[/\\]@s[/\\]beta$/)
    expect(resolveChain(['gamma', '@s/beta'], dir)).not.toMatch(/alpha/)
    expect(resolveChain(['nope'], dir)).toBeNull()
  })

  it('找不到相依鏈裡的套件就報錯(SW_PACKAGES 寫錯要看得出來)', () => {
    expect(() => collectNotices([], dir, [['nope']])).toThrow(/nope/)
  })
})

describe('service worker 的套件', () => {
  it('SW_PACKAGES 列的每個套件都裝在 node_modules 裡', () => {
    for (const chain of SW_PACKAGES) {
      const dir = resolveChain(chain, ROOT)
      expect(dir, chain.join(' > ')).not.toBeNull()
      const pkg = JSON.parse(readFileSync(join(dir!, 'package.json'), 'utf8')) as { name: string }
      expect(pkg.name).toBe(chain[chain.length - 1])
    }
  })

  it('從 workbox 執行檔的標記讀出用到的模組', () => {
    const code = 'try{self["workbox:core:7.4.0"]&&_()}catch(t){}…try{self["workbox:routing:7.4.0"]&&_()}catch(t){}'
      + 'try{self["workbox:core:7.4.0"]&&_()}catch(t){}try{self["workbox:cacheable-response:7.4.0"]&&_()}catch(t){}'
    expect(workboxModules(code)).toEqual(['workbox-cacheable-response', 'workbox-core', 'workbox-routing'])
  })

  it('建置完的核對:沒列到的 workbox 模組、沒進預先快取的清單都要報出來', () => {
    const out = mkdtempSync(join(tmpdir(), 'sw-'))
    try {
      expect(checkServiceWorker(out)).toEqual([expect.stringContaining('沒有 sw.js')])
      writeFileSync(join(out, 'sw.js'), 'precacheAndRoute([{url:"third-party-licenses.json",revision:"1"}])')
      writeFileSync(join(out, 'workbox-abc123.js'), 'self["workbox:core:7.4.0"];self["workbox:precaching:7.4.0"]')
      expect(checkServiceWorker(out)).toEqual([])
      writeFileSync(join(out, 'workbox-abc123.js'), 'self["workbox:core:7.4.0"];self["workbox:cacheable-response:7.4.0"]')
      writeFileSync(join(out, 'sw.js'), 'precacheAndRoute([])')
      const problems = checkServiceWorker(out)
      expect(problems).toHaveLength(2)
      expect(problems[0]).toContain('workbox-cacheable-response')
      expect(problems[1]).toContain('third-party-licenses.json')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})

describe('實際的套件', () => {
  it('Vite 只留 Vite 本身的授權,不帶它在 Node 端打包的上百 KB 相依授權', () => {
    const { packages } = collectNotices(['\0vite/preload-helper.js', '\0rolldown/runtime.js'], ROOT)
    const vite = packages.find((p) => p.name === 'vite')
    expect(vite?.license).toBe('MIT')
    expect(vite?.text).toMatch(/^# Vite core license/)
    expect(vite?.text).not.toMatch(/bundled dependencies/i)
    expect(vite!.text.length).toBeLessThan(3000)
    expect(packages.map((p) => p.name)).toContain('rolldown')
  })

  it('fsrs-browser 裡的 wasm-bindgen-rayon 另外列出,附上 Apache-2.0 條款', () => {
    const fsrs = resolveChain(['fsrs-browser'], ROOT)!
    const snippetDir = join(fsrs, 'snippets')
    const crateDir = readdirSync(snippetDir).find((d) => d.startsWith('wasm-bindgen-rayon-'))!
    const { packages } = collectNotices([
      join(fsrs, 'fsrs_browser.js'),
      join(snippetDir, crateDir, 'src/workerHelpers.js'),
      join(resolveChain(['dexie'], ROOT)!, 'dist/dexie.mjs'),
    ], ROOT)
    const rayon = packages.find((p) => p.name === 'wasm-bindgen-rayon')
    expect(rayon).toMatchObject({ license: 'Apache-2.0', bundledIn: 'fsrs-browser' })
    expect(rayon?.text).toContain('Copyright 2022 Google Inc.')
    expect(rayon?.text).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')
    expect(packages.find((p) => p.name === 'fsrs-browser')?.license).toBe('BSD-3-Clause')
  })
})

describe('顯示時的換行', () => {
  it('同一段的硬換行接成空白,空行分段照舊', () => {
    expect(reflow('Permission is hereby granted, free of charge,\nto any person obtaining a copy.\n\nTHE SOFTWARE IS\nPROVIDED "AS IS".'))
      .toBe('Permission is hereby granted, free of charge, to any person obtaining a copy.\n\nTHE SOFTWARE IS PROVIDED "AS IS".')
  })

  it('縮排、標題、底線標題、清單、Copyright 行不接', () => {
    const apache = 'Apache License\n                           Version 2.0, January 2004\n   1. Definitions.\n      "License" shall mean'
    expect(reflow(apache)).toBe(apache)
    expect(reflow('# Vite core license\nVite is released under the MIT license:')).toBe('# Vite core license\nVite is released under the MIT license:')
    expect(reflow('MIT license\n===========\n\nCopyright (c) 2017 sql.js authors')).toBe('MIT license\n===========\n\nCopyright (c) 2017 sql.js authors')
    expect(reflow('Copyright (c) A 2015\nCopyright (c) B 2020\nPermission to use')).toBe('Copyright (c) A 2015\nCopyright (c) B 2020\nPermission to use')
    expect(reflow('Terms:\n- one\n- two\n1. three')).toBe('Terms:\n- one\n- two\n1. three')
  })

  it('文字本身不變(只差換行與空白)', () => {
    const text = readFileSync(join(resolveChain(['react'], ROOT)!, 'LICENSE'), 'utf8')
    expect(reflow(text).replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '))
    expect(reflow(text).split('\n').length).toBeLessThan(text.split('\n').length)
  })
})
