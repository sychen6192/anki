import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  createShare, fetchShare, isInAppBrowser, isStandaloneApp, isTouchDevice, normalizeSharedRows,
  parseShareCode, shareUrlFor, storageSeparateFromApp,
} from '../src/lib/share'

afterEach(() => vi.unstubAllGlobals())

describe('parseShareCode', () => {
  it.each([
    ['https://anki-pwa.someone.workers.dev/import?share=7zpwkhwk', '7zpwkhwk'],
    ['  https://x.dev/import?foo=1&share=AbCd2345  ', 'abcd2345'],
    ['/import?share=7zpwkhwk', '7zpwkhwk'],
    ['?share=7zpwkhwk', '7zpwkhwk'],
    ['7zpwkhwk', '7zpwkhwk'],
    ['朋友傳來:https://x.dev/import?share=k2m3n4p5 快來背', 'k2m3n4p5'],
  ])('%s → %s', (input, code) => {
    expect(parseShareCode(input)).toBe(code)
  })

  it.each(['', '   ', 'https://x.dev/import', 'hello world', 'abc', '這不是連結'])('認不出來:%s', (input) => {
    expect(parseShareCode(input)).toBeNull()
  })

  it('shareUrlFor 組出來的網址能被解析回同一個碼', () => {
    expect(parseShareCode(shareUrlFor('https://a.dev', 'q7w8e9r2'))).toBe('q7w8e9r2')
  })
})

describe('normalizeSharedRows', () => {
  it('修剪空白、缺欄補空字串、丟掉缺單字或意思的列與壞資料', () => {
    expect(normalizeSharedRows([
      { expression: ' 犬 ', reading: 'いぬ ', meaning: ' 狗', accent: '2' },
      { expression: '猫', meaning: '貓' },
      { expression: '', meaning: '空' },
      { expression: '鳥', meaning: '   ' },
      null, 'text', 42,
      { expression: 5, meaning: '數字單字' },
    ])).toEqual([
      { expression: '犬', reading: 'いぬ', meaning: '狗', accent: '2' },
      { expression: '猫', reading: '', meaning: '貓', accent: '' },
    ])
  })

  it('不是陣列回空陣列', () => {
    expect(normalizeSharedRows(undefined)).toEqual([])
    expect(normalizeSharedRows({ rows: [] })).toEqual([])
  })
})

describe('createShare', () => {
  const rows = [{ expression: '犬', reading: 'いぬ', meaning: '狗', accent: '' }]

  it('gzip 上傳,帶 x-body-gzip,內容解壓回原本的 JSON', async () => {
    let seen: { url: string; method?: string; headers: Record<string, string>; json: unknown } | null = null
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>
      const text = await new Response(
        (init!.body as Blob).stream().pipeThrough(new DecompressionStream('gzip')),
      ).text()
      seen = { url: String(url), method: init!.method, headers, json: JSON.parse(text) }
      return new Response(JSON.stringify({ code: 'abcd2345' }))
    }) as typeof fetch
    expect(await createShare('日文', rows, fetchFn)).toBe('abcd2345')
    expect(seen!.url).toBe('/api/share')
    expect(seen!.method).toBe('POST')
    expect(seen!.headers['x-body-gzip']).toBe('1')
    expect(seen!.json).toEqual({ name: '日文', rows })
  })

  it('瀏覽器沒有 CompressionStream 時送未壓縮的 JSON,不帶 x-body-gzip', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    let seen: { headers: Record<string, string>; body: unknown } | null = null
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      seen = { headers: init!.headers as Record<string, string>, body: init!.body }
      return new Response(JSON.stringify({ code: 'plain234' }))
    }) as typeof fetch
    expect(await createShare('日文', rows, fetchFn)).toBe('plain234')
    expect(seen!.headers['x-body-gzip']).toBeUndefined()
    expect(JSON.parse(seen!.body as string)).toEqual({ name: '日文', rows })
  })

  it('伺服器錯誤或沒回分享碼都丟出錯誤', async () => {
    const err = (async () => new Response('x', { status: 500 })) as typeof fetch
    await expect(createShare('A', rows, err)).rejects.toThrow('HTTP 500')
    const noCode = (async () => new Response('{}')) as typeof fetch
    await expect(createShare('A', rows, noCode)).rejects.toThrow('分享碼')
  })
})

