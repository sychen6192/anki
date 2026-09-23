import 'fake-indexeddb/auto'
import { beforeEach, describe, it, expect } from 'vitest'
import { db } from '../src/db/db'
import { createDeck, createNote } from '../src/db/repo'
import { describeBackup, exportBackup, importBackup, pruneToBackup } from '../src/lib/backup'
import { syncNow } from '../src/lib/sync'
import { setSyncSpace } from '../src/lib/space'
import { DEFAULT_FSRS_SETTINGS, getFsrsSettings, saveFsrsSettings } from '../src/lib/fsrsSettings'

beforeEach(async () => {
  await db.delete()
  await db.open()
  await setSyncSpace('testkey') // 沒金鑰的話 syncNow 會直接跳過(純本機),下面的還原後同步就驗不到
})

// 極簡假 server:只需 decks 表的 LWW push/pull 語意(與 worker/index.ts 同款規則),
// 足以驗證「還原後同步」能收斂覆蓋雲端既有(甚至較新的)資料,包含墓碑。
function makeFakeDeckServer() {
  const decks = new Map<string, Record<string, unknown>>()
  let seq = 0
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      for (const row of (body.decks ?? []) as Array<Record<string, unknown>>) {
        const ex = decks.get(row.id as string)
        if (!ex || (row.updated_at as number) > (ex.updated_at as number)) {
          decks.set(row.id as string, { ...row, server_seq: ++seq })
        }
      }
      return new Response(JSON.stringify({ ok: true }))
    }
    const since = Number(new URL(url, 'http://x').searchParams.get('since') ?? '0')
    const out = {
      decks: [...decks.values()].filter((r) => (r.server_seq as number) > since)
        .map(({ server_seq: _s, ...rest }) => rest),
      notes: [], cards: [], review_logs: [], seq,
    }
    return new Response(JSON.stringify(out))
  }) as typeof fetch
  return { fetchFn, decks }
}

