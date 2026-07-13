import type { Table, UpdateSpec } from 'dexie'
import { db, type Local } from '../db/db'
import type { SyncPush, SyncPullResponse } from '../../shared/types'

export interface SyncResult { ok: boolean; skipped?: boolean; error?: string }

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
      const body: SyncPush = {
        decks: stripDirty(dirtyDecks), notes: stripDirty(dirtyNotes),
        cards: stripDirty(dirtyCards), review_logs: stripDirty(dirtyLogs),
      }
      const res = await fetchFn('/api/sync', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`push failed: ${res.status}`)
      await clearPushedDirty(db.decks, dirtyDecks)
      await clearPushedDirty(db.notes, dirtyNotes)
      await clearPushedDirty(db.cards, dirtyCards)
      for (const log of dirtyLogs) await db.review_logs.update(log.id, { dirty: 0 })
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
