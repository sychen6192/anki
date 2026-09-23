import { describe, it, expect } from 'vitest'
import {
  createShare, fetchShare, normalizeSharedRows, parseShareCode, shareUrlFor, storageSeparateFromApp,
} from '../src/lib/share'

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
    let seen: { headers: Record<string, string>; json: unknown } | null = null
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>
      const text = await new Response(
        (init!.body as Blob).stream().pipeThrough(new DecompressionStream('gzip')),
      ).text()
      seen = { headers, json: JSON.parse(text) }
      return new Response(JSON.stringify({ code: 'abcd2345' }))
    }) as typeof fetch
    expect(await createShare('日文', rows, fetchFn)).toBe('abcd2345')
    expect(seen!.headers['x-body-gzip']).toBe('1')
    expect(seen!.json).toEqual({ name: '日文', rows })
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

  it('iPhone、偽裝成 Mac 的 iPad、App 內建瀏覽器:資料和 App 分開', () => {
    expect(storageSeparateFromApp(IPHONE_SAFARI, 5)).toBe(true)
    expect(storageSeparateFromApp(IPAD_DESKTOP_UA, 5)).toBe(true)
    expect(storageSeparateFromApp(LINE_ANDROID, 5)).toBe(true)
  })

  it('Android Chrome 與桌機:共用資料,不必提醒', () => {
    expect(storageSeparateFromApp(ANDROID_CHROME, 5)).toBe(false)
    expect(storageSeparateFromApp(MAC_CHROME, 0)).toBe(false)
    expect(storageSeparateFromApp(IPAD_DESKTOP_UA, 0)).toBe(false) // 真的 Mac Safari
  })
})
