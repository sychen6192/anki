import { db } from '../db/db'

function stripDirty<T extends { dirty: 0 | 1 }>(rows: T[]): Omit<T, 'dirty'>[] {
  return rows.map(({ dirty: _d, ...rest }) => rest)
}

export async function exportBackup(): Promise<string> {
  return JSON.stringify({
    version: 1,
    exported_at: Date.now(),
    decks: stripDirty(await db.decks.toArray()),
    notes: stripDirty(await db.notes.toArray()),
    cards: stripDirty(await db.cards.toArray()),
    review_logs: stripDirty(await db.review_logs.toArray()),
  })
}

export async function importBackup(json: string): Promise<void> {
  const data = JSON.parse(json)
  if (data.version !== 1) throw new Error('不支援的備份版本')
  const withDirty = (r: object) => ({ ...r, dirty: 1 as const })
  await db.transaction('rw', [db.decks, db.notes, db.cards, db.review_logs, db.meta], async () => {
    await db.decks.clear(); await db.decks.bulkAdd((data.decks ?? []).map(withDirty))
    await db.notes.clear(); await db.notes.bulkAdd((data.notes ?? []).map(withDirty))
    await db.cards.clear(); await db.cards.bulkAdd((data.cards ?? []).map(withDirty))
    await db.review_logs.clear(); await db.review_logs.bulkAdd((data.review_logs ?? []).map(withDirty))
    await db.meta.delete('sync_cursor') // 下次同步全量重拉,LWW 會收斂
  })
}
