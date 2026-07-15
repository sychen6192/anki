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

  it('since 不是數字時回傳 400', async () => {
    const res = await app.request('/api/sync?since=abc', {}, env)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid since' })
  })

  it('單次 POST 推 120 筆混合資料表(跨多個 db.batch)→ 全部可 pull 回來', async () => {
    const decks = Array.from({ length: 60 }, (_, i) => deck({ id: `d${i}`, updated_at: 1000 + i }))
    const notes = Array.from({ length: 60 }, (_, i) => ({
      id: `n${i}`, deck_id: 'd0', expression: `e${i}`, reading: '', meaning: `m${i}`,
      reversed: 0, updated_at: 1000 + i, deleted: 0,
    }))
    await push({ ...empty, decks, notes })
    const out = await pull(0)
    expect(out.decks).toHaveLength(60)
    expect(out.notes).toHaveLength(60)
    expect(new Set(out.decks.map((d: { id: string }) => d.id)).size).toBe(60)
    expect(new Set(out.notes.map((n: { id: string }) => n.id)).size).toBe(60)
  })

  it('note 的 accent 會 round-trip;缺 accent 的舊 push 補成空字串', async () => {
    await push({ ...empty, notes: [
      { id: 'n1', deck_id: 'd1', expression: '食べる', reading: 'たべる', meaning: '吃', accent: '2', reversed: 0, updated_at: 1000, deleted: 0 },
      { id: 'n2', deck_id: 'd1', expression: '犬', reading: 'いぬ', meaning: '狗', reversed: 0, updated_at: 1000, deleted: 0 }, // 故意不含 accent
    ] })
    const out = await pull(0)
    const byId = Object.fromEntries(out.notes.map((n: { id: string }) => [n.id, n]))
    expect(byId.n1.accent).toBe('2')
    expect(byId.n2.accent).toBe('')
  })

  // 帶 x-sync-space header 的 push/pull
  async function pushNs(space: string, body: unknown) {
    const res = await app.request('/api/sync', {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-sync-space': space },
    }, env)
    expect(res.status).toBe(200)
  }
  async function pullNs(space: string, since = 0): Promise<any> {
    const res = await app.request(`/api/sync?since=${since}`, { headers: { 'x-sync-space': space } }, env)
    expect(res.status).toBe(200)
    return res.json()
  }

  it('namespace 隔離:A 空間 push 的資料,B 空間與預設空間都看不到', async () => {
    await pushNs('spaceA', { ...empty, decks: [deck({ id: 'da', name: 'A的牌組' })] })
    await pushNs('spaceB', { ...empty, decks: [deck({ id: 'db', name: 'B的牌組' })] })

    const outA = await pullNs('spaceA')
    const outB = await pullNs('spaceB')
    const outDefault = await pull(0) // 無 header = 預設空間 ''

    expect(outA.decks.map((d: { id: string }) => d.id)).toEqual(['da'])
    expect(outB.decks.map((d: { id: string }) => d.id)).toEqual(['db'])
    expect(outDefault.decks).toHaveLength(0)
  })

  it('pull 回傳的列不含 namespace(內部欄位不外洩)', async () => {
    await pushNs('spaceA', { ...empty, decks: [deck({ id: 'da' })] })
    const outA = await pullNs('spaceA')
    expect(outA.decks[0].namespace).toBeUndefined()
    expect(outA.decks[0].server_seq).toBeUndefined()
  })

  it('同一 namespace 內 LWW 仍正確', async () => {
    await pushNs('spaceA', { ...empty, decks: [deck({ id: 'da', updated_at: 1000, name: 'old' })] })
    await pushNs('spaceA', { ...empty, decks: [deck({ id: 'da', updated_at: 2000, name: 'new' })] })
    await pushNs('spaceA', { ...empty, decks: [deck({ id: 'da', updated_at: 1500, name: 'stale' })] })
    const outA = await pullNs('spaceA')
    expect(outA.decks).toHaveLength(1)
    expect(outA.decks[0].name).toBe('new')
  })
})
