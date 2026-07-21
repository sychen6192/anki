import { db, type Local } from '../db/db'
import type { CardRecord, DeckRecord, NoteRecord, ReviewLogRecord } from '../../shared/types'

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

const TABLES = ['decks', 'notes', 'cards', 'review_logs'] as const

/**
 * 還原前先把備份檔看過一遍。這裡是最容易吃到壞資料的地方(手動編輯過、下載到一半、
 * 或根本選錯檔案),而清空本機是不可逆的 —— 與其讓 bulkAdd 在交易中途丟出看不懂的
 * Dexie 錯誤、或塞進缺欄位的資料讓之後的排程算出 NaN,不如在動手前就講清楚哪裡不對。
 */
function parseBackup(json: string): Record<string, Record<string, unknown>[]> {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error('這不是有效的 JSON 檔')
  }
  if (data === null || typeof data !== 'object') throw new Error('備份檔格式不正確')
  const obj = data as Record<string, unknown>
  if (obj.version !== 1) throw new Error('不支援的備份版本')

  const out: Record<string, Record<string, unknown>[]> = {}
  for (const table of TABLES) {
    const rows = obj[table] ?? []
    if (!Array.isArray(rows)) throw new Error(`備份檔的 ${table} 不是陣列`)
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || typeof (row as { id?: unknown }).id !== 'string') {
        throw new Error(`備份檔的 ${table} 裡有缺少 id 的資料`)
      }
    }
    out[table] = rows as Record<string, unknown>[]
  }
  // new_per_day 若不是數字,之後每日新卡額度會算成 NaN,佇列會靜默變成空的
  for (const deck of out.decks) {
    if (typeof deck.new_per_day !== 'number' || !Number.isFinite(deck.new_per_day)) {
      throw new Error('備份檔的牌組缺少每日新卡上限(new_per_day)')
    }
  }
  return out
}

export async function importBackup(json: string): Promise<void> {
  const data = parseBackup(json)
  const now = Date.now()
  // Restore-wins: 還原是災難復原的最後手段,必須贏過雲端與其他裝置既有的資料——
  // 即使雲端那筆的 updated_at 比備份檔內容新(包含墓碑/刪除)。所以把每一列的
  // updated_at 重新蓋成「現在」,讓下次同步的 LWW 判定還原內容嚴格較新而覆蓋雲端。
  // review_logs 是不可變事件(以 id 冪等去重,不走 LWW),不重蓋時間戳。
  const withDirty = (r: object) => ({ ...r, dirty: 1 as const, updated_at: now })
  const withDirtyOnly = (r: object) => ({ ...r, dirty: 1 as const })
  // 舊備份(pitch-accent 功能之前匯出)的 note 沒有 accent 欄,匯入時補成 ''
  // 以符合 NoteRecord.accent 的必填 string 型別(見 design spec:匯入舊備份缺 accent 時補 '')。
  const withDirtyNote = (r: { accent?: string }) => ({ ...r, accent: r.accent ?? '', dirty: 1 as const, updated_at: now })
  // parseBackup 已擋掉最容易出事的情況(不是陣列、缺 id、new_per_day 不是數字);
  // 其餘欄位沿用備份檔內容,這裡的 as 是把驗證過的資料交回原本的型別。
  const as = <T>(rows: unknown[]) => rows as T[]
  await db.transaction('rw', [db.decks, db.notes, db.cards, db.review_logs, db.meta], async () => {
    await db.decks.clear(); await db.decks.bulkAdd(as<Local<DeckRecord>>(data.decks.map(withDirty)))
    await db.notes.clear(); await db.notes.bulkAdd(as<Local<NoteRecord>>(data.notes.map(withDirtyNote)))
    await db.cards.clear(); await db.cards.bulkAdd(as<Local<CardRecord>>(data.cards.map(withDirty)))
    await db.review_logs.clear(); await db.review_logs.bulkAdd(as<Local<ReviewLogRecord>>(data.review_logs.map(withDirtyOnly)))
    await db.meta.delete('sync_cursor') // 下次同步全量重拉,restore-wins 讓還原內容覆蓋雲端與其他裝置
  })
}
