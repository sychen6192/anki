import 'fake-indexeddb/auto'
import { beforeEach, describe, it, expect, vi, afterEach } from 'vitest'
import { db } from '../src/db/db'
import { createDeck, createNote } from '../src/db/repo'
import { syncNow } from '../src/lib/sync'
import { getSyncSpace, setSyncSpace, clearLocalData } from '../src/lib/space'

type Row = Record<string, any>

// 模擬 server:與 worker 相同的 LWW + seq 語意
function makeServer() {
  const tables: Record<string, Map<string, Row>> = {
    decks: new Map(), notes: new Map(), cards: new Map(), review_logs: new Map(),
  }
  let seq = 0
  const fetchFn = (async (input: any, init?: any) => {
    const url = String(input)
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      for (const t of Object.keys(tables)) {
        for (const row of body[t] ?? []) {
          const ex = tables[t].get(row.id)
          const apply = t === 'review_logs' ? !ex : !ex || row.updated_at > ex.updated_at
          if (apply) tables[t].set(row.id, { ...row, server_seq: ++seq })
        }
      }
      return new Response(JSON.stringify({ ok: true }))
    }
    const since = Number(new URL(url, 'http://x').searchParams.get('since') ?? '0')
    const out: Row = { seq }
    for (const t of Object.keys(tables)) {
      out[t] = [...tables[t].values()]
        .filter((r) => r.server_seq > since)
        .map(({ server_seq, ...rest }) => rest)
    }
    return new Response(JSON.stringify(out))
  }) as typeof fetch
  return { fetchFn, tables, currentSeq: () => seq, inject(t: string, row: Row) { tables[t].set(row.id, { ...row, server_seq: ++seq }) } }
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

afterEach(() => vi.unstubAllGlobals())

describe('syncNow', () => {
  it('push:dirty 記錄上傳並清旗標', async () => {
    const server = makeServer()
    const deck = await createDeck('A')
    const r = await syncNow(server.fetchFn)
    expect(r.ok).toBe(true)
    expect(server.tables.decks.get(deck.id)?.name).toBe('A')
    expect((await db.decks.get(deck.id))!.dirty).toBe(0)
    expect((await db.meta.get('sync_cursor'))!.value).toBe(server.currentSeq())
  })

  it('pull:遠端較新的記錄合併進本地且 dirty=0', async () => {
    const server = makeServer()
    const deck = await createDeck('A')
    await syncNow(server.fetchFn)
    // 模擬另一台裝置改了名字(較新的 updated_at)
    server.inject('decks', { id: deck.id, name: 'B', new_per_day: 20, updated_at: Date.now() + 60_000, deleted: 0 })
    await syncNow(server.fetchFn)
    const row = (await db.decks.get(deck.id))!
    expect(row.name).toBe('B')
    expect(row.dirty).toBe(0)
  })

  it('pull:本地較新時不被遠端舊資料蓋掉', async () => {
    const server = makeServer()
    const deck = await createDeck('A')
    server.inject('decks', { id: deck.id, name: 'OLD', new_per_day: 20, updated_at: 1, deleted: 0 })
    await syncNow(server.fetchFn)
    expect((await db.decks.get(deck.id))!.name).toBe('A')
  })

  it('離線時跳過', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const r = await syncNow(makeServer().fetchFn)
    expect(r.skipped).toBe(true)
  })

  it('server 錯誤時回報 error 且 dirty 保留', async () => {
    const failFetch = (async () => new Response('boom', { status: 500 })) as typeof fetch
    const deck = await createDeck('A')
    const r = await syncNow(failFetch)
    expect(r.ok).toBe(false)
    expect((await db.decks.get(deck.id))!.dirty).toBe(1)
  })

  it('分批 push:某批送出後失敗,已成功批次維持 dirty=0,之後只補送剩餘髒資料', async () => {
    const deck = await createDeck('A')
    await db.decks.update(deck.id, { dirty: 0 }) // 這筆已同步過,不參與本測試的分批筆數
    const t = Date.now()
    const notes = Array.from({ length: 250 }, (_, i) => ({
      id: crypto.randomUUID(), deck_id: deck.id, expression: `w${i}`, reading: '', meaning: `m${i}`,
      accent: '', reversed: 0 as const, updated_at: t, deleted: 0 as const, dirty: 1 as const,
    }))
    await db.notes.bulkAdd(notes)

    let postCount = 0
    const flakyFetch = (async (input: any, init?: any) => {
      if (init?.method === 'POST') {
        postCount += 1
        // 第 2 個 chunk(理應是剩下的 50 筆)故意失敗
        if (postCount === 2) return new Response('boom', { status: 500 })
        return new Response(JSON.stringify({ ok: true }))
      }
      return new Response(JSON.stringify({ decks: [], notes: [], cards: [], review_logs: [], seq: 0 }))
    }) as typeof fetch

    const r = await syncNow(flakyFetch)
    expect(r.ok).toBe(false)
    expect(postCount).toBe(2)
    // 200 筆(第 1 批)已清 dirty,50 筆(第 2 批,失敗)仍是 dirty
    expect(await db.notes.where('dirty').equals(0).count()).toBe(200)
    expect(await db.notes.where('dirty').equals(1).count()).toBe(50)

    // 之後用健康的 server 補跑一次:應只推剩下的 50 筆,不是全部 250 筆
    const server = makeServer()
    const r2 = await syncNow(server.fetchFn)
    expect(r2.ok).toBe(true)
    expect(await db.notes.where('dirty').equals(1).count()).toBe(0)
    expect(server.tables.notes.size).toBe(50)
  })

  it('跨表分批:150 筆 dirty notes + 100 筆 dirty cards(共 250,超過單批 200)→ 第一批依 decks→notes→cards 順序填滿並橫跨 notes/cards 邊界,全部送達且成功後清 dirty', async () => {
    const server = makeServer()
    const deck = await createDeck('A')
    await db.decks.update(deck.id, { dirty: 0 }) // 這筆已同步過,不參與本測試的分批筆數
    const t = Date.now()
    const notes = Array.from({ length: 150 }, (_, i) => ({
      id: crypto.randomUUID(), deck_id: deck.id, expression: `w${i}`, reading: '', meaning: `m${i}`,
      accent: '', reversed: 0 as const, updated_at: t, deleted: 0 as const, dirty: 1 as const,
    }))
    await db.notes.bulkAdd(notes)
    const cards = Array.from({ length: 100 }, (_, i) => ({
      id: crypto.randomUUID(), note_id: notes[i % notes.length].id, deck_id: deck.id,
      direction: 'forward' as const, due: t, stability: 1, difficulty: 5,
      elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0,
      last_review: null, updated_at: t, deleted: 0 as const, dirty: 1 as const,
    }))
    await db.cards.bulkAdd(cards)

    const bodies: Row[] = []
    const capturingFetch = (async (input: any, init?: any) => {
      if (init?.method === 'POST') bodies.push(JSON.parse(String(init.body)))
      return server.fetchFn(input, init)
    }) as typeof fetch

    const r = await syncNow(capturingFetch)
    expect(r.ok).toBe(true)
    expect(bodies).toHaveLength(2)
    // 第一批 200 筆額度:150 筆 notes 全部填入,剩 50 筆額度從 cards 補上(邊界橫跨兩表)
    expect(bodies[0].notes).toHaveLength(150)
    expect(bodies[0].cards).toHaveLength(50)
    expect(bodies[1].notes).toHaveLength(0)
    expect(bodies[1].cards).toHaveLength(50)

    expect(server.tables.notes.size).toBe(150)
    expect(server.tables.cards.size).toBe(100)
    expect(await db.notes.where('dirty').equals(1).count()).toBe(0)
    expect(await db.cards.where('dirty').equals(1).count()).toBe(0)
  })
})

