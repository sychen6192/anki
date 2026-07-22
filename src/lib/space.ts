import { db } from '../db/db'

/**
 * 產生一組好唸好抄的隨機金鑰(xxxx-xxxx-xxxx)。
 * 字母表拿掉易混淆的 i/l/o/0/1;12 字 × 31 種 ≈ 2^59,以「網址+金鑰」的
 * 威脅模型來說足夠 —— 真要上鎖走 SYNC_TOKEN(見 README)。
 */
export function generateSyncKey(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`
}

/** 讀取本機同步金鑰;未設為空字串(預設空間)。 */
export async function getSyncSpace(): Promise<string> {
  const row = await db.meta.get('sync_space')
  return typeof row?.value === 'string' ? row.value : ''
}

/** 清空本機四張資料表與同步游標,保留金鑰;之後重新同步取得該金鑰空間資料。 */
export async function clearLocalData(): Promise<void> {
  await db.transaction('rw', [db.decks, db.notes, db.cards, db.review_logs, db.meta], async () => {
    await db.decks.clear()
    await db.notes.clear()
    await db.cards.clear()
    await db.review_logs.clear()
    await db.meta.delete('sync_cursor')
  })
}

/**
 * 設定同步金鑰。換金鑰 = 換空間:強制先清空本機(避免舊空間的 id 混入新空間)、
 * 游標歸零,再寫入新金鑰。金鑰與目前相同則不動本機(no-op)。
 */
export async function setSyncSpace(key: string): Promise<void> {
  const next = key.trim()
  if (next === (await getSyncSpace())) return
  // 換空間:清空本機四表 + 游標歸零 + 寫新金鑰,全部同一交易(與 syncNow 的併入交易互斥,杜絕競態)
  await db.transaction('rw', [db.decks, db.notes, db.cards, db.review_logs, db.meta], async () => {
    await db.decks.clear()
    await db.notes.clear()
    await db.cards.clear()
    await db.review_logs.clear()
    await db.meta.delete('sync_cursor')
    await db.meta.put({ key: 'sync_space', value: next })
  })
}
