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
  const now = Date.now()
  // Restore-wins: 還原是災難復原的最後手段,必須贏過雲端與其他裝置既有的資料——
  // 即使雲端那筆的 updated_at 比備份檔內容新(包含墓碑/刪除)。所以把每一列的
  // updated_at 重新蓋成「現在」,讓下次同步的 LWW 判定還原內容嚴格較新而覆蓋雲端。
  // review_logs 是不可變事件(以 id 冪等去重,不走 LWW),不重蓋時間戳。
  const withDirty = (r: object) => ({ ...r, dirty: 1 as const, updated_at: now })
  const withDirtyOnly = (r: object) => ({ ...r, dirty: 1 as const })
  await db.transaction('rw', [db.decks, db.notes, db.cards, db.review_logs, db.meta], async () => {
    await db.decks.clear(); await db.decks.bulkAdd((data.decks ?? []).map(withDirty))
    await db.notes.clear(); await db.notes.bulkAdd((data.notes ?? []).map(withDirty))
    await db.cards.clear(); await db.cards.bulkAdd((data.cards ?? []).map(withDirty))
    await db.review_logs.clear(); await db.review_logs.bulkAdd((data.review_logs ?? []).map(withDirtyOnly))
    await db.meta.delete('sync_cursor') // 下次同步全量重拉,restore-wins 讓還原內容覆蓋雲端與其他裝置
  })
}
