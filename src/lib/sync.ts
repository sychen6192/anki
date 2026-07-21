import type { Table, UpdateSpec } from 'dexie'
import { db, type Local } from '../db/db'
import type {
  CardRecord, DeckRecord, NoteRecord, ReviewLogRecord,
  SyncPush, SyncPullResponse, SyncPushResponse,
} from '../../shared/types'
import { getSyncSpace } from './space'

export interface SyncResult { ok: boolean; skipped?: boolean; error?: string }

// Cap each push POST at this many rows so a big first sync (e.g. importing an
// 869-note deck) can't blow past Cloudflare's per-invocation subrequest limit —
// see worker/index.ts for the matching server-side db.batch() chunking.
const PUSH_CHUNK_SIZE = 200

interface PushChunk {
  decks: Local<DeckRecord>[]; notes: Local<NoteRecord>[]
  cards: Local<CardRecord>[]; review_logs: Local<ReviewLogRecord>[]
}

type TaggedRow =
  | { table: 'decks'; row: Local<DeckRecord> }
  | { table: 'notes'; row: Local<NoteRecord> }
  | { table: 'cards'; row: Local<CardRecord> }
  | { table: 'review_logs'; row: Local<ReviewLogRecord> }

function emptyChunk(): PushChunk {
  return { decks: [], notes: [], cards: [], review_logs: [] }
}

// Fills chunks in order decks -> notes -> cards -> review_logs (a chunk may span
// tables); each chunk keeps the original Local<T> rows around (not just the
// stripped-of-dirty wire shape) so the caller can clear dirty flags per-chunk
// after a successful POST.
function buildPushChunks(
  dirtyDecks: Local<DeckRecord>[], dirtyNotes: Local<NoteRecord>[],
  dirtyCards: Local<CardRecord>[], dirtyLogs: Local<ReviewLogRecord>[],
): PushChunk[] {
  const tagged: TaggedRow[] = [
    ...dirtyDecks.map((row) => ({ table: 'decks' as const, row })),
    ...dirtyNotes.map((row) => ({ table: 'notes' as const, row })),
    ...dirtyCards.map((row) => ({ table: 'cards' as const, row })),
    ...dirtyLogs.map((row) => ({ table: 'review_logs' as const, row })),
  ]
  const chunks: PushChunk[] = []
  for (let i = 0; i < tagged.length; i += PUSH_CHUNK_SIZE) {
    const chunk = emptyChunk()
    for (const item of tagged.slice(i, i + PUSH_CHUNK_SIZE)) {
      if (item.table === 'decks') chunk.decks.push(item.row)
      else if (item.table === 'notes') chunk.notes.push(item.row)
      else if (item.table === 'cards') chunk.cards.push(item.row)
      else chunk.review_logs.push(item.row)
    }
    chunks.push(chunk)
  }
  return chunks
}

function stripDirty<T>(rows: Local<T>[]): T[] {
  return rows.map(({ dirty: _d, ...rest }) => rest as unknown as T)
}

async function clearPushedDirty<T extends { id: string; updated_at: number }>(
  table: Table<Local<T>, string>, pushed: Local<T>[], skipped: Set<string>,
): Promise<void> {
  for (const row of pushed) {
    if (skipped.has(row.id)) continue // 伺服器沒存下這列,保留 dirty 等下次再試
    const cur = await table.get(row.id)
    // push 期間又被改過(updated_at 變了)就保留 dirty,下次再推
    if (cur && cur.updated_at === row.updated_at) {
      await table.update(row.id, { dirty: 0 } as unknown as UpdateSpec<Local<T>>)
    }
  }
}

async function mergeTable<T extends { id: string; updated_at: number }>(
  table: Table<Local<T>, string>, incoming: T[],
): Promise<void> {
  for (const row of incoming) {
    const existing = await table.get(row.id)
    if (!existing || row.updated_at > existing.updated_at) {
      await table.put({ ...row, dirty: 0 } as Local<T>)
    }
  }
}

const cardKey = (noteId: string, direction: string) => `${noteId}|${direction}`

/**
 * 合併後的一致性收斂。逐筆 LWW 是各表獨立比對的,不會重新檢查父子關係,
 * 跨裝置離線編輯因此會留下兩種殘骸:
 *
 * 1. A 裝置離線刪了牌組(本機連帶把底下的筆記/卡片下墓碑),B 裝置同時編輯了
 *    底下的筆記。B 的編輯帶著較新的 updated_at,合併時贏過 A 的墓碑 —— 結果是
 *    「已刪除的牌組底下還活著卡片」。StatsPage 只看卡片自己的 deleted,
 *    這些孤兒會永久灌水統計與到期數。
 * 2. 兩台裝置各自離線勾了同一筆的「反向卡」,各自產生一張 uuid 不同的反向卡。
 *    id 不同就不會有 LWW 衝突,兩張都存活,之後每次複習都重複一次。
 *
 * 收斂用新的 updated_at + dirty 寫回,所以修正本身也會經 LWW 傳播出去。
 * 判準在每台裝置上都一樣(重複時保留 id 較小者),因此不會互相打架。
 */
