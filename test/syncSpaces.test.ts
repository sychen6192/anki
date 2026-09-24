import 'fake-indexeddb/auto'
import { beforeEach, describe, it, expect, vi, afterEach } from 'vitest'
import { db } from '../src/db/db'
import { createDeck, createNote } from '../src/db/repo'
import {
  countSpaceDecks, fetchSpaceSummary, KEEPALIVE_BUDGET, MAX_SYNC_WAIT_MS, probeSyncKey, pushBeforeHidden, requestSync, syncNow,
} from '../src/lib/sync'
import {
  adoptSyncSpace, clearLocalData, foldIntoSameNameDecks, leaveSyncSpace, normalizeSyncKey, PENDING_FOLD, readRekeyed,
  rekeyConflicts, resolveRekeyed, setSyncSpace,
} from '../src/lib/space'
import { exportBackup, importBackup, pruneToBackup } from '../src/lib/backup'
import { getFsrsSettings, saveFsrsSettings, DEFAULT_FSRS_SETTINGS } from '../src/lib/fsrsSettings'

type Row = Record<string, any>
const TABLES = ['decks', 'notes', 'cards', 'review_logs', 'settings'] as const
const PARENTS: Record<string, [string, string][]> = {
  notes: [['deck_id', 'decks']],
  cards: [['note_id', 'notes'], ['deck_id', 'decks']],
  review_logs: [['card_id', 'cards']],
}

/**
 * 跟 worker 一樣的伺服器:id 是全部空間共用的主鍵、以 x-sync-space 分空間;
 * id 已經是別的空間的列不寫、回報 conflicts,參照別的空間的列也不寫(skipped)。
 */
function makeSpacesServer() {
  const tables: Record<string, Map<string, Row>> = Object.fromEntries(TABLES.map((t) => [t, new Map()]))
  let seq = 0
  const posts: { space: string; bytes: number; keepalive: boolean; body: Record<string, Row[]> }[] = []
  const sid = (t: string, space: string, id: string) => (t === 'settings' ? `${space}:${id}` : id)
  const fetchFn = (async (input: any, init?: any) => {
    const url = new URL(String(input), 'http://x')
    const space = init?.headers?.['x-sync-space'] ?? ''
    if (url.pathname === '/api/sync/summary') {
      const mine = [...tables.decks.values()].filter((d) => d.ns === space)
      return new Response(JSON.stringify({ decks: mine.filter((d) => !d.deleted).length, ids: mine.map((d) => d.id) }))
    }
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      posts.push({ space, bytes: new TextEncoder().encode(String(init.body)).length, keepalive: init.keepalive === true, body })
      const taken = (t: string, id: unknown) => {
        const ex = tables[t].get(id as string)
        return ex !== undefined && ex.ns !== space
      }
      const skipped: string[] = []
      const conflictSets: Record<string, Set<string>> = {}
      const conflict = (t: string, id: string) => (conflictSets[t] ??= new Set()).add(id)
      for (const t of TABLES) {
        for (const row of body[t] ?? []) {
          if (t !== 'settings') {
            if (taken(t, row.id)) { conflict(t, row.id); skipped.push(row.id); continue }
            const hits = (PARENTS[t] ?? []).filter(([col, p]) => taken(p, row[col]))
            if (hits.length > 0) { for (const [col, p] of hits) conflict(p, row[col]); skipped.push(row.id); continue }
          }
          const key = sid(t, space, row.id)
          const ex = tables[t].get(key)
          const apply = t === 'review_logs' ? !ex : !ex || row.updated_at > ex.updated_at
          if (apply) tables[t].set(key, { ...row, id: key, ns: space, server_seq: ++seq })
        }
      }
      const conflicts = Object.fromEntries(Object.entries(conflictSets).map(([t, ids]) => [t, [...ids]]))
      return new Response(JSON.stringify(Object.keys(conflicts).length ? { ok: true, skipped, conflicts } : { ok: true, skipped }))
    }
    const since = Number(url.searchParams.get('since') ?? '0')
    const out: Row = { seq }
    for (const t of TABLES) {
      out[t] = [...tables[t].values()]
        .filter((r) => r.ns === space && r.server_seq > since)
        .map(({ server_seq: _s, ns: _n, ...rest }) => ({ ...rest, id: t === 'settings' ? rest.id.slice(space.length + 1) : rest.id }))
    }
    return new Response(JSON.stringify(out))
  }) as typeof fetch
  const inSpace = (t: string, space: string) => [...tables[t].values()].filter((r) => r.ns === space)
  const liveNames = (space: string) => inSpace('decks', space).filter((d) => !d.deleted).map((d) => d.name).sort()
  return { fetchFn, tables, posts, inSpace, liveNames }
}

async function addDeckWithWord(name: string, word: string) {
  const deck = await createDeck(name)
  await createNote(deck.id, { expression: word, reading: '', meaning: `${word}的意思`, accent: '', reversed: false })
  return deck
}

