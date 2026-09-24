import type { Table } from 'dexie'
import type { CardRecord, ConflictTable, NoteRecord } from '../../shared/types'
import { db, type Local } from '../db/db'

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
    await db.meta.delete(REKEYED)
    await db.meta.delete(PENDING_FOLD)
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
    await db.meta.delete(REKEYED)
    await db.meta.delete(PENDING_FOLD)
    await db.meta.put({ key: 'sync_space', value: next })
    await db.meta.put({ key: SYNC_SINCE, value: Date.now() })
  })
}

/** 停止同步時記下原本的空間:這台的資料列在伺服器上屬於它(見 adoptSyncSpace) */
const LAST_SPACE = 'last_sync_space'

/**
 * 這台開始同步目前這組金鑰的時間。首頁「超過一天沒同步成功」從上次成功或這個時間算起 ——
 * 剛開啟同步、第一次就失敗(還沒有上次成功的時間)不算超過一天。
 */
export const SYNC_SINCE = 'sync_since'

/** 因為撞到別的空間而換過 id 的列:舊 id → 新 id(JSON)。還原備份後的整理要用,見 backup.ts pruneToBackup */
export const REKEYED = 'rekeyed_ids'

/** 帶著本機資料合併進空間後,等同步成功再併進同名牌組的那幾副(JSON 的 id 陣列),見 runPendingFold */
export const PENDING_FOLD = 'pending_fold'

/** 照換 id 的紀錄一路找到最後的 id:換過不只一次(舊 → 中間 → 新)時,只看一層會停在已經不存在的中間那個 */
export function resolveRekeyed(map: Readonly<Record<string, string>>, id: string): string {
  let cur = id
  for (let i = 0; i < 32 && map[cur] !== undefined && map[cur] !== cur; i++) cur = map[cur]
  return cur
}

export async function readRekeyed(): Promise<Record<string, string>> {
  const row = await db.meta.get(REKEYED)
  if (typeof row?.value !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(row.value)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, string> : {}
  } catch {
    return {}
  }
}

/** bryc 的 cyrb128:簡單的 128 位元字串雜湊(非加密用途),同步算得出來,可以在 Dexie 交易裡用 */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

/**
 * 換 id 時的新 id:由(要進去的空間,舊 id)算出來,不是亂數。好幾台裝置把同一批別的空間的資料
 * (例如同一份備份)帶進同一個空間,換出來的 id 一樣,就會照 updated_at 合併成一份,而不是每台各一份。
 */