async function reconcile(): Promise<number> {
  const t = Date.now()
  let fixed = 0

  const deletedDecks = new Set((await db.decks.toArray()).filter((d) => d.deleted).map((d) => d.id))
  const deadNotes = new Set<string>()
  for (const note of await db.notes.toArray()) {
    if (note.deleted) { deadNotes.add(note.id); continue }
    if (deletedDecks.has(note.deck_id)) {
      await db.notes.update(note.id, { deleted: 1, updated_at: t, dirty: 1 })
      deadNotes.add(note.id)
      fixed++
    }
  }

  const cards = (await db.cards.toArray()).sort((a, b) => (a.id < b.id ? -1 : 1))
  const live = new Set<string>()
  for (const card of cards) {
    if (card.deleted) continue
    const key = cardKey(card.note_id, card.direction)
    if (deadNotes.has(card.note_id) || live.has(key)) {
      await db.cards.update(card.id, { deleted: 1, updated_at: t, dirty: 1 })
      fixed++
      continue
    }
    live.add(key)
  }
  return fixed
}

export async function syncNow(fetchFn: typeof fetch = fetch): Promise<SyncResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, skipped: true }
  const space = await getSyncSpace()
  try {
    // --- push ---
    const dirtyDecks = await db.decks.where('dirty').equals(1).toArray()
    const dirtyNotes = await db.notes.where('dirty').equals(1).toArray()
    const dirtyCards = await db.cards.where('dirty').equals(1).toArray()
    const dirtyLogs = await db.review_logs.where('dirty').equals(1).toArray()
    if (dirtyDecks.length + dirtyNotes.length + dirtyCards.length + dirtyLogs.length > 0) {
      const chunks = buildPushChunks(dirtyDecks, dirtyNotes, dirtyCards, dirtyLogs)
      // Push chunk-by-chunk; clear each chunk's dirty flags only after its own POST
      // succeeds. If a later chunk's POST fails we stop (throw) — chunks already
      // cleared stay cleared, so the next syncNow resumes with just the remaining
      // dirty rows instead of resending everything from scratch.
      for (const chunk of chunks) {
        const body: SyncPush = {
          decks: stripDirty(chunk.decks), notes: stripDirty(chunk.notes),
          cards: stripDirty(chunk.cards), review_logs: stripDirty(chunk.review_logs),
        }
        const res = await fetchFn('/api/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sync-space': space },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error(`push failed: ${res.status}`)
        const pushRes = await res.json().catch(() => null) as SyncPushResponse | null
        const skipped = new Set(pushRes?.skipped ?? [])
        if (skipped.size > 0) console.warn('伺服器跳過了無法存下的資料列', [...skipped])
        await clearPushedDirty(db.decks, chunk.decks, skipped)
        await clearPushedDirty(db.notes, chunk.notes, skipped)
        await clearPushedDirty(db.cards, chunk.cards, skipped)
        for (const log of chunk.review_logs) {
          if (!skipped.has(log.id)) await db.review_logs.update(log.id, { dirty: 0 })
        }
      }
    }
    // --- pull ---
    const since = (await db.meta.get('sync_cursor'))?.value ?? 0
    const res = await fetchFn(`/api/sync?since=${since}`, { headers: { 'x-sync-space': space } })
    if (!res.ok) throw new Error(`pull failed: ${res.status}`)
    const data: SyncPullResponse = await res.json()
    let switched = false
    await db.transaction('rw', [db.decks, db.notes, db.cards, db.review_logs, db.meta], async () => {
      // 同步進行中若金鑰被切換(換空間會清空本機),放棄把舊空間的 pull 併入新空間。
      // 在交易內讀 sync_space,與 setSyncSpace 的清空/換鑰交易互斥,杜絕競態。
      const cur = await db.meta.get('sync_space')
      if ((typeof cur?.value === 'string' ? cur.value : '') !== space) { switched = true; return }
      await mergeTable(db.decks, data.decks)
      await mergeTable(db.notes, data.notes)
      await mergeTable(db.cards, data.cards)
      for (const log of data.review_logs) {
        if (!(await db.review_logs.get(log.id))) await db.review_logs.put({ ...log, dirty: 0 })
      }
      // 只有真的合併到東西才需要收斂,空的 pull 不必掃全表
      if (data.decks.length + data.notes.length + data.cards.length > 0) await reconcile()
      await db.meta.put({ key: 'sync_cursor', value: data.seq })
      await db.meta.put({ key: 'last_sync_at', value: Date.now() })
    })
    if (switched) return { ok: false, skipped: true }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function setupAutoSync(): void {
  const run = () => { void syncNow() }
  window.addEventListener('online', run)
  run()
}
