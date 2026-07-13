import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import app from './index'

const empty = { decks: [], notes: [], cards: [], review_logs: [] }

const deck = (over: Record<string, unknown> = {}) => ({
  id: 'd1', name: '日文', new_per_day: 20, updated_at: 1000, deleted: 0, ...over,
})

async function push(body: unknown) {
  const res = await app.request('/api/sync', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }, env)
  expect(res.status).toBe(200)
}

async function pull(since = 0): Promise<any> {
  const res = await app.request(`/api/sync?since=${since}`, {}, env)
  expect(res.status).toBe(200)
  return res.json()
}

describe('/api/sync', () => {
  it('push 後 pull 拿得到記錄與遞增 seq', async () => {
    await push({ ...empty, decks: [deck()] })
    const out = await pull(0)
    expect(out.decks).toHaveLength(1)
    expect(out.decks[0]).toMatchObject({ id: 'd1', name: '日文' })
    expect(out.decks[0].server_seq).toBeUndefined() // 內部欄位不外洩
    expect(out.seq).toBeGreaterThan(0)
  })

  it('LWW:較新的蓋過較舊,較舊/同時間戳被忽略', async () => {
    await push({ ...empty, decks: [deck({ updated_at: 1000, name: 'old' })] })
    await push({ ...empty, decks: [deck({ updated_at: 2000, name: 'new' })] })
    await push({ ...empty, decks: [deck({ updated_at: 1500, name: 'stale' })] })
    await push({ ...empty, decks: [deck({ updated_at: 2000, name: 'same-ts' })] })
    const out = await pull(0)
    expect(out.decks).toHaveLength(1)
    expect(out.decks[0].name).toBe('new')
  })

  it('pull since 只回傳之後的變更', async () => {
    await push({ ...empty, decks: [deck({ id: 'a' })] })
    const mid = (await pull(0)).seq
    await push({ ...empty, decks: [deck({ id: 'b' })] })
    const out = await pull(mid)
    expect(out.decks.map((d: { id: string }) => d.id)).toEqual(['b'])
  })

  it('review_logs 冪等:同 id 重送只留一筆', async () => {
    const log = {
      id: 'r1', card_id: 'c1', rating: 3, state: 0, due: 1, stability: 1, difficulty: 5,
      elapsed_days: 0, last_elapsed_days: 0, scheduled_days: 1, reviewed_at: 999,
    }
    await push({ ...empty, review_logs: [log] })
    await push({ ...empty, review_logs: [log] })
    const out = await pull(0)
    expect(out.review_logs).toHaveLength(1)
  })

  it('墓碑會傳播', async () => {
    await push({ ...empty, decks: [deck({ updated_at: 1000 })] })
    await push({ ...empty, decks: [deck({ updated_at: 2000, deleted: 1 })] })
    const out = await pull(0)
    expect(out.decks[0].deleted).toBe(1)
  })
})
