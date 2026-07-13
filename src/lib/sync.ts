import type { Table, UpdateSpec } from 'dexie'
import { db, type Local } from '../db/db'
import type {
  CardRecord, DeckRecord, NoteRecord, ReviewLogRecord, SyncPush, SyncPullResponse,
} from '../../shared/types'

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
  table: Table<Local<T>, string>, pushed: Local<T>[],
): Promise<void> {
  for (const row of pushed) {
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

export async function syncNow(fetchFn: typeof fetch = fetch): Promise<SyncResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, skipped: true }
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
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error(`push failed: ${res.status}`)
        await clearPushedDirty(db.decks, chunk.decks)
        await clearPushedDirty(db.notes, chunk.notes)
        await clearPushedDirty(db.cards, chunk.cards)
        for (const log of chunk.review_logs) await db.review_logs.update(log.id, { dirty: 0 })
      }
    }
    // --- pull ---
    const since = (await db.meta.get('sync_cursor'))?.value ?? 0
    const res = await fetchFn(`/api/sync?since=${since}`)
    if (!res.ok) throw new Error(`pull failed: ${res.status}`)
    const data: SyncPullResponse = await res.json()
    await db.transaction('rw', [db.decks, db.notes, db.cards, db.review_logs, db.meta], async () => {
      await mergeTable(db.decks, data.decks)
      await mergeTable(db.notes, data.notes)
      await mergeTable(db.cards, data.cards)
      for (const log of data.review_logs) {
        if (!(await db.review_logs.get(log.id))) await db.review_logs.put({ ...log, dirty: 0 })
      }
      await db.meta.put({ key: 'sync_cursor', value: data.seq })
      await db.meta.put({ key: 'last_sync_at', value: Date.now() })
    })
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