describe('backup', () => {
  it('匯出→清空→還原 roundtrip,還原後全部 dirty=1 且 cursor 歸零', async () => {
    const deck = await createDeck('A')
    await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: true, accent: '' })
    await db.meta.put({ key: 'sync_cursor', value: 42 })
    const json = await exportBackup()

    await db.delete(); await db.open()
    await importBackup(json)

    expect(await db.decks.count()).toBe(1)
    expect(await db.notes.count()).toBe(1)
    expect(await db.cards.count()).toBe(2)
    for (const c of await db.cards.toArray()) expect(c.dirty).toBe(1)
    expect(await db.meta.get('sync_cursor')).toBeUndefined()
  })

  it('壞掉的備份檔在動到本機資料前就被擋下,並說明哪裡不對', async () => {
    const deck = await createDeck('原本的資料')
    const survived = async () => (await db.decks.get(deck.id))?.name

    await expect(importBackup('這根本不是 json')).rejects.toThrow('不是有效的 JSON')
    await expect(importBackup('null')).rejects.toThrow('格式不正確')
    await expect(importBackup(JSON.stringify({ version: 1, decks: 'nope' }))).rejects.toThrow('decks 不是陣列')
    await expect(importBackup(JSON.stringify({ version: 1, notes: [{ expression: '沒有 id' }] })))
      .rejects.toThrow('notes 裡有缺少 id')
    await expect(importBackup(JSON.stringify({ version: 1, decks: [{ id: 'a', name: 'x' }] })))
      .rejects.toThrow('new_per_day')

    expect(await survived()).toBe('原本的資料') // 全程沒有清空本機
  })

  it('describeBackup:還原前的摘要只算沒刪除的牌組與單字,壞檔丟一樣的錯', async () => {
    const deck = await createDeck('A')
    await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' })
    const gone = await createNote(deck.id, { expression: '猫', reading: 'ねこ', meaning: '貓', reversed: false, accent: '' })
    await db.notes.update(gone.id, { deleted: 1 })
    const trashed = await createDeck('刪掉的')
    await db.decks.update(trashed.id, { deleted: 1 })
    const info = describeBackup(await exportBackup())
    expect(info).toMatchObject({ decks: 1, words: 1, reviews: 0 })
    expect(typeof info.exportedAt).toBe('number')
    expect(() => describeBackup('這根本不是 json')).toThrow('不是有效的 JSON')
    expect(describeBackup(JSON.stringify({ version: 1 })).exportedAt).toBeNull()
  })

  it('pruneToBackup:備份之後才新增的牌組、字、卡片標成刪除(待上傳),備份裡有的不動', async () => {
    const keep = await createDeck('備份時就有')
    await createNote(keep.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' })
    const json = await exportBackup()
    const later = await createDeck('之後才加的')
    await createNote(later.id, { expression: '猫', reading: 'ねこ', meaning: '貓', reversed: false, accent: '' })
    await db.decks.toCollection().modify({ dirty: 0 })

    const pruned = await pruneToBackup(json)
    expect(pruned).toBe(3) // 牌組 + 字 + 卡片
    expect(await db.decks.get(later.id)).toMatchObject({ deleted: 1, dirty: 1 })
    expect(await db.decks.get(keep.id)).toMatchObject({ deleted: 0, dirty: 0 })
    expect((await db.notes.toArray()).filter((n) => !n.deleted).map((n) => n.expression)).toEqual(['犬'])
    expect(await pruneToBackup(json)).toBe(0) // 再跑一次不會重複標
  })

  it('不支援的版本丟錯誤', async () => {
    await expect(importBackup('{"version":99}')).rejects.toThrow('不支援')
  })

  it('restore-wins:還原後 decks/notes/cards 的 updated_at 被蓋成現在時間,嚴格新於備份檔內容', async () => {
    const oldTs = 1000
    const json = JSON.stringify({
      version: 1,
      exported_at: oldTs,
      decks: [{ id: 'd1', name: 'A', new_per_day: 20, updated_at: oldTs, deleted: 0 }],
      notes: [{
        id: 'n1', deck_id: 'd1', expression: '犬', reading: 'いぬ', meaning: '狗',
        reversed: 0, updated_at: oldTs, deleted: 0,
      }],
      cards: [{
        id: 'c1', note_id: 'n1', deck_id: 'd1', direction: 'forward', due: oldTs,
        stability: 1, difficulty: 5, elapsed_days: 0, scheduled_days: 0, learning_steps: 0,
        reps: 0, lapses: 0, state: 0, last_review: null, updated_at: oldTs, deleted: 0,
      }],
      review_logs: [],
    })

    const before = Date.now()
    await importBackup(json)

    const deck = (await db.decks.get('d1'))!
    const note = (await db.notes.get('n1'))!
    const card = (await db.cards.get('c1'))!
    expect(deck.updated_at).toBeGreaterThan(oldTs)
    expect(note.updated_at).toBeGreaterThan(oldTs)
    expect(card.updated_at).toBeGreaterThan(oldTs)
    expect(deck.updated_at).toBeGreaterThanOrEqual(before)
    expect(note.updated_at).toBeGreaterThanOrEqual(before)
    expect(card.updated_at).toBeGreaterThanOrEqual(before)
  })

  it('restore-wins:還原較舊但存活的牌組後同步,能覆蓋雲端較新的墓碑(deleted:1)', async () => {
    const server = makeFakeDeckServer()
    // 雲端已有這個牌組被刪除(墓碑),時間戳比備份新
    server.decks.set('d1', { id: 'd1', name: 'A', new_per_day: 20, updated_at: 5000, deleted: 1, server_seq: 1 })

    // 備份內容是較舊、還活著的牌組(disaster recovery 情境:救回誤刪的資料)
    const json = JSON.stringify({
      version: 1,
      exported_at: 1000,
      decks: [{ id: 'd1', name: 'A', new_per_day: 20, updated_at: 1000, deleted: 0 }],
      notes: [], cards: [], review_logs: [],
    })
    await importBackup(json)

    const r = await syncNow(server.fetchFn)
    expect(r.ok).toBe(true)

    expect(server.decks.get('d1')?.deleted).toBe(0) // 雲端被還原內容覆蓋
    expect((await db.decks.get('d1'))?.deleted).toBe(0) // 本機保持存活
  })

  it('settings 跟著備份走:還原後拿得回 FSRS 設定,而且是 restore-wins 的新時間戳', async () => {
    await saveFsrsSettings({ ...DEFAULT_FSRS_SETTINGS, desired_retention: 0.85 })
    await db.settings.update('fsrs', { updated_at: 1000 })
    const json = await exportBackup()

    await db.delete(); await db.open()
    const before = Date.now()
    await importBackup(json)

    expect((await getFsrsSettings()).desired_retention).toBe(0.85)
    const row = (await db.settings.get('fsrs'))!
    expect(row.dirty).toBe(1)
    expect(row.updated_at).toBeGreaterThanOrEqual(before)
  })

  it('匯入缺 suspended 的舊備份時,card.suspended 補成 0;有值的保留', async () => {
    const card = (over: Record<string, unknown>) => ({
      id: 'c', note_id: 'n1', deck_id: 'd1', direction: 'forward', due: 1, stability: 1, difficulty: 5,
      elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0, last_review: null,
      updated_at: 1000, deleted: 0, ...over,
    })
    await importBackup(JSON.stringify({
      version: 1, exported_at: 1000,
      decks: [{ id: 'd1', name: 'A', new_per_day: 20, updated_at: 1000, deleted: 0 }],
      notes: [], review_logs: [],
      cards: [card({ id: 'old' }), card({ id: 'known', suspended: 2 })],
    }))
    expect((await db.cards.get('old'))!.suspended).toBe(0)
    expect((await db.cards.get('known'))!.suspended).toBe(2)
  })

  it('匯入缺 accent 的舊備份時,note.accent 補成空字串', async () => {
    const json = JSON.stringify({
      version: 1,
      exported_at: 1000,
      decks: [{ id: 'd1', name: 'A', new_per_day: 20, updated_at: 1000, deleted: 0 }],
      notes: [{ id: 'n1', deck_id: 'd1', expression: '犬', reading: 'いぬ', meaning: '狗', reversed: 0, updated_at: 1000, deleted: 0 }], // 無 accent 欄
      cards: [], review_logs: [],
    })
    await importBackup(json)
    expect((await db.notes.get('n1'))!.accent).toBe('')
  })
})
