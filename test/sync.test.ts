import 'fake-indexeddb/auto'
import { beforeEach, describe, it, expect, vi, afterEach } from 'vitest'
import { db } from '../src/db/db'
import { createDeck, createNote, softDeleteDeck } from '../src/db/repo'
import { requestSync, syncNow } from '../src/lib/sync'
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

  it('伺服器回報存不下的列時,那些列保留 dirty,同批其餘照常清掉,而且不影響 pull', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' })
    let pulled = false
    const fussyFetch = (async (input: any, init?: any) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, skipped: [note.id] }))
      }
      pulled = true
      return new Response(JSON.stringify({ decks: [], notes: [], cards: [], review_logs: [], seq: 7 }))
    }) as typeof fetch

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await syncNow(fussyFetch)
    const warned = warn.mock.calls.length
    warn.mockRestore()

    expect(r.ok).toBe(true)
    expect(warned).toBe(1) // 有留下線索,不是靜默吞掉
    expect(pulled).toBe(true) // 壞資料不會讓同步卡在 push 階段
    expect((await db.notes.get(note.id))!.dirty).toBe(1)
    expect((await db.decks.get(deck.id))!.dirty).toBe(0)
    expect((await db.meta.get('sync_cursor'))!.value).toBe(7)
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

describe('合併後的一致性收斂', () => {
  const fsrsFields = (t: number) => ({
    due: t, stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0,
    learning_steps: 0, reps: 0, lapses: 0, state: 0, last_review: null,
  })

  it('已刪除的牌組底下被另一台裝置改活的筆記與卡片,合併後重新下墓碑', async () => {
    const server = makeServer()
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' })
    const card = (await db.cards.where('note_id').equals(note.id).toArray())[0]
    await syncNow(server.fetchFn)

    // 本機刪掉整個牌組(連帶把筆記與卡片下墓碑)
    await softDeleteDeck(deck.id)
    // 另一台裝置不知道牌組被刪了,同時改了這筆筆記 —— 較新的 updated_at 會贏過墓碑
    const later = Date.now() + 60_000
    server.inject('notes', {
      id: note.id, deck_id: deck.id, expression: '犬', reading: 'いぬ', meaning: '狗狗',
      accent: '', reversed: 0, updated_at: later, deleted: 0,
    })
    server.inject('cards', {
      id: card.id, note_id: note.id, deck_id: deck.id, direction: 'forward',
      ...fsrsFields(later), updated_at: later, deleted: 0,
    })

    await syncNow(server.fetchFn)

    const merged = (await db.notes.get(note.id))!
    expect(merged.meaning).toBe('狗狗') // LWW 確實把較新的內容併進來了
    expect(merged.deleted).toBe(1)      // 但父牌組已刪,收斂後重新下墓碑
    expect(merged.dirty).toBe(1)        // 標 dirty,讓修正也傳回其他裝置
    const mergedCard = (await db.cards.get(card.id))!
    expect(mergedCard.deleted).toBe(1)
    expect(mergedCard.dirty).toBe(1)
  })

  it('兩台裝置各自產生的重複反向卡,只留 id 較小的一張', async () => {
    const server = makeServer()
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '猫', reading: 'ねこ', meaning: '貓', reversed: true, accent: '' })
    await syncNow(server.fetchFn)
    const mine = (await db.cards.where('note_id').equals(note.id).toArray()).find((c) => c.direction === 'reverse')!

    // 另一台裝置離線時也勾了反向卡,產生另一張 uuid 不同的卡
    const dupId = 'zzzzzzzz-dup'
    server.inject('cards', {
      id: dupId, note_id: note.id, deck_id: deck.id, direction: 'reverse',
      ...fsrsFields(Date.now()), updated_at: Date.now() + 60_000, deleted: 0,
    })

    await syncNow(server.fetchFn)

    const reverse = (await db.cards.where('note_id').equals(note.id).toArray()).filter((c) => c.direction === 'reverse')
    expect(reverse).toHaveLength(2) // 兩張都還在(墓碑不物理刪除)
    const live = reverse.filter((c) => !c.deleted)
    expect(live).toHaveLength(1)
    expect(live[0].id).toBe([mine.id, dupId].sort()[0])
    expect(reverse.find((c) => c.deleted)!.dirty).toBe(1)
  })

  it('沒有東西可合併時不動任何資料,也不會製造 dirty', async () => {
    const server = makeServer()
    const deck = await createDeck('A')
    await createNote(deck.id, { expression: '本', reading: 'ほん', meaning: '書', reversed: true, accent: '' })
    await syncNow(server.fetchFn)
    expect(await db.cards.where('dirty').equals(1).count()).toBe(0)

    await syncNow(server.fetchFn) // 第二次:server 沒有新東西
    expect(await db.cards.where('dirty').equals(1).count()).toBe(0)
    expect(await db.notes.where('dirty').equals(1).count()).toBe(0)
    expect(await db.cards.filter((c) => c.deleted === 1).count()).toBe(0)
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

describe('首次啟動閘門與同步錯誤旗標', () => {
  it('全新安裝(沒選過金鑰、本機無資料)不自動同步,避免拉進公用空間資料', async () => {
    const server = makeServer()
    server.inject('decks', { id: 'd1', name: '別人的牌組', new_per_day: 20, updated_at: 1000, deleted: 0 })
    const r = await syncNow(server.fetchFn)
    expect(r.ok).toBe(false)
    expect(r.skipped).toBe(true)
    expect(r.reason).toBe('first-run')
    expect(await db.decks.count()).toBe(0) // 沒把公用空間的資料拉下來
  })

  it('選過金鑰(即使是空白=公用空間)之後照常同步', async () => {
    const server = makeServer()
    server.inject('decks', { id: 'd1', name: '公用牌組', new_per_day: 20, updated_at: 1000, deleted: 0 })
    await setSyncSpace('')
    const r = await syncNow(server.fetchFn)
    expect(r.ok).toBe(true)
    expect(await db.decks.count()).toBe(1)
  })

  it('沒選過金鑰但本機已有資料(舊版升級上來)照常同步', async () => {
    const server = makeServer()
    await createDeck('既有資料')
    const r = await syncNow(server.fetchFn)
    expect(r.ok).toBe(true)
    expect(server.tables.decks.size).toBe(1)
  })

  it('同步失敗寫入 sync_error meta,下次成功後清掉', async () => {
    await setSyncSpace('')
    const failFetch = (async () => new Response('boom', { status: 500 })) as typeof fetch
    await createDeck('A')
    const r = await syncNow(failFetch)
    expect(r.ok).toBe(false)
    const err = await db.meta.get('sync_error')
    expect(typeof err?.value).toBe('string')
    expect(String(err!.value)).toContain('500')

    const r2 = await syncNow(makeServer().fetchFn)
    expect(r2.ok).toBe(true)
    expect(await db.meta.get('sync_error')).toBeUndefined()
  })

  it('離線跳過不算失敗,不寫 sync_error', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const r = await syncNow(makeServer().fetchFn)
    expect(r.skipped).toBe(true)
    expect(await db.meta.get('sync_error')).toBeUndefined()
  })
})

describe('requestSync(資料異動後的延遲同步)', () => {
  it('debounce:短時間多次呼叫只同步一次', async () => {
    // Dexie/fake-indexeddb 內部靠 setImmediate 排程,全部 fake 會讓資料庫操作卡死,
    // 所以先在真實計時器下備妥資料,只 fake setTimeout/clearTimeout 來驗 debounce
    await setSyncSpace('')
    await createDeck('A')
    let posts = 0
    const countingFetch = (async (_input: any, init?: any) => {
      if (init?.method === 'POST') posts += 1
      return new Response(JSON.stringify(
        init?.method === 'POST' ? { ok: true } : { decks: [], notes: [], cards: [], review_logs: [], seq: 0 },
      ))
    }) as typeof fetch

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      requestSync(1000, countingFetch)
      requestSync(1000, countingFetch)
      requestSync(1000, countingFetch)
      await vi.advanceTimersByTimeAsync(1500) // 只觸發最後一個 pending timer
    } finally {
      vi.useRealTimers()
    }
    // syncNow 是 fire-and-forget,回到真實計時器後等它跑完
    await vi.waitFor(() => { expect(posts).toBeGreaterThan(0) })
    await new Promise((r) => setTimeout(r, 50)) // 若 debounce 失效,其餘兩次會在這期間冒出來
    expect(posts).toBe(1)
  })
})
