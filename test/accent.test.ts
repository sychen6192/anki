import { describe, it, expect, vi } from 'vitest'
import { isValidAccent, lookupAccents, fillMissingAccents } from '../src/lib/accent'

describe('isValidAccent', () => {
  it('接受空字串與數字/逗號組合,拒絕其他', () => {
    expect(isValidAccent('')).toBe(true)
    expect(isValidAccent('0')).toBe(true)
    expect(isValidAccent('0,3')).toBe(true)
    expect(isValidAccent('12')).toBe(true)
    expect(isValidAccent('a')).toBe(false)
    expect(isValidAccent('1,')).toBe(false)
    expect(isValidAccent('1.5')).toBe(false)
    expect(isValidAccent('[2]')).toBe(false)
  })
})

// 假 fetch:回傳每個 item 的 reading 長度當假 pitch,方便斷言分批與對位。
function fakeFetch(capture: { count: number; batchSizes: number[] }) {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { items: { reading: string }[] }
    capture.count++
    capture.batchSizes.push(body.items.length)
    return new Response(JSON.stringify({ results: body.items.map((it) => String(it.reading.length)) }))
  }) as unknown as typeof fetch
}

describe('lookupAccents', () => {
  it('回傳與輸入同序的結果', async () => {
    const cap = { count: 0, batchSizes: [] as number[] }
    const out = await lookupAccents([{ expression: 'a', reading: 'xx' }, { expression: 'b', reading: 'y' }], fakeFetch(cap))
    expect(out).toEqual(['2', '1'])
    expect(cap.count).toBe(1)
  })
  it('超過 200 筆自動分批,結果仍對位', async () => {
    const cap = { count: 0, batchSizes: [] as number[] }
    const items = Array.from({ length: 250 }, (_, i) => ({ expression: `e${i}`, reading: 'z'.repeat((i % 3) + 1) }))
    const out = await lookupAccents(items, fakeFetch(cap))
    expect(out).toHaveLength(250)
    expect(cap.batchSizes).toEqual([200, 50])
    expect(out[0]).toBe('1')
    expect(out[249]).toBe(String(((249 % 3) + 1)))
  })
  it('HTTP 非 2xx 丟錯', async () => {
    const bad = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(lookupAccents([{ expression: 'a', reading: 'b' }], bad)).rejects.toThrow('lookup failed: 500')
  })
})

describe('fillMissingAccents', () => {
  it('只查 accent 為空的列,回填並計數,已填的保留', async () => {
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { items: { expression: string }[] }
      // 只有 expression 'hit' 查得到
      return new Response(JSON.stringify({ results: body.items.map((it) => (it.expression === 'hit' ? '1' : null)) }))
    }) as unknown as typeof fetch

    const rows = [
      { expression: 'keep', reading: 'a', accent: '2' },   // 已有,不查
      { expression: 'hit', reading: 'b', accent: '' },      // 查得到
      { expression: 'miss', reading: 'c', accent: '' },     // 查無
    ]
    const res = await fillMissingAccents(rows, fetchFn)
    expect(res.rows[0].accent).toBe('2')
    expect(res.rows[1].accent).toBe('1')
    expect(res.rows[2].accent).toBe('')
    expect(res.filled).toBe(1)
    expect(res.missed).toBe(1)
    // 不 mutate 輸入
    expect(rows[1].accent).toBe('')
  })
  it('沒有缺空的列時不呼叫 fetch', async () => {
    const spy = vi.fn()
    const rows = [{ expression: 'a', reading: 'b', accent: '0' }]
    const res = await fillMissingAccents(rows, spy as unknown as typeof fetch)
    expect(spy).not.toHaveBeenCalled()
    expect(res).toMatchObject({ filled: 0, missed: 0 })
    expect(res.rows).not.toBe(rows)
    expect(res.rows[0]).not.toBe(rows[0])
  })
})
