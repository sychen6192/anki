import 'fake-indexeddb/auto'
import { beforeEach, describe, it, expect, vi, afterEach } from 'vitest'
import { db } from '../src/db/db'
import { createDeck } from '../src/db/repo'
import { syncNow } from '../src/lib/sync'

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
      reversed: 0 as const, updated_at: t, deleted: 0 as const, dirty: 1 as const,
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
})
