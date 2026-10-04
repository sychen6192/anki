import { describe, expect, it } from 'vitest'
import { fetchWithRetry } from '../src/lib/http'

const respond = (statuses: number[], retryAfter?: string) => {
  const calls: number[] = []
  const fetchFn = (async () => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)]
    calls.push(status)
    return new Response('{}', { status, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } })
  }) as typeof fetch
  return { fetchFn, calls }
}

describe('fetchWithRetry(伺服器限流 429)', () => {
  it('429 就照 Retry-After 等一下再送,成功就回成功的那個', async () => {
    const { fetchFn, calls } = respond([429, 429, 200], '5')
    const waits: number[] = []
    const res = await fetchWithRetry(fetchFn, '/x', undefined, async (ms) => { waits.push(ms) })
    expect(res.status).toBe(200)
    expect(calls).toEqual([429, 429, 200])
    expect(waits).toEqual([5000, 5000])
  })

  it('最多再送 3 次,還是 429 就把 429 交給呼叫端', async () => {
    const { fetchFn, calls } = respond([429])
    const res = await fetchWithRetry(fetchFn, '/x', undefined, async () => {})
    expect(res.status).toBe(429)
    expect(calls).toHaveLength(4)
  })

  it('Retry-After 沒給或亂給等 10 秒;給太長也只等 30 秒', async () => {
    for (const [header, wait] of [[undefined, 10_000], ['abc', 10_000], ['-1', 10_000], ['600', 30_000]] as const) {
      const { fetchFn } = respond([429, 200], header)
      const waits: number[] = []
      await fetchWithRetry(fetchFn, '/x', undefined, async (ms) => { waits.push(ms) })
      expect(waits, String(header)).toEqual([wait])
    }
  })

  it('其他狀態(含 5xx)不重送', async () => {
    const { fetchFn, calls } = respond([503])
    expect((await fetchWithRetry(fetchFn, '/x', undefined, async () => {})).status).toBe(503)
    expect(calls).toHaveLength(1)
  })
})