/** 模擬一次評分留下的複習紀錄(只要 id 與 card_id 對得上) */
async function addLog(cardId: string) {
  await db.review_logs.add({
    id: crypto.randomUUID(), card_id: cardId, rating: 3, state: 0, due: Date.now(), stability: 1, difficulty: 5,
    elapsed_days: 0, last_elapsed_days: 0, scheduled_days: 1, reviewed_at: Date.now(), dirty: 1,
  })
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

afterEach(() => vi.unstubAllGlobals())

describe('資料來自別的空間:不搬走原本空間的列,換 id 帶過去', () => {
  it('在沒同步的新裝置還原 Z 的備份,再用新金鑰開始同步:Z 原封不動,新空間拿到一份新 id 的副本', async () => {
    const server = makeSpacesServer()
    // 手機:空間 Z,一副牌組、一個字、一筆複習紀錄
    await setSyncSpace('zzzz-zzzz-zzzz')
    const deck = await addDeckWithWord('日文', '犬')
    const card = (await db.cards.where('deck_id').equals(deck.id).first())!
    await addLog(card.id)
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    const backup = await exportBackup()

    // 新裝置:只存這台,還原備份,再開始同步(新金鑰)
    await db.delete(); await db.open()
    await importBackup(backup)
    await adoptSyncSpace('nnnn-nnnn-nnnn')
    const r = await syncNow(server.fetchFn)
    expect(r.ok).toBe(true)

    expect(server.liveNames('zzzz-zzzz-zzzz')).toEqual(['日文'])
    expect(server.inSpace('notes', 'zzzz-zzzz-zzzz')).toHaveLength(1)
    expect(server.inSpace('cards', 'zzzz-zzzz-zzzz').length).toBeGreaterThan(0)
    expect(server.liveNames('nnnn-nnnn-nnnn')).toEqual(['日文'])
    const nDeck = server.inSpace('decks', 'nnnn-nnnn-nnnn')[0]
    expect(nDeck.id).not.toBe(deck.id)
    // 新空間的字、卡片、紀錄都指向新空間裡的列
    const nNotes = server.inSpace('notes', 'nnnn-nnnn-nnnn')
    const nCards = server.inSpace('cards', 'nnnn-nnnn-nnnn')
    const nLogs = server.inSpace('review_logs', 'nnnn-nnnn-nnnn')
    expect(nNotes.map((n) => n.deck_id)).toEqual([nDeck.id])
    expect(nCards.every((c) => c.deck_id === nDeck.id && nNotes.some((n) => n.id === c.note_id))).toBe(true)
    expect(nLogs).toHaveLength(1)
    expect(nCards.some((c) => c.id === nLogs[0].card_id)).toBe(true)
    // 本機也換成新 id,沒有東西卡在 dirty
    expect((await db.decks.toArray()).map((d) => d.id)).toEqual([nDeck.id])
    for (const t of [db.decks, db.notes, db.cards, db.review_logs] as typeof db.decks[]) {
      expect(await t.where('dirty').equals(1).count()).toBe(0)
    }
  })

  it('同步中的裝置(空間 A)還原空間 B 的備份:B 原封不動,A 變成備份的內容', async () => {
    const server = makeSpacesServer()
    await setSyncSpace('bbbb-bbbb-bbbb')
    await addDeckWithWord('B 的牌組', '猫')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    const backupB = await exportBackup()

    await setSyncSpace('aaaa-aaaa-aaaa')
    await addDeckWithWord('A 的牌組', '鳥')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)

    await importBackup(backupB)
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    expect(await pruneToBackup(backupB)).toBeGreaterThan(0) // A 自己的牌組標成刪除
    expect((await syncNow(server.fetchFn)).ok).toBe(true)

    expect(server.liveNames('bbbb-bbbb-bbbb')).toEqual(['B 的牌組'])
    expect(server.liveNames('aaaa-aaaa-aaaa')).toEqual(['B 的牌組'])
    const local = (await db.decks.toArray()).filter((d) => !d.deleted)
    expect(local.map((d) => d.name)).toEqual(['B 的牌組'])
    expect(server.inSpace('decks', 'bbbb-bbbb-bbbb').map((d) => d.id)).not.toContain(local[0].id)
  })

  it('以前停止同步(沒有 LAST_SPACE 紀錄)的裝置改用新金鑰:原本的空間不受影響', async () => {
    const server = makeSpacesServer()
    await setSyncSpace('zzzz-zzzz-zzzz')
    await addDeckWithWord('日文', '犬')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    // 舊版的「停止同步」只把金鑰清掉
    await db.meta.put({ key: 'sync_space', value: '' })
    await addDeckWithWord('停止後加的', '魚') // 這副的 id 從沒進過任何空間
    await adoptSyncSpace('nnnn-nnnn-nnnn')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    expect(server.liveNames('zzzz-zzzz-zzzz')).toEqual(['日文'])
    expect(server.liveNames('nnnn-nnnn-nnnn')).toEqual(['停止後加的', '日文'])
  })

  it('兩台帶著同一批別的空間的資料(同一份備份)合併進同一個空間:換出來的 id 一樣,只有一份', async () => {
    const server = makeSpacesServer()
    await setSyncSpace('zzzz-zzzz-zzzz')
    await addDeckWithWord('日文', '犬')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    const backup = await exportBackup()
    // 第一台:只存這台,還原備份,產生新金鑰 N
    await db.delete(); await db.open()
    await importBackup(backup)
    await adoptSyncSpace('nnnn-nnnn-nnnn')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    // 第二台:同樣還原那份備份,輸入 N 合併
    await db.delete(); await db.open()
    await importBackup(backup)
    await adoptSyncSpace('nnnn-nnnn-nnnn')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    expect(server.inSpace('decks', 'nnnn-nnnn-nnnn').filter((d) => !d.deleted)).toHaveLength(1)
    expect(server.inSpace('notes', 'nnnn-nnnn-nnnn').filter((n) => !n.deleted)).toHaveLength(1)
    expect((await db.decks.toArray()).filter((d) => !d.deleted)).toHaveLength(1)
    expect(server.liveNames('zzzz-zzzz-zzzz')).toEqual(['日文'])
  })

  it('子列的父列在別的空間、這台又沒改過父列:父列也換 id,子列不會一直卡在「還沒同步」', async () => {
    const server = makeSpacesServer()
    await setSyncSpace('xxxx-xxxx-xxxx')
    const deck = await addDeckWithWord('日文', '犬')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    // 舊版 worker 搬走過的狀態:伺服器上這副牌組、字、卡片都在別的空間 Y,這台還以為是自己的(而且是乾淨的)
    for (const t of ['decks', 'notes', 'cards']) for (const r of server.tables[t].values()) r.ns = 'yyyy-yyyy-yyyy'
    // 在這台背一張:卡片與紀錄變 dirty,父列(字、牌組)沒動
    const card = (await db.cards.where('deck_id').equals(deck.id).first())!
    await db.cards.update(card.id, { reps: 1, updated_at: Date.now() + 1000, dirty: 1 })
    await addLog(card.id)
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    for (const t of [db.decks, db.notes, db.cards, db.review_logs] as typeof db.decks[]) {
      expect(await t.where('dirty').equals(1).count()).toBe(0)
    }
    expect(server.liveNames('xxxx-xxxx-xxxx')).toEqual(['日文'])
    expect(server.inSpace('review_logs', 'xxxx-xxxx-xxxx')).toHaveLength(1)
    expect(server.liveNames('yyyy-yyyy-yyyy')).toEqual(['日文'])
  })

  it('回到同一個空間合併時照原 id,不會多出一份', async () => {
    const server = makeSpacesServer()
    await setSyncSpace('zzzz-zzzz-zzzz')
    await addDeckWithWord('日文', '犬')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    const backup = await exportBackup()
    await db.delete(); await db.open()
    await importBackup(backup)
    await adoptSyncSpace('zzzz-zzzz-zzzz')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    expect(server.inSpace('decks', 'zzzz-zzzz-zzzz')).toHaveLength(1)
    expect(server.inSpace('notes', 'zzzz-zzzz-zzzz')).toHaveLength(1)
  })
})