export function derivedId(space: string, oldId: string): string {
  const hex = cyrb128(`${space}\u0000${oldId}`).map((x) => x.toString(16).padStart(8, '0')).join('')
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * 伺服器回報「這些 id 已經是別的空間的」:換一組新 id,參照它們的列跟著改,全部標成待上傳。
 * 這台的資料來自別的空間時會發生 —— 還原了另一個空間的備份、在沒同步的裝置還原備份後用新金鑰開始同步,
 * 或以前停止同步(那時還沒有 LAST_SPACE 紀錄)再改用別組金鑰。伺服器不會把別的空間的列搬過來,
 * 不換 id 的話這些列永遠進不了這個空間;換了 id 就是兩份互不相干的資料,原本的空間原封不動。
 * 刪除過的列也照換(保留刪除狀態),參照才會一致。回傳換過 id 的列數。
 */
export async function rekeyConflicts(
  conflicts: Partial<Record<ConflictTable, string[]>>, space: string,
): Promise<number> {
  let count = 0
  await db.transaction('rw', [db.decks, db.notes, db.cards, db.review_logs, db.meta], async () => {
    const moved: Record<string, string> = {}
    const renew = async <T extends { id: string; updated_at?: number }>(
      table: Table<Local<T>, string>, ids: string[] | undefined,
    ): Promise<Map<string, string>> => {
      const out = new Map<string, string>()
      for (const id of new Set(ids ?? [])) {
        const row = await table.get(id)
        if (!row) continue
        const next = derivedId(space, id)
        // 新 id 本機已經有了(別台換好的那份已經拉下來):照 updated_at 留新的那份,不重複加一列
        const existing = await table.get(next)
        if (existing === undefined) await table.add({ ...row, id: next, dirty: 1 })
        else if ((row.updated_at ?? 0) > (existing.updated_at ?? 0)) await table.put({ ...row, id: next, dirty: 1 })
        await table.delete(id)
        out.set(id, next)
        moved[id] = next
      }
      count += out.size
      // 同一批裡新 id 自己也被換掉的(舊 → 中間 → 新):子列要指到最後那個
      const chain = Object.fromEntries(out)
      for (const [from, to] of out) out.set(from, resolveRekeyed(chain, to))
      return out
    }
    // 父表先換:子列的外鍵先改好,輪到子列自己換 id 時讀到的就是新的外鍵
    const decks = await renew(db.decks, conflicts.decks)
    if (decks.size > 0) {
      const old = [...decks.keys()]
      await db.notes.where('deck_id').anyOf(old).modify((n) => { n.deck_id = decks.get(n.deck_id)!; n.dirty = 1 })
      await db.cards.where('deck_id').anyOf(old).modify((c) => { c.deck_id = decks.get(c.deck_id)!; c.dirty = 1 })
    }
    const notes = await renew(db.notes, conflicts.notes)
    if (notes.size > 0) {
      await db.cards.where('note_id').anyOf([...notes.keys()]).modify((c) => { c.note_id = notes.get(c.note_id)!; c.dirty = 1 })
    }
    const cards = await renew(db.cards, conflicts.cards)
    if (cards.size > 0) {
      await db.review_logs.where('card_id').anyOf([...cards.keys()]).modify((l) => { l.card_id = cards.get(l.card_id)!; l.dirty = 1 })
    }
    await renew(db.review_logs, conflicts.review_logs)
    if (count > 0) {
      // 以前換過的再被換一次:舊的紀錄也改指到最後的 id(還原後的整理、合併時的併牌組都靠它認)
      const all: Record<string, string> = { ...await readRekeyed(), ...moved }
      for (const from of Object.keys(all)) all[from] = resolveRekeyed(all, all[from])
      await db.meta.put({ key: REKEYED, value: JSON.stringify(all) })
    }
  })
  return count
}

/**
 * 換一組新的 id(外鍵一起換),刪掉的列不帶。
 * 伺服器以 id 當全部空間共用的主鍵:這台的列在伺服器上屬於原本的空間,原 id 推進新空間會撞到
 * (伺服器不寫、回報衝突,見 rekeyConflicts)。先整份換好 id,就是兩份互不相干的資料,不必等伺服器逐筆退回。
 */
async function rekeyLocalRows(next: string): Promise<void> {
  // 新 id 由(新空間,舊 id)算出來(見 derivedId):同一批資料從兩台帶進同一個空間,還是同一份
  const fresh = (id: string): string => derivedId(next, id)
  const decks = (await db.decks.toArray()).filter((d) => !d.deleted)
  const notes = (await db.notes.toArray()).filter((n) => !n.deleted)
  const cards = (await db.cards.toArray()).filter((c) => !c.deleted)
  const logs = await db.review_logs.toArray()
  await db.decks.clear()
  await db.notes.clear()
  await db.cards.clear()
  await db.review_logs.clear()
  await db.decks.bulkAdd(decks.map((d) => ({ ...d, id: fresh(d.id) })))
  await db.notes.bulkAdd(notes.map((n) => ({ ...n, id: fresh(n.id), deck_id: fresh(n.deck_id) })))
  await db.cards.bulkAdd(cards.map((c) => ({
    ...c, id: fresh(c.id), note_id: fresh(c.note_id), deck_id: fresh(c.deck_id),
  })))
  await db.review_logs.bulkAdd(logs.map((l) => ({ ...l, id: fresh(l.id), card_id: fresh(l.card_id) })))
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
export async function adoptSyncSpace(key: string, knownDeckIds?: ReadonlySet<string>): Promise<void> {
  const next = key.trim()
  await db.transaction('rw', [db.decks, db.notes, db.cards, db.review_logs, db.settings, db.meta], async () => {
    const last = await db.meta.get(LAST_SPACE)
    if (typeof last?.value === 'string' && last.value !== '' && last.value !== next) await rekeyLocalRows(next)
    // 合併進已經有東西的空間(knownDeckIds = 空間認得的牌組,含刪掉的):這台新帶進去的牌組記下來,
    // 同步成功、空間的牌組拉下來之後併進同名的那副(見 runPendingFold)。空間認得的不算這台的 ——
    // 停止同步後回到同一個空間時,共用的那副要是被當成「這台的」併掉,別台在那副的進度就沒了
    const fold = knownDeckIds === undefined || knownDeckIds.size === 0 ? []
      : (await db.decks.toArray()).filter((d) => !d.deleted && !knownDeckIds.has(d.id)).map((d) => d.id)
    if (fold.length > 0) await db.meta.put({ key: PENDING_FOLD, value: JSON.stringify(fold) })
    else await db.meta.delete(PENDING_FOLD)
    await db.decks.toCollection().modify({ dirty: 1 })
    await db.notes.toCollection().modify({ dirty: 1 })
    await db.cards.toCollection().modify({ dirty: 1 })
    await db.review_logs.toCollection().modify({ dirty: 1 })
    await db.settings.toCollection().modify({ dirty: 1, updated_at: 0 })
    await db.meta.delete('sync_cursor')
    await db.meta.delete(LAST_SPACE)
    await db.meta.put({ key: 'sync_space', value: next })
    await db.meta.put({ key: SYNC_SINCE, value: Date.now() })
  })
}

/** 排程欄位:同一個字兩邊都有、這台背得比較多時,整組抄到留下來的那張卡 */
const SCHEDULE = [
  'due', 'stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'learning_steps', 'reps', 'lapses', 'state', 'last_review',
] as const
const scheduleOf = (c: CardRecord): Partial<CardRecord> => Object.fromEntries(SCHEDULE.map((k) => [k, c[k]]))

/** a 的進度比 b 多:複習次數多;一樣多就看誰最近複習過 */
const aheadOf = (a: CardRecord, b: CardRecord): boolean =>
  a.reps > b.reps || (a.reps === b.reps && (a.last_review ?? 0) > (b.last_review ?? 0))

/**
 * 同一個字兩邊都有:字留空間裡那筆,進度一張一張比(正向、反向各自比)——
 * 這台背得比較多的,排程抄過去;「已經會了」「先不學」任一邊標過就留著(之後隨時可以恢復)。
 * 空間裡那筆沒有這個方向的卡、這台又背過或標過:整張搬過去(複習紀錄跟著)。最後刪掉這台那筆。
 */
async function mergeTwin(mine: Local<NoteRecord>, twin: Local<NoteRecord>, t: number): Promise<void> {
  const theirs = await db.cards.where('note_id').equals(twin.id).toArray()
  let reverseOn = false
  for (const lc of (await db.cards.where('note_id').equals(mine.id).toArray()).filter((c) => !c.deleted)) {
    const tc = theirs.find((c) => c.direction === lc.direction)
    if (tc === undefined || tc.deleted) {
      if (lc.reps === 0 && lc.suspended === 0) continue // 沒背過也沒標過:不必帶
      if (tc === undefined) await db.cards.update(lc.id, { note_id: twin.id, deck_id: twin.deck_id, updated_at: t, dirty: 1 })
      else await db.cards.update(tc.id, { ...scheduleOf(lc), suspended: lc.suspended, deleted: 0, updated_at: t, dirty: 1 })
      if (lc.direction === 'reverse') reverseOn = true
      continue
    }
    const patch: Partial<CardRecord> = aheadOf(lc, tc) ? scheduleOf(lc) : {}
    if (lc.suspended > tc.suspended) patch.suspended = lc.suspended
    if (Object.keys(patch).length > 0) await db.cards.update(tc.id, { ...patch, updated_at: t, dirty: 1 })
  }
  if (reverseOn && !twin.reversed) await db.notes.update(twin.id, { reversed: 1, updated_at: t, dirty: 1 })
  await db.notes.update(mine.id, { deleted: 1, updated_at: t, dirty: 1 })
  await db.cards.where('note_id').equals(mine.id).modify({ deleted: 1, updated_at: t, dirty: 1 })
}

/**
 * 帶著本機資料加入一個已經有東西的空間之後,同名的牌組併成一副 —— 最常見的是兩台都從同一份範本開始,
 * 不併的話每個字都有兩份、每天的新卡也變兩倍。localDeckIds 是這台新帶進去的牌組(空間原本不認得的),
 * 併進空間裡同名的那副(不只一副時每台挑到同一副):那邊沒有的字搬過去;兩邊都有的(單字+讀音相同)
 * 字留空間裡那筆、進度留多的那份(見 mergeTwin)。只拿空間的字比 —— 這台自己拼法相同的兩筆照樣一起搬過去。
 * 空掉的牌組刪掉。回傳併掉幾副。
 */
export async function foldIntoSameNameDecks(localDeckIds: Set<string>): Promise<number> {
  const key = (n: { expression: string; reading: string }) => `${n.expression.trim()}\u0000${n.reading.trim()}`
  let folded = 0
  await db.transaction('rw', [db.decks, db.notes, db.cards], async () => {
    const t = Date.now()
    const live = (await db.decks.toArray()).filter((d) => !d.deleted)
      .sort((a, b) => (a.id < b.id ? -1 : 1)) // 同名的不只一副時,每台挑到同一副
    const spaceDecks = new Map<string, string[]>()
    for (const d of live) {
      if (localDeckIds.has(d.id)) continue
      const name = d.name.trim()
      spaceDecks.set(name, [...(spaceDecks.get(name) ?? []), d.id])
    }
    for (const local of live.filter((d) => localDeckIds.has(d.id))) {
      const same = spaceDecks.get(local.name.trim())
      if (same === undefined) continue
      const target = same[0]
      // 空間裡已經有的字:同名的每一副都算,優先對到要併進去的那副
      const inSpace = new Map<string, Local<NoteRecord>>()
      for (const id of same) {
        for (const n of await db.notes.where('deck_id').equals(id).toArray()) {
          if (!n.deleted && !inSpace.has(key(n))) inSpace.set(key(n), n)
        }
      }
      for (const n of (await db.notes.where('deck_id').equals(local.id).toArray()).filter((x) => !x.deleted)) {
        const twin = inSpace.get(key(n))
        if (twin !== undefined) {
          await mergeTwin(n, twin, t)
        } else {
          await db.notes.update(n.id, { deck_id: target, updated_at: t, dirty: 1 })
          await db.cards.where('note_id').equals(n.id).modify({ deck_id: target, updated_at: t, dirty: 1 })
        }
      }
      await db.decks.update(local.id, { deleted: 1, updated_at: t, dirty: 1 })
      folded++
    }
  })
  return folded
}

/**
 * 合併進空間時記下的待併牌組(見 adoptSyncSpace):同步成功、空間的牌組都拉下來之後才做,
 * 合併當下那次同步失敗也不會漏掉。推上去時換過 id 的照最後的 id 認。回傳併掉幾副。
 */
export async function runPendingFold(): Promise<number> {
  let folded = 0
  await db.transaction('rw', [db.decks, db.notes, db.cards, db.meta], async () => {
    const row = await db.meta.get(PENDING_FOLD)
    if (row === undefined) return
    await db.meta.delete(PENDING_FOLD)
    let ids: string[] = []
    try {
      const parsed: unknown = JSON.parse(String(row.value))
      if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      return // 紀錄壞了就不併(頂多留著同名的兩副,不會刪錯東西)
    }
    if (ids.length === 0) return
    const map = await readRekeyed()
    folded = await foldIntoSameNameDecks(new Set(ids.map((id) => resolveRekeyed(map, id))))
  })
  return folded
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
    await db.meta.delete(PENDING_FOLD)
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
