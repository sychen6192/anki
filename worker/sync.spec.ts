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

describe('/api/sync push 的輸入驗證', () => {
  const pushRaw = (body: string) => app.request('/api/sync', {
    method: 'POST', body, headers: { 'content-type': 'application/json' },
  }, env)

  it('無法 bind 的壞資料被跳過並回報,同批的好資料照常寫入', async () => {
    const res = await pushRaw(JSON.stringify({
      ...empty,
      decks: [deck({ id: 'good' }), deck({ id: 'bad', name: { nested: 'object' } })],
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, skipped: ['bad'] })

    const out = await pull(0)
    expect(out.decks.map((d: { id: string }) => d.id)).toEqual(['good'])
  })

  it('缺 id 或 updated_at 不是數字的列被跳過', async () => {
    const res = await pushRaw(JSON.stringify({
      ...empty,
      decks: [deck({ id: undefined }), deck({ id: 'x', updated_at: 'not-a-number' })],
    }))
    expect(await res.json()).toEqual({ ok: true, skipped: ['', 'x'] })
    expect((await pull(0)).decks).toHaveLength(0)
  })

  it('body 不是 JSON 或欄位不是陣列時回 400,而不是丟出未處理的例外', async () => {
    expect((await pushRaw('not json at all')).status).toBe(400)
    expect((await pushRaw(JSON.stringify({ ...empty, decks: 'nope' }))).status).toBe(400)
  })
})

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

  it('card 的 suspended 會 round-trip;缺 suspended 的舊 push 補成 0', async () => {
    const card = (over: Record<string, unknown>) => ({
      id: 'c', note_id: 'n1', deck_id: 'd1', direction: 'forward', due: 1, stability: 1, difficulty: 5,
      elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0, last_review: null,
      updated_at: 1000, deleted: 0, ...over,
    })
    await push({ ...empty, cards: [card({ id: 'c1', suspended: 2 }), card({ id: 'c2' })] })
    const out = await pull(0)
    const byId = Object.fromEntries(out.cards.map((c: { id: string }) => [c.id, c]))
    expect(byId.c1.suspended).toBe(2)
    expect(byId.c2.suspended).toBe(0)
  })

  // 帶 x-sync-space header 的 push/pull
  async function pushNs(space: string, body: unknown): Promise<any> {
    const res = await app.request('/api/sync', {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-sync-space': space },
    }, env)
    expect(res.status).toBe(200)
    return res.json()
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

  it('settings 表:LWW round-trip、namespace 隔離、舊 client 沒送 settings 也沒事', async () => {
    const setting = (over: Record<string, unknown> = {}) =>
      ({ id: 'fsrs', value: '{"w":null}', updated_at: 1000, deleted: 0, ...over })
    await pushNs('spaceA', { ...empty, settings: [setting()] })
    await pushNs('spaceA', { ...empty, settings: [setting({ value: '{"w":[1]}', updated_at: 2000 })] })
    await pushNs('spaceA', { ...empty, settings: [setting({ value: 'stale', updated_at: 1500 })] })
    const outA = await pullNs('spaceA')
    expect(outA.settings).toHaveLength(1)
    expect(outA.settings[0]).toMatchObject({ id: 'fsrs', value: '{"w":[1]}' })
    expect(outA.settings[0].namespace).toBeUndefined()
    expect((await pullNs('spaceB')).settings).toHaveLength(0)
    await pushNs('spaceA', empty) // 舊 client 的 body 沒有 settings 這個 key
    expect((await pullNs('spaceA')).settings).toHaveLength(1)
  })

  it('settings:兩個空間各有自己的 fsrs 設定,不會互相搶走(設定的 id 是固定名稱,不是 UUID)', async () => {
    const setting = (value: string, updated_at: number) => ({ id: 'fsrs', value, updated_at, deleted: 0 })
    await pushNs('spaceA', { ...empty, settings: [setting('A 的參數', 1000)] })
    await pushNs('spaceB', { ...empty, settings: [setting('B 的參數', 2000)] }) // B 比較新
    const a = (await pullNs('spaceA')).settings
    const b = (await pullNs('spaceB')).settings
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ id: 'fsrs', value: 'A 的參數' })
    expect(b[0]).toMatchObject({ id: 'fsrs', value: 'B 的參數' })
    // A 之後再改:照樣存得進去(以前會因為 B 的時間比較新而被擋掉)
    await pushNs('spaceA', { ...empty, settings: [setting('A 改過', 1500)] })
    expect((await pullNs('spaceA')).settings[0].value).toBe('A 改過')
  })

  it('settings:以前存的沒前綴的列照樣拉得到', async () => {
    await env.DB.prepare(`INSERT INTO settings (id, value, updated_at, deleted, namespace, server_seq)
      VALUES ('fsrs', '舊的', 500, 0, 'legacy', 1)`).run()
    const out = (await pullNs('legacy')).settings
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'fsrs', value: '舊的' })
  })

  it('push 忽略 client 送的 namespace,一律以 header 為準', async () => {
    await pushNs('real', { ...empty, decks: [deck({ id: 'dx', namespace: 'spoofed' })] })
    expect((await pullNs('real')).decks.map((d: { id: string }) => d.id)).toEqual(['dx'])
    expect((await pullNs('spoofed')).decks).toHaveLength(0)
  })

  // id 是全表共用的主鍵。以前同一個 id 以較新時間戳推進另一個空間,會把那一列從原本的空間搬走
  // (例如在另一台還原了這個空間的備份,再用新的金鑰開始同步)。現在不搬、回報給客戶端換新 id。
  it('id 已經是別的空間的:不搬走,回報 conflicts,原本的空間原封不動', async () => {
    await pushNs('A', { ...empty, decks: [deck({ id: 'shared', updated_at: 1000, name: 'A 的' })] })
    const res = await pushNs('B', { ...empty, decks: [deck({ id: 'shared', updated_at: 2000, name: 'B 的' })] })
    expect(res).toEqual({ ok: true, skipped: ['shared'], conflicts: { decks: ['shared'] } })
    const a = (await pullNs('A')).decks
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ id: 'shared', name: 'A 的', updated_at: 1000 })
    expect((await pullNs('B')).decks).toHaveLength(0)
  })

  it('參照了別的空間的列(牌組/字/卡片)也不存,同一次推送的其他列照常寫入', async () => {
    const note = (over: Record<string, unknown>) => ({
      id: 'n', deck_id: 'd', expression: '犬', reading: 'いぬ', meaning: '狗', accent: '', reversed: 0,
      updated_at: 1000, deleted: 0, ...over,
    })
    const card = (over: Record<string, unknown>) => ({
      id: 'c', note_id: 'n', deck_id: 'd', direction: 'forward', due: 1, stability: 1, difficulty: 5,
      elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0, last_review: null,
      suspended: 0, updated_at: 1000, deleted: 0, ...over,
    })
    const log = (over: Record<string, unknown>) => ({
      id: 'l', card_id: 'c', rating: 3, state: 0, due: 1, stability: 1, difficulty: 5,
      elapsed_days: 0, last_elapsed_days: 0, scheduled_days: 1, reviewed_at: 999, ...over,
    })
    await pushNs('A', {
      decks: [deck({ id: 'dA' })], notes: [note({ id: 'nA', deck_id: 'dA' })],
      cards: [card({ id: 'cA', note_id: 'nA', deck_id: 'dA' })], review_logs: [log({ id: 'lA', card_id: 'cA' })],
    })
    const res = await pushNs('B', {
      decks: [deck({ id: 'dA', updated_at: 5000 }), deck({ id: 'dB' })],
      notes: [note({ id: 'nNew', deck_id: 'dA' }), note({ id: 'nB', deck_id: 'dB' })],
      cards: [card({ id: 'cNew', note_id: 'nA', deck_id: 'dB' }), card({ id: 'cB', note_id: 'nB', deck_id: 'dB' })],
      review_logs: [log({ id: 'lNew', card_id: 'cA' }), log({ id: 'lA', card_id: 'cB' })],
    })
    expect(res.conflicts).toEqual({ decks: ['dA'], review_logs: ['lA'] })
    expect([...res.skipped].sort()).toEqual(['cNew', 'dA', 'lA', 'lNew', 'nNew'])
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort()
    const b = await pullNs('B')
    expect(ids(b.decks)).toEqual(['dB'])
    expect(ids(b.notes)).toEqual(['nB'])
    expect(ids(b.cards)).toEqual(['cB'])
    expect(b.review_logs).toHaveLength(0)
    const a = await pullNs('A')
    expect(a.decks[0]).toMatchObject({ id: 'dA', updated_at: 1000 })
    expect(ids(a.notes)).toEqual(['nA'])
    expect(ids(a.cards)).toEqual(['cA'])
    expect(a.review_logs.map((l: { id: string; card_id: string }) => [l.id, l.card_id])).toEqual([['lA', 'cA']])
  })

  it('summary:空間裡沒刪除的牌組數,別的空間與刪除的不算', async () => {
    const summary = async (space: string) =>
      (await app.request('/api/sync/summary', { headers: { 'x-sync-space': space } }, env)).json()
    expect(await summary('A')).toEqual({ decks: 0 })
    await pushNs('A', { ...empty, decks: [deck({ id: 'a1' }), deck({ id: 'a2' }), deck({ id: 'a3', deleted: 1 })] })
    await pushNs('B', { ...empty, decks: [deck({ id: 'b1' })] })
    expect(await summary('A')).toEqual({ decks: 2 })
    expect(await summary('B')).toEqual({ decks: 1 })
    expect(await summary('C')).toEqual({ decks: 0 })
  })

  it('同一個空間裡重推自己的列不算衝突', async () => {
    await pushNs('A', { ...empty, decks: [deck({ id: 'mine', updated_at: 1000 })] })
    const res = await pushNs('A', { ...empty, decks: [deck({ id: 'mine', updated_at: 2000, name: '改過' })] })
    expect(res).toEqual({ ok: true, skipped: [] })
    expect((await pullNs('A')).decks[0].name).toBe('改過')
  })
})
