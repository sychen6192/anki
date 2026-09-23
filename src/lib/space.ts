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

/** 讀取本機同步金鑰;未設為空字串 = 純本機模式,syncNow 會直接跳過不連雲端。 */
export async function getSyncSpace(): Promise<string> {
  const row = await db.meta.get('sync_space')
  return typeof row?.value === 'string' ? row.value : ''
}

/** 清空本機五張資料表與同步游標,保留金鑰;之後重新同步取得該金鑰空間資料。 */
export async function clearLocalData(): Promise<void> {
  await db.transaction('rw', [db.decks, db.notes, db.cards, db.review_logs, db.settings, db.meta], async () => {
    await db.decks.clear()
    await db.notes.clear()
    await db.cards.clear()
    await db.review_logs.clear()
    await db.settings.clear()
    await db.meta.delete('sync_cursor')
  })
}

/**
 * 設定同步金鑰。換金鑰 = 換空間:強制先清空本機(避免舊空間的 id 混入新空間)、
 * 游標歸零,再寫入新金鑰。金鑰與目前相同則不動本機(no-op)。
 */
export async function setSyncSpace(key: string): Promise<void> {
  const next = key.trim()
  if (next === (await getSyncSpace())) {
    // 值沒變也要把 meta 列寫下來:全新安裝時 meta 缺列 =「還沒選過」,
    // 牌組頁靠這一列決定要不要顯示首次啟動的金鑰選擇。
    await db.meta.put({ key: 'sync_space', value: next })
    return
  }
  // 換空間:清空本機五表 + 游標歸零 + 寫新金鑰,全部同一交易(與 syncNow 的併入交易互斥,杜絕競態)
  await db.transaction('rw', [db.decks, db.notes, db.cards, db.review_logs, db.settings, db.meta], async () => {
    await db.decks.clear()
    await db.notes.clear()
    await db.cards.clear()
    await db.review_logs.clear()
    await db.settings.clear()
    await db.meta.delete('sync_cursor')
    await db.meta.put({ key: 'sync_space', value: next })
  })
}

/**
 * 從「只存這台」開始同步:**保留**本機資料,全部標成待上傳、游標歸零,再寫入金鑰。
 * 下一次同步就把這台的牌組與紀錄推進這個空間;空間裡原本就有資料的話,兩邊依 updated_at 合併。
 * (setSyncSpace 會清空本機,那是給「已經在同步、換到另一個空間」用的 ——
 * 純本機的人照「產生一組、儲存」的提示走那條路,會把只存在這台的資料整份清掉。)
 */
export async function adoptSyncSpace(key: string): Promise<void> {
  const next = key.trim()
  await db.transaction('rw', [db.decks, db.notes, db.cards, db.review_logs, db.settings, db.meta], async () => {
    await db.decks.toCollection().modify({ dirty: 1 })
    await db.notes.toCollection().modify({ dirty: 1 })
    await db.cards.toCollection().modify({ dirty: 1 })
    await db.review_logs.toCollection().modify({ dirty: 1 })
    await db.settings.toCollection().modify({ dirty: 1 })
    await db.meta.delete('sync_cursor')
    await db.meta.put({ key: 'sync_space', value: next })
  })
}

/** 本機有沒有任何牌組或複習紀錄(決定換金鑰時要不要問「帶過去還是捨棄」) */
export async function hasLocalData(): Promise<boolean> {
  return (await db.decks.count()) + (await db.review_logs.count()) > 0
}

/** 還沒推上雲端的列數(換金鑰或停止同步前先確認,不然這些會跟著本機一起清掉) */
export async function countUnsynced(): Promise<number> {
  const counts = await Promise.all([db.decks, db.notes, db.cards, db.review_logs, db.settings]
    .map((t) => (t as typeof db.decks).where('dirty').equals(1).count()))
  return counts.reduce((a, b) => a + b, 0)
}

/**
 * 停止同步但**保留這台的資料**:只把金鑰清成空白、游標歸零。純本機模式不連雲端,
 * 不會和別的空間混在一起;之後要再同步就走 adoptSyncSpace,這台的東西會一起帶上去。
 */
export async function leaveSyncSpace(): Promise<void> {
  await db.transaction('rw', [db.meta], async () => {
    await db.meta.delete('sync_cursor')
    await db.meta.put({ key: 'sync_space', value: '' })
  })
}