describe('帶著本機設定加入空間:空間裡已經有的優先', () => {
  it('兩台各自帶著設定加入同一個空間,最後都用空間裡先有的那份', async () => {
    const server = makeSpacesServer()
    const key = 'kkkk-kkkk-kkkk'
    // 手機:87%,開始同步
    await saveFsrsSettings({ ...DEFAULT_FSRS_SETTINGS, desired_retention: 0.87 })
    await adoptSyncSpace(key)
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    // 筆電:93%,帶著資料加入
    await db.delete(); await db.open()
    await saveFsrsSettings({ ...DEFAULT_FSRS_SETTINGS, desired_retention: 0.93 })
    await adoptSyncSpace(key)
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    expect((await getFsrsSettings()).desired_retention).toBe(0.87)
    // 之後在筆電改的會傳出去
    await saveFsrsSettings({ ...(await getFsrsSettings()), desired_retention: 0.9 })
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    const stored = [...server.tables.settings.values()].find((s) => s.ns === key)!
    expect(JSON.parse(stored.value).desired_retention).toBe(0.9)
  })
})

describe('同步進行中游標被重設(還原備份、清空重新下載)', () => {
  /** 讓某一次 GET 卡住,直到手動放行 */
  function withHeldPull(server: ReturnType<typeof makeSpacesServer>) {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let held = false
    const fetchFn = (async (input: any, init?: any) => {
      if (init?.method !== 'POST' && !String(input).includes('summary') && !held) {
        held = true
        const res = await server.fetchFn(input, init) // 照游標拿到舊的那份
        await gate
        return res
      }
      return server.fetchFn(input, init)
    }) as typeof fetch
    return { fetchFn, release }
  }

  it('清空這台重新下載時,背景同步晚到的那份不會把游標往前推(不然重新下載只拿到一部分)', async () => {
    const server = makeSpacesServer()
    await setSyncSpace('aaaa-aaaa-aaaa')
    for (const name of ['A', 'B', 'C']) await addDeckWithWord(name, name)
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    await addDeckWithWord('D', 'D')
    const bg = withHeldPull(server)
    const background = syncNow(bg.fetchFn) // 推 D,拉的時候卡住(拿到的是 A、B、C 之後的變更)
    await vi.waitFor(() => { expect(server.posts.length).toBeGreaterThan(1) })
    await clearLocalData()
    bg.release()
    await background
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    expect((await db.decks.toArray()).map((d) => d.name).sort()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('還原備份時,背景同步晚到的那份不會讓「備份之後加的」逃過整理', async () => {
    const server = makeSpacesServer()
    await setSyncSpace('aaaa-aaaa-aaaa')
    await addDeckWithWord('備份裡的', '犬')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    const backup = await exportBackup()
    await addDeckWithWord('備份之後加的', '猫')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    await addDeckWithWord('再之後的', '鳥')
    const bg = withHeldPull(server)
    const background = syncNow(bg.fetchFn)
    await vi.waitFor(() => { expect(server.posts.length).toBeGreaterThan(2) })
    await importBackup(backup)
    const restoreSync = syncNow(server.fetchFn)
    bg.release()
    await background
    expect((await restoreSync).ok).toBe(true)
    await pruneToBackup(backup)
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    expect(server.liveNames('aaaa-aaaa-aaaa')).toEqual(['備份裡的'])
  })
})

describe('切到背景時的補推(keepalive)', () => {
  it('只送放得下的一批(不超過 64KB),送到的清掉 dirty,其餘留給下次同步', async () => {
    const server = makeSpacesServer()
    await setSyncSpace('aaaa-aaaa-aaaa')
    const deck = await addDeckWithWord('日文', '犬')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    const card = (await db.cards.where('deck_id').equals(deck.id).first())!
    for (let i = 0; i < 400; i++) await addLog(card.id)
    await pushBeforeHidden(server.fetchFn)
    const last = server.posts[server.posts.length - 1]
    expect(last.keepalive).toBe(true)
    expect(last.bytes).toBeLessThanOrEqual(KEEPALIVE_BUDGET)
    const left = await db.review_logs.where('dirty').equals(1).count()
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThan(400)
    expect(server.inSpace('review_logs', 'aaaa-aaaa-aaaa')).toHaveLength(400 - left)
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    expect(server.inSpace('review_logs', 'aaaa-aaaa-aaaa')).toHaveLength(400)
  })

  it('同時只送一個;送不出去不記成同步失敗', async () => {
    await setSyncSpace('aaaa-aaaa-aaaa')
    await createDeck('日文')
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const failing = (async () => { calls++; await gate; throw new TypeError('Failed to fetch') }) as typeof fetch
    const first = pushBeforeHidden(failing)
    const second = pushBeforeHidden(failing)
    await vi.waitFor(() => { expect(calls).toBe(1) })
    release()
    await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(await db.meta.get('sync_error')).toBeUndefined()
    expect(await db.decks.where('dirty').equals(1).count()).toBe(1)
  })
})

describe('複習時的延遲同步有上限', () => {
  it('一直延後的話,從第一次要求起最多等 MAX_SYNC_WAIT_MS 就同步', async () => {
    await setSyncSpace('aaaa-aaaa-aaaa')
    await createDeck('A')
    let posts = 0
    const counting = (async (_input: any, init?: any) => {
      if (init?.method === 'POST') posts += 1
      return new Response(JSON.stringify(
        init?.method === 'POST' ? { ok: true, skipped: [] } : { decks: [], notes: [], cards: [], review_logs: [], settings: [], seq: 0 },
      ))
    }) as typeof fetch
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      // 每 10 秒評一張、每次都延 15 秒:沒有上限的話永遠不會同步
      for (let t = 0; t < MAX_SYNC_WAIT_MS + 20_000; t += 10_000) {
        requestSync(15_000, counting)
        await vi.advanceTimersByTimeAsync(10_000)
      }
      // 等最後排的那一次也跑完:切回真的計時器時,沒觸發的假計時器會留下「還在等」的狀態給下一個測試
      await vi.advanceTimersByTimeAsync(MAX_SYNC_WAIT_MS)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => { expect(posts).toBeGreaterThan(0) })
  })
})

describe('等到上限才推的那一次:最近的複習紀錄先留著', () => {
  it('連續評分到 60 秒時推上去,但最後 10 秒內的紀錄留著(剛按錯馬上復原的不會已經傳出去),之後再補推', async () => {
    const server = makeSpacesServer()
    await setSyncSpace('aaaa-aaaa-aaaa')
    const deck = await addDeckWithWord('日文', '犬')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    const card = (await db.cards.where('deck_id').equals(deck.id).first())!
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      // 每 10 秒評一張:0、10、…、50 秒,再 55 秒一張
      for (let t = 0; t <= 50; t += 10) {
        await addLog(card.id)
        requestSync(15_000, server.fetchFn)
        await vi.advanceTimersByTimeAsync(t === 50 ? 5_000 : 10_000)
      }
      await addLog(card.id) // 55 秒
      requestSync(15_000, server.fetchFn)
      // 假計時器下 vi.waitFor 不會輪詢:用 setImmediate(沒有被換掉)讓 IndexedDB 的操作跑完
      const settle = async (done: () => boolean | Promise<boolean>) => {
        for (let i = 0; i < 500 && !(await done()); i++) await new Promise((r) => setImmediate(r))
      }
      const onServer = () => server.inSpace('review_logs', 'aaaa-aaaa-aaaa').length
      await vi.advanceTimersByTimeAsync(5_000) // 60 秒:到上限
      await settle(async () => onServer() > 0 && await db.review_logs.where('dirty').equals(1).count() <= 1)
      expect(onServer()).toBe(6) // 0~50 秒那 6 筆;55 秒那筆留著
      expect(await db.review_logs.where('dirty').equals(1).count()).toBe(1)
      await settle(() => false) // 讓「過一會兒再推」排好
      await vi.advanceTimersByTimeAsync(12_000) // 補推
      await settle(() => onServer() === 7)
      expect(onServer()).toBe(7)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('countSpaceDecks(連上之前先看空間)', () => {
  it('回傳空間裡沒刪除的牌組數;離線或伺服器沒有這個端點時回 null', async () => {
    const server = makeSpacesServer()
    await setSyncSpace('aaaa-aaaa-aaaa')
    await createDeck('一')
    await createDeck('二')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    expect(await countSpaceDecks('aaaa-aaaa-aaaa', server.fetchFn)).toBe(2)
    expect(await countSpaceDecks('typo-typo-typo', server.fetchFn)).toBe(0)
    const old = (async () => new Response('not found', { status: 404 })) as typeof fetch
    expect(await countSpaceDecks('aaaa-aaaa-aaaa', old)).toBeNull()
    vi.stubGlobal('navigator', { onLine: false })
    expect(await countSpaceDecks('aaaa-aaaa-aaaa', server.fetchFn)).toBeNull()
  })

  it('停止同步後再回來:照舊運作', async () => {
    const server = makeSpacesServer()
    await setSyncSpace('aaaa-aaaa-aaaa')
    await createDeck('一')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    await leaveSyncSpace()
    await adoptSyncSpace('aaaa-aaaa-aaaa')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    expect(server.inSpace('decks', 'aaaa-aaaa-aaaa')).toHaveLength(1)
  })
})

describe('舊版自訂的金鑰(大小寫有差、原樣存)', () => {
  it('正規化後像產生器格式、但空間在原樣的金鑰底下:用原樣的', async () => {
    const server = makeSpacesServer()
    await setSyncSpace('JapanN3Z4xjv') // 舊版照原樣存
    await createDeck('日文')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    const { key, standard } = normalizeSyncKey('JapanN3Z4xjv')
    expect(standard).toBe(true)
    expect(key).toBe('japa-nn3z-4xjv')
    expect(await probeSyncKey('JapanN3Z4xjv', key, server.fetchFn)).toEqual({ key: 'JapanN3Z4xjv', decks: 1 })
    // 真的是新格式的金鑰就照正規化的
    await setSyncSpace('abcd-efgh-jkmn')
    await createDeck('新的')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    expect(await probeSyncKey('ABCD EFGH JKMN', 'abcd-efgh-jkmn', server.fetchFn)).toEqual({ key: 'abcd-efgh-jkmn', decks: 1 })
    // 兩邊都是空的:回正規化的(由畫面問「空間是空的」)
    expect(await probeSyncKey('ZZZZ2222XXXX', 'zzzz-2222-xxxx', server.fetchFn)).toEqual({ key: 'zzzz-2222-xxxx', decks: 0 })
    vi.stubGlobal('navigator', { onLine: false })
    expect(await probeSyncKey('JapanN3Z4xjv', key, server.fetchFn)).toBeNull()
  })
})

describe('帶著本機資料合併進空間:同名牌組併成一副', () => {
  const words = (deckId: string, list: string[]) =>
    Promise.all(list.map((w) => createNote(deckId, { expression: w, reading: '', meaning: `${w}的意思`, accent: '', reversed: false })))

  it('這台沒有的字搬過去、兩邊都有的刪掉這台那筆、空掉的牌組刪掉', async () => {
    const remote = await createDeck('大家的日本語')
    await words(remote.id, ['乙', '丙', '丁'])
    const local = await createDeck('大家的日本語')
    await words(local.id, ['甲', '乙', '丙'])
    const other = await createDeck('只有這台有')
    expect(await foldIntoSameNameDecks(new Set([local.id, other.id]))).toBe(1)
    const decks = (await db.decks.toArray()).filter((d) => !d.deleted)
    expect(decks.map((d) => d.id).sort()).toEqual([remote.id, other.id].sort())
    const live = (await db.notes.toArray()).filter((n) => !n.deleted)
    expect(live.filter((n) => n.deck_id === remote.id).map((n) => n.expression).sort()).toEqual(['丁', '丙', '乙', '甲'])
    const liveCards = (await db.cards.toArray()).filter((c) => !c.deleted)
    expect(liveCards.every((c) => live.some((n) => n.id === c.note_id && n.deck_id === c.deck_id))).toBe(true)
    expect(liveCards).toHaveLength(4)
  })

  /** 設定頁「一起帶過去（合併）」:先問空間認得哪些牌組,帶著本機資料加入,同步(成功時併同名牌組) */
  const mergeInto = async (key: string, fetchFn: typeof fetch) => {
    const summary = await fetchSpaceSummary(key, fetchFn)
    await adoptSyncSpace(key, new Set(summary!.ids ?? []))
    return syncNow(fetchFn)
  }
  const startSpace = async (key: string, list: string[], fetchFn: typeof fetch) => {
    const a = await createDeck('範本')
    await words(a.id, list)
    await adoptSyncSpace(key)
    expect((await syncNow(fetchFn)).ok).toBe(true)
    return a
  }

  it('兩台都從同一份範本開始,第二台合併後每個字只有一份', async () => {
    const server = makeSpacesServer()
    const key = 'kkkk-kkkk-kkkk'
    await startSpace(key, ['一', '二', '三'], server.fetchFn)
    // B:同一份範本 → 輸入 A 的金鑰 → 一起帶過去(合併)
    await db.delete(); await db.open()
    const b = await createDeck('範本')
    await words(b.id, ['一', '二', '三', '四'])
    expect(await mergeInto(key, server.fetchFn)).toMatchObject({ ok: true, folded: 1 })
    expect(server.liveNames(key)).toEqual(['範本'])
    const liveNotes = server.inSpace('notes', key).filter((n) => !n.deleted)
    expect(liveNotes.map((n) => n.expression).sort()).toEqual(['一', '三', '二', '四'])
    expect(await db.meta.get(PENDING_FOLD)).toBeUndefined()
  })

  it('兩邊都有的字留進度多的那份:這台背過的、標成已經會了的,合併後照樣在', async () => {
    const server = makeSpacesServer()
    const key = 'pppp-pppp-pppp'
    await startSpace(key, ['一', '二', '三'], server.fetchFn) // A 開了同步但還沒背
    await db.delete(); await db.open()
    const b = await createDeck('範本')
    await words(b.id, ['一', '二', '三'])
    const cardOf = async (w: string) => {
      const n = (await db.notes.where('deck_id').equals(b.id).toArray()).find((x) => x.expression === w)!
      return (await db.cards.where('note_id').equals(n.id).first())!
    }
    const due = Date.now() + 30 * 86_400_000
    await db.cards.update((await cardOf('一')).id, { reps: 12, state: 2, stability: 40, due, last_review: Date.now() })
    await db.cards.update((await cardOf('三')).id, { suspended: 2 })
    expect(await mergeInto(key, server.fetchFn)).toMatchObject({ ok: true, folded: 1 })
    const liveNotes = server.inSpace('notes', key).filter((n) => !n.deleted)
    expect(liveNotes).toHaveLength(3)
    const liveCards = server.inSpace('cards', key).filter((c) => !c.deleted)
    expect(liveCards).toHaveLength(3)
    const cardFor = (w: string) => liveCards.find((c) => c.note_id === liveNotes.find((n) => n.expression === w)!.id)!
    expect(cardFor('一')).toMatchObject({ reps: 12, state: 2, due })
    expect(cardFor('三').suspended).toBe(2)
    expect(cardFor('二').reps).toBe(0)
  })

  it('停止同步後用「一起帶過去」回到同一個空間:空間原本就有的牌組不會被當成這台的併掉', async () => {
    const server = makeSpacesServer()
    const key = 'rrrr-rrrr-rrrr'
    const shared = await startSpace(key, ['一', '二'], server.fetchFn)
    await leaveSyncSpace()
    // 這台離開的期間,另一台在同一個空間多了一副也叫「範本」的,還把共用那副的「一」背了 9 次
    const deckRow = { ...(await db.decks.get(shared.id))!, id: 'other-deck', updated_at: Date.now() }
    const noteOne = (await db.notes.where('deck_id').equals(shared.id).toArray()).find((n) => n.expression === '一')!
    const cardOne = (await db.cards.where('note_id').equals(noteOne.id).first())!
    const otherNote = { ...noteOne, id: 'other-note', deck_id: 'other-deck', updated_at: Date.now() }
    const otherCard = { ...cardOne, id: 'other-card', note_id: 'other-note', deck_id: 'other-deck', updated_at: Date.now() }
    await server.fetchFn('/api/sync', {
      method: 'POST', headers: { 'x-sync-space': key },
      body: JSON.stringify({
        decks: [deckRow], notes: [otherNote], review_logs: [], settings: [],
        cards: [otherCard, { ...cardOne, reps: 9, state: 2, updated_at: Date.now() + 1000 }],
      }),
    })
    const r = await mergeInto(key, server.fetchFn)
    expect(r.ok).toBe(true)
    expect(r.folded).toBeUndefined()
    expect(server.liveNames(key)).toEqual(['範本', '範本'])
    expect(server.tables.cards.get(cardOne.id)).toMatchObject({ reps: 9, deleted: 0 })
    expect(server.inSpace('notes', key).filter((n) => !n.deleted)).toHaveLength(3)
  })

  it('合併當下那次同步失敗:之後第一次成功的同步把同名牌組併掉,不會每個字兩份', async () => {
    const server = makeSpacesServer()
    const key = 'ffff-ffff-ffff'
    await startSpace(key, ['一', '二', '三'], server.fetchFn)
    await db.delete(); await db.open()
    const b = await createDeck('範本')
    await words(b.id, ['一', '二', '三'])
    const summary = await fetchSpaceSummary(key, server.fetchFn)
    await adoptSyncSpace(key, new Set(summary!.ids ?? []))
    const offline = (async () => { throw new TypeError('Failed to fetch') }) as typeof fetch
    expect((await syncNow(offline)).ok).toBe(false)
    expect(await db.meta.get(PENDING_FOLD)).toBeDefined()
    expect(await syncNow(server.fetchFn)).toMatchObject({ ok: true, folded: 1 })
    expect(server.liveNames(key)).toEqual(['範本'])
    expect(server.inSpace('notes', key).filter((n) => !n.deleted)).toHaveLength(3)
    expect(await syncNow(server.fetchFn)).toEqual({ ok: true }) // 只做一次
  })

  it('較舊的那份不蓋掉較新的:幾個月沒用的裝置次數多一點,空間裡昨天剛複習過的排程照樣留著', async () => {
    const remote = await createDeck('N5')
    await words(remote.id, ['一'])
    const local = await createDeck('N5')
    await words(local.id, ['一'])
    const cardIn = async (deckId: string) => (await db.cards.where('deck_id').equals(deckId).first())!
    const day = 86_400_000
    const spaceDue = Date.now() + 20 * day
    await db.cards.update((await cardIn(remote.id)).id, { reps: 5, state: 2, due: spaceDue, last_review: Date.now() - day })
    await db.cards.update((await cardIn(local.id)).id, { reps: 6, lapses: 2, state: 2, due: Date.now() - 70 * day, last_review: Date.now() - 100 * day })
    expect(await foldIntoSameNameDecks(new Set([local.id]))).toBe(1)
    expect(await cardIn(remote.id)).toMatchObject({ reps: 5, due: spaceDue })
  })

  it('同一個方向有刪掉的也有活著的卡:跟活著的那張比,不會多出第二張活的反向卡', async () => {
    const remote = await createDeck('N5')
    const [twin] = await words(remote.id, ['一'])
    // 空間那筆:反向卡關掉過(留著刪掉的那張),後來別台又打開一張、背了 15 次
    const fwd = (await db.cards.where('note_id').equals(twin.id).first())!
    await db.notes.update(twin.id, { reversed: 1 })
    await db.cards.bulkAdd([
      { ...fwd, id: '00000000-dead-4000-8000-000000000000', direction: 'reverse', deleted: 1 },
      { ...fwd, id: 'ffffffff-live-4000-8000-000000000000', direction: 'reverse', reps: 15, state: 2, last_review: Date.now() - 86_400_000 },
    ])
    const local = await createDeck('N5')
    const mine = await createNote(local.id, { expression: '一', reading: '', meaning: '一的意思', accent: '', reversed: true })
    const lrev = (await db.cards.where('note_id').equals(mine.id).toArray()).find((c) => c.direction === 'reverse')!
    await db.cards.update(lrev.id, { reps: 3, state: 2, last_review: Date.now() - 5 * 86_400_000 })
    expect(await foldIntoSameNameDecks(new Set([local.id]))).toBe(1)
    const liveRev = (await db.cards.where('note_id').equals(twin.id).toArray()).filter((c) => c.direction === 'reverse' && !c.deleted)
    expect(liveRev.map((c) => [c.id, c.reps])).toEqual([['ffffffff-live-4000-8000-000000000000', 15]])
  })

  it('這台有兩副同名的牌組、各有一筆拼法相同的字:兩筆都搬過去(第一副搬的不算空間的字)', async () => {
    const remote = await createDeck('N5')
    await words(remote.id, ['一'])
    const l1 = await createDeck('N5')
    await createNote(l1.id, { expression: '四', reading: '', meaning: '第一副的意思', accent: '', reversed: false })
    const l2 = await createDeck('N5')
    await createNote(l2.id, { expression: '四', reading: '', meaning: '第二副的意思', accent: '', reversed: false })
    expect(await foldIntoSameNameDecks(new Set([l1.id, l2.id]))).toBe(2)
    const live = (await db.notes.toArray()).filter((n) => !n.deleted && n.deck_id === remote.id)
    expect(live.map((n) => n.meaning).sort()).toEqual(['一的意思', '第一副的意思', '第二副的意思'].sort())
  })

  it('合併推上去了、還沒拉回來就停止同步,再用同一組金鑰合併:照樣併掉,不會永遠兩副', async () => {
    const server = makeSpacesServer()
    const key = 'llll-llll-llll'
    await startSpace(key, ['一', '二'], server.fetchFn)
    await db.delete(); await db.open()
    const b = await createDeck('範本')
    await words(b.id, ['一', '二'])
    const summary = await fetchSpaceSummary(key, server.fetchFn)
    await adoptSyncSpace(key, new Set(summary!.ids ?? []))
    // 推得上去、拉不下來
    const pushOnly = (async (input: any, init?: any) => {
      if (init?.method === 'POST') return server.fetchFn(input, init)
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    expect((await syncNow(pushOnly)).ok).toBe(false)
    await leaveSyncSpace()
    expect(await mergeInto(key, server.fetchFn)).toMatchObject({ ok: true, folded: 1 })
    expect(server.liveNames(key)).toEqual(['範本'])
  })

  it('併牌組後推上去:刪掉那副牌組的那一筆排在最後(推到一半斷線,別台不會先看到牌組刪掉、字還在底下)', async () => {
    const server = makeSpacesServer()
    const key = 'oooo-oooo-oooo'
    await startSpace(key, ['一'], server.fetchFn)
    await db.delete(); await db.open()
    const b = await createDeck('範本')
    await words(b.id, Array.from({ length: 150 }, (_, i) => `字${i}`)) // 字、卡加起來超過一批(200 筆)
    const before = server.posts.length
    expect(await mergeInto(key, server.fetchFn)).toMatchObject({ ok: true, folded: 1 })
    const after = server.posts.slice(before)
    const withTombstone = after.findIndex((p) => (p.body.decks ?? []).some((d) => d.id === b.id && d.deleted))
    expect(withTombstone).toBe(after.length - 1)
    expect(after.length).toBeGreaterThan(2)
  })

  it('只拿空間的字比:這台自己拼法相同的兩筆(意思不同)一起搬過去,不會刪掉其中一筆', async () => {
    const remote = await createDeck('N5')
    await words(remote.id, ['一'])
    const local = await createDeck('N5')
    await createNote(local.id, { expression: '四', reading: '', meaning: '四的意思', accent: '', reversed: false })
    await createNote(local.id, { expression: '四', reading: '', meaning: '另一個意思', accent: '', reversed: false })
    expect(await foldIntoSameNameDecks(new Set([local.id]))).toBe(1)
    const live = (await db.notes.toArray()).filter((n) => !n.deleted && n.deck_id === remote.id)
    expect(live.map((n) => n.meaning).sort()).toEqual(['一的意思', '另一個意思', '四的意思'].sort())
  })
})

describe('連上之前的確認:照原樣的金鑰', () => {
  it('照原樣的那個沒問到:當成連不上(什麼都不改),不當成空的;放不進 header 的原樣不去問', async () => {
    const flaky = (async (_input: unknown, init?: RequestInit) => {
      const space = (init?.headers as Record<string, string>)['x-sync-space']
      if (space === 'japa-nn3z-4xjv') return new Response(JSON.stringify({ decks: 0, ids: [] }))
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    expect(await probeSyncKey('JapanN3Z4xjv', 'japa-nn3z-4xjv', flaky)).toBeNull()
    let calls = 0
    const empty = (async () => { calls++; return new Response(JSON.stringify({ decks: 0, ids: [] })) }) as typeof fetch
    expect(await probeSyncKey('ａｂｃｄーｅｆｇｈーｊｋｍｎ', 'abcd-efgh-jkmn', empty)).toEqual({ key: 'abcd-efgh-jkmn', decks: 0 })
    expect(calls).toBe(1)
  })

  it('舊版原樣存的金鑰有 header 放得進的非 ASCII 字(例如不斷行空格):照樣去問', async () => {
    const server = makeSpacesServer()
    const legacy = 'HVCR\u00a0be4a\u00a02er2'
    await setSyncSpace(legacy)
    await createDeck('舊的')
    expect((await syncNow(server.fetchFn)).ok).toBe(true)
    const { key } = normalizeSyncKey(legacy)
    expect(key).toBe('hvcr-be4a-2er2')
    expect(await probeSyncKey(legacy, key, server.fetchFn)).toEqual({ key: legacy, decks: 1 })
  })
})

describe('換 id 的紀錄換過不只一次', () => {
  it('舊 → 中間 → 新:一路追到最後的 id,子列也指到最後那個', async () => {
    expect(resolveRekeyed({ a: 'b', b: 'c' }, 'a')).toBe('c')
    expect(resolveRekeyed({ a: 'a' }, 'a')).toBe('a')
    expect(['a', 'b']).toContain(resolveRekeyed({ a: 'b', b: 'a' }, 'a')) // 繞圈也會停
    await setSyncSpace('ssss-ssss-ssss')
    const deck = await addDeckWithWord('日文', '犬')
    await rekeyConflicts({ decks: [deck.id] }, 'ssss-ssss-ssss')
    const mid = (await readRekeyed())[deck.id]
    await rekeyConflicts({ decks: [mid] }, 'ssss-ssss-ssss')
    const map = await readRekeyed()
    const last = map[mid]
    expect(last).not.toBe(mid)
    expect(map[deck.id]).toBe(last)
    expect((await db.decks.get(last))?.name).toBe('日文')
    expect((await db.notes.toArray())[0].deck_id).toBe(last)
  })
})
