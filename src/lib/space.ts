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
    await db.meta.delete(LAST_SPACE) // 本機清空了,沒有哪一列還屬於之前的空間
    await db.meta.put({ key: 'sync_space', value: next })
  })
}

/** 停止同步時記下原本的空間:這台的資料列在伺服器上屬於它(見 adoptSyncSpace) */
const LAST_SPACE = 'last_sync_space'

/**
 * 換一組新的 id(外鍵一起換),刪掉的列不帶。
 * 伺服器以 id 當全部空間共用的主鍵:同一個 id 推進另一個空間,會把那一列從原本的空間「搬走」,
 * 而且只有比較新的列會被搬 —— 新空間只拿到一部分、舊空間少了幾列。換了 id 就是兩份互不相干的資料。
 */
async function rekeyLocalRows(): Promise<void> {
  const deckIds = new Map<string, string>()
  const noteIds = new Map<string, string>()
  const cardIds = new Map<string, string>()
  const fresh = (ids: Map<string, string>, id: string): string => {
    let v = ids.get(id)
    if (v === undefined) { v = crypto.randomUUID(); ids.set(id, v) }
    return v
  }
  const decks = (await db.decks.toArray()).filter((d) => !d.deleted)
  const notes = (await db.notes.toArray()).filter((n) => !n.deleted)
  const cards = (await db.cards.toArray()).filter((c) => !c.deleted)
  const logs = await db.review_logs.toArray()
  await db.decks.clear()
  await db.notes.clear()
  await db.cards.clear()
  await db.review_logs.clear()
  await db.decks.bulkAdd(decks.map((d) => ({ ...d, id: fresh(deckIds, d.id) })))
  await db.notes.bulkAdd(notes.map((n) => ({ ...n, id: fresh(noteIds, n.id), deck_id: fresh(deckIds, n.deck_id) })))
  await db.cards.bulkAdd(cards.map((c) => ({
    ...c, id: fresh(cardIds, c.id), note_id: fresh(noteIds, c.note_id), deck_id: fresh(deckIds, c.deck_id),
  })))
  await db.review_logs.bulkAdd(logs.map((l) => ({ ...l, id: crypto.randomUUID(), card_id: fresh(cardIds, l.card_id) })))
}

/**
 * 從「只存這台」開始同步:**保留**本機資料,全部標成待上傳、游標歸零,再寫入金鑰。
 * 下一次同步就把這台的牌組與紀錄推進這個空間;空間裡原本就有資料的話,兩邊依 updated_at 合併。
 * (setSyncSpace 會清空本機,那是給「已經在同步、換到另一個空間」用的 ——
 * 純本機的人照「產生一組、儲存」的提示走那條路,會把只存在這台的資料整份清掉。)
 *
 * 這台的資料之前同步過別的空間(停止同步後改用別組金鑰):先換一組新的 id 再帶過去,
 * 原本那個空間的資料原封不動。回到同一個空間則照原 id 合併。
 * 設定(FSRS 參數、目標保持率)的時間戳歸零:空間裡已經有的(例如別台最佳化過的參數)優先,
 * 空間裡沒有才用這台的。
 */
export async function adoptSyncSpace(key: string): Promise<void> {
  const next = key.trim()
  await db.transaction('rw', [db.decks, db.notes, db.cards, db.review_logs, db.settings, db.meta], async () => {
    const last = await db.meta.get(LAST_SPACE)
    if (typeof last?.value === 'string' && last.value !== '' && last.value !== next) await rekeyLocalRows()
    await db.decks.toCollection().modify({ dirty: 1 })
    await db.notes.toCollection().modify({ dirty: 1 })
    await db.cards.toCollection().modify({ dirty: 1 })
    await db.review_logs.toCollection().modify({ dirty: 1 })
    await db.settings.toCollection().modify({ dirty: 1, updated_at: 0 })
    await db.meta.delete('sync_cursor')
    await db.meta.delete(LAST_SPACE)
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
    const cur = await db.meta.get('sync_space')
    if (typeof cur?.value === 'string' && cur.value !== '') await db.meta.put({ key: LAST_SPACE, value: cur.value })
    await db.meta.delete('sync_cursor')
    // 不再連線,上次的同步錯誤也不再成立(不然導覽列紅點會一直掛著)
    await db.meta.delete('sync_error')
    await db.meta.put({ key: 'sync_space', value: '' })
  })
}

/**
 * 手打或貼上的金鑰先正規化:全形轉半形、去掉空白、轉小寫;去掉分隔符號後剛好是
 * 12 個產生器會用的字元,就補回「xxxx-xxxx-xxxx」。抄成「BVJ6 AM4P AD9Q」也連得上同一個空間。
 * 不像產生出來的(舊版可以自訂任意字串,大小寫有差)就原樣接受,由畫面提醒「確定沒打錯？」。
 */
export function normalizeSyncKey(input: string): { key: string; standard: boolean } {
  const bare = input.normalize('NFKC').replace(/[\s\-‐‑–—ー_]+/g, '').toLowerCase()
  if (/^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/.test(bare)) {
    return { key: `${bare.slice(0, 4)}-${bare.slice(4, 8)}-${bare.slice(8)}`, standard: true }
  }
  return { key: input.trim(), standard: false }
}

/** 這台有幾副牌組、幾個字(不含已刪除的):連上一個空間後回報「下載了什麼」用 */
export async function countLocalContents(): Promise<{ decks: number; words: number }> {
  const decks = await db.decks.filter((d) => !d.deleted).count()
  const words = await db.notes.filter((n) => !n.deleted).count()
  return { decks, words }
}