describe('fetchShare', () => {
  it('回傳清理過的內容;名稱空白時給預設名', async () => {
    const fetchFn = (async (url: unknown) => {
      expect(String(url)).toBe('/api/share/abcd2345')
      return new Response(JSON.stringify({ name: '  ', rows: [{ expression: '犬 ', meaning: '狗' }, { expression: '' }] }))
    }) as typeof fetch
    expect(await fetchShare('abcd2345', fetchFn)).toEqual({
      name: '分享的牌組', rows: [{ expression: '犬', reading: '', meaning: '狗', accent: '' }],
    })
  })

  it('404 講人話,其他錯誤帶狀態碼', async () => {
    await expect(fetchShare('x', (async () => new Response('', { status: 404 })) as typeof fetch)).rejects.toThrow('找不到這個分享')
    await expect(fetchShare('x', (async () => new Response('', { status: 503 })) as typeof fetch)).rejects.toThrow('503')
  })
})

describe('storageSeparateFromApp', () => {
  const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
  const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15'
  const LINE_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0 Mobile Safari/537.36 Line/14.12.0'
  const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36'
  const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

  const KAKAO_WEBVIEW = 'Mozilla/5.0 (Linux; Android 14; SM-S918N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0 Mobile Safari/537.36;KAKAOTALK 2410330'
  const MAC_EDGE = MAC_CHROME + ' Edg/128.0'
  const MAC_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:130.0) Gecko/20100101 Firefox/130.0'
  const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0 Mobile/15E148 Safari/604.1'
  const IOS_INSTAGRAM = IPHONE_SAFARI.replace(' Safari/604.1', ' Instagram 350.0.0.0')

  it('iPhone(含 iOS 的 Chrome)、偽裝成 Mac 的 iPad、Mac Safari、App 內建瀏覽器:資料和 App 分開', () => {
    expect(storageSeparateFromApp(IPHONE_SAFARI, 5)).toBe(true)
    expect(storageSeparateFromApp(IOS_CHROME, 5)).toBe(true)
    expect(storageSeparateFromApp(IPAD_DESKTOP_UA, 5)).toBe(true)
    expect(storageSeparateFromApp(IPAD_DESKTOP_UA, 0)).toBe(true) // 真的 Mac Safari:加入 Dock 的網頁 App 也分開存
    expect(storageSeparateFromApp(LINE_ANDROID, 5)).toBe(true)
    expect(storageSeparateFromApp(KAKAO_WEBVIEW, 5)).toBe(true)
  })

  it('Android Chrome 與桌機的 Chrome / Edge / Firefox:共用資料,不必提醒', () => {
    expect(storageSeparateFromApp(ANDROID_CHROME, 5)).toBe(false)
    expect(storageSeparateFromApp(MAC_CHROME, 0)).toBe(false)
    expect(storageSeparateFromApp(MAC_EDGE, 0)).toBe(false)
    expect(storageSeparateFromApp(MAC_FIREFOX, 0)).toBe(false)
  })

  it('isInAppBrowser:認得各家內建瀏覽器與 Android WebView,一般瀏覽器不算', () => {
    for (const ua of [LINE_ANDROID, KAKAO_WEBVIEW, IOS_INSTAGRAM, IPHONE_SAFARI + ' [FBAN/FBIOS;FBAV/480.0]', ANDROID_CHROME + ' MicroMessenger/8.0']) {
      expect(isInAppBrowser(ua)).toBe(true)
    }
    for (const ua of [IPHONE_SAFARI, IOS_CHROME, ANDROID_CHROME, MAC_CHROME, MAC_FIREFOX]) {
      expect(isInAppBrowser(ua)).toBe(false)
    }
  })
})

describe('isStandaloneApp / isTouchDevice', () => {
  const media = (matching: string[]) => (q: string) => ({ matches: matching.includes(q), media: q })

  it('display-mode: standalone 或 iOS 的 navigator.standalone 都算從主畫面打開', () => {
    vi.stubGlobal('matchMedia', media(['(display-mode: standalone)']))
    vi.stubGlobal('navigator', {})
    expect(isStandaloneApp()).toBe(true)
    vi.stubGlobal('matchMedia', media([]))
    vi.stubGlobal('navigator', { standalone: true })
    expect(isStandaloneApp()).toBe(true)
    vi.stubGlobal('navigator', { standalone: false })
    expect(isStandaloneApp()).toBe(false)
  })

  it('hover: none 才算觸控裝置;沒有 matchMedia 的環境回 false', () => {
    vi.stubGlobal('matchMedia', media(['(hover: none)']))
    expect(isTouchDevice()).toBe(true)
    vi.stubGlobal('matchMedia', media([]))
    expect(isTouchDevice()).toBe(false)
    vi.stubGlobal('matchMedia', undefined)
    expect(isTouchDevice()).toBe(false)
  })
})
