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
})