describe('sync namespace / space', () => {
  it('syncNow 會在 push 與 pull 都帶上 x-sync-space header', async () => {
    await setSyncSpace('space1')
    await createDeck('要推送的牌組') // 造一筆 dirty 資料,強制 push

    const seen: { url: string; space: string | null }[] = []
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({ url: String(input), space: headers.get('x-sync-space') })
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true }))
      return new Response(JSON.stringify({ decks: [], notes: [], cards: [], review_logs: [], seq: 0 }))
    }) as unknown as typeof fetch

    const r = await syncNow(fetchFn)
    expect(r.ok).toBe(true)
    const post = seen.find((s) => s.url === '/api/sync')
    const get = seen.find((s) => s.url.startsWith('/api/sync?since='))
    expect(post?.space).toBe('space1')
    expect(get?.space).toBe('space1')
  })

  it('setSyncSpace 換金鑰:清空本機四表、重置游標、寫入新金鑰(trim)', async () => {
    const deck = await createDeck('A')
    await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' })
    await db.meta.put({ key: 'sync_cursor', value: 42 })
    await setSyncSpace('  mykey  ')
    expect(await getSyncSpace()).toBe('mykey') // 有 trim
    expect(await db.decks.count()).toBe(0)
    expect(await db.notes.count()).toBe(0)
    expect(await db.cards.count()).toBe(0)
    expect(await db.meta.get('sync_cursor')).toBeUndefined()
  })

  it('setSyncSpace 同金鑰:no-op,不動本機資料', async () => {
    await setSyncSpace('same')
    await createDeck('A')
    await setSyncSpace('same') // 與目前相同
    expect(await db.decks.count()).toBe(1)
  })

  it('clearLocalData 清空四表與游標,但保留金鑰', async () => {
    await setSyncSpace('keepme')
    const deck = await createDeck('A')
    await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' })
    await db.meta.put({ key: 'sync_cursor', value: 7 })

    await clearLocalData()

    expect(await db.decks.count()).toBe(0)
    expect(await db.notes.count()).toBe(0)
    expect(await db.cards.count()).toBe(0)
    expect(await db.review_logs.count()).toBe(0)
    expect(await db.meta.get('sync_cursor')).toBeUndefined()
    expect(await getSyncSpace()).toBe('keepme')
  })

  it('同步中途換金鑰:不把舊空間的 pull 併入新空間', async () => {
    await setSyncSpace('old')
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true }))
      // 模擬 pull 進行中金鑰被切換到 'new'(會清空本機並改 key)
      await setSyncSpace('new')
      return new Response(JSON.stringify({
        decks: [{ id: 'x', name: '舊空間', new_per_day: 20, updated_at: 1000, deleted: 0 }],
        notes: [], cards: [], review_logs: [], seq: 5,
      }))
    }) as unknown as typeof fetch

    await syncNow(fetchFn)
    expect(await db.decks.get('x')).toBeUndefined() // 舊空間資料未被併入 new 空間
  })
})
