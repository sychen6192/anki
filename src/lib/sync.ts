import type { Table, UpdateSpec } from 'dexie'
import { db, type Local } from '../db/db'
import type {
  CardRecord, DeckRecord, NoteRecord, ReviewLogRecord, SettingRecord,
  SyncPush, SyncPullResponse, SyncPushResponse,
} from '../../shared/types'
import { getSyncSpace, rekeyConflicts, runPendingFold } from './space'

export interface SyncResult {
  ok: boolean
  skipped?: boolean
  /** skipped 的原因:沒設金鑰(純本機)/ 離線 / 同步中被換了空間 / 一直被別的同步搶先(下次再拉) */
  reason?: 'local-only' | 'offline' | 'switched' | 'busy'
  error?: string
  /** 這次同步順便把合併時等著的同名牌組併掉了幾副(見 runPendingFold) */
  folded?: number
}

// Cap each push POST at this many rows so a big first sync (e.g. importing an
// 869-note deck) can't blow past Cloudflare's per-invocation subrequest limit —
// see worker/index.ts for the matching server-side db.batch() chunking.
const PUSH_CHUNK_SIZE = 200

interface PushChunk {
  decks: Local<DeckRecord>[]; notes: Local<NoteRecord>[]
  cards: Local<CardRecord>[]; review_logs: Local<ReviewLogRecord>[]
  settings: Local<SettingRecord>[]
}

type TaggedRow =
  | { table: 'decks'; row: Local<DeckRecord> }
  | { table: 'notes'; row: Local<NoteRecord> }
  | { table: 'cards'; row: Local<CardRecord> }
  | { table: 'review_logs'; row: Local<ReviewLogRecord> }
  | { table: 'settings'; row: Local<SettingRecord> }

function emptyChunk(): PushChunk {
  return { decks: [], notes: [], cards: [], review_logs: [], settings: [] }
}

type DirtyRows = {
  decks: Local<DeckRecord>[]; notes: Local<NoteRecord>[]; cards: Local<CardRecord>[]
  review_logs: Local<ReviewLogRecord>[]; settings: Local<SettingRecord>[]
}

// 父表在前(decks -> notes -> cards -> review_logs -> settings):伺服器收到子列時父列多半已經在了。
// 刪掉的牌組放最後:併牌組時「字搬過去」要比「那副刪掉」先到 —— 推到一半斷線的話,別台先拉到牌組刪掉、
// 字卻還在那副底下,整理(reconcile)時會把還沒搬過去的字一起刪掉
function tagRows(d: DirtyRows): TaggedRow[] {
  const deck = (row: Local<DeckRecord>) => ({ table: 'decks' as const, row })
  return [
    ...d.decks.filter((row) => !row.deleted).map(deck),
    ...d.notes.map((row) => ({ table: 'notes' as const, row })),
    ...d.cards.map((row) => ({ table: 'cards' as const, row })),
    ...d.review_logs.map((row) => ({ table: 'review_logs' as const, row })),
    ...d.settings.map((row) => ({ table: 'settings' as const, row })),
    ...d.decks.filter((row) => row.deleted).map(deck),
  ]
}

function addToChunk(chunk: PushChunk, item: TaggedRow): void {
  if (item.table === 'decks') chunk.decks.push(item.row)
  else if (item.table === 'notes') chunk.notes.push(item.row)
  else if (item.table === 'cards') chunk.cards.push(item.row)
  else if (item.table === 'review_logs') chunk.review_logs.push(item.row)
  else chunk.settings.push(item.row)
}

// Fills chunks in tagRows order (a chunk may span tables); each chunk keeps the
// original Local<T> rows around (not just the stripped-of-dirty wire shape) so the
// caller can clear dirty flags per-chunk after a successful POST.
function buildPushChunks(d: DirtyRows): PushChunk[] {
  const tagged = tagRows(d)
  const chunks: PushChunk[] = []
  for (let i = 0; i < tagged.length; i += PUSH_CHUNK_SIZE) {
    const chunk = emptyChunk()
    for (const item of tagged.slice(i, i + PUSH_CHUNK_SIZE)) addToChunk(chunk, item)
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
    // 兩邊都是 0 只會是設定列:帶著本機資料加入空間時,這台的設定時間戳歸零(見 adoptSyncSpace),
    // 意思是「空間裡已經有的優先」。伺服器那邊同樣不接受 0 蓋 0,所以這裡要讓空間的那份進來,
    // 不然兩台各自帶著 0 加入,就會一直各用各的設定
    const tie0 = existing !== undefined && existing.updated_at === 0 && row.updated_at === 0
    if (!existing || row.updated_at > existing.updated_at || tie0) {
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

async function readDirty(): Promise<DirtyRows> {
  return {
    decks: await db.decks.where('dirty').equals(1).toArray(),
    notes: await db.notes.where('dirty').equals(1).toArray(),
    cards: await db.cards.where('dirty').equals(1).toArray(),
    review_logs: await db.review_logs.where('dirty').equals(1).toArray(),
    settings: await db.settings.where('dirty').equals(1).toArray(),
  }
}

function chunkBody(chunk: PushChunk): SyncPush {
  return {
    decks: stripDirty(chunk.decks), notes: stripDirty(chunk.notes),
    cards: stripDirty(chunk.cards), review_logs: stripDirty(chunk.review_logs),
    settings: stripDirty(chunk.settings),
  }
}

/**
 * 伺服器收下一批之後:清掉存進去的列的 dirty,撞到別的空間的列換 id(換過的列會再推一次)。
 * 回傳有沒有換過 id。先清 dirty 再換 id:換 id 時改到外鍵的列會重新標成 dirty,不能被這裡清掉。
 */
async function applyPushResponse(chunk: PushChunk, pushRes: SyncPushResponse | null, space: string): Promise<boolean> {
  const skipped = new Set(pushRes?.skipped ?? [])
  const conflicts = pushRes?.conflicts
  const conflictCount = conflicts ? Object.values(conflicts).reduce((n, ids) => n + (ids?.length ?? 0), 0) : 0
  if (skipped.size > conflictCount) console.warn('伺服器跳過了無法存下的資料列', [...skipped])
  await clearPushedDirty(db.decks, chunk.decks, skipped)
  await clearPushedDirty(db.notes, chunk.notes, skipped)
  await clearPushedDirty(db.cards, chunk.cards, skipped)
  await clearPushedDirty(db.settings, chunk.settings, skipped)
  for (const log of chunk.review_logs) {
    if (!skipped.has(log.id)) await db.review_logs.update(log.id, { dirty: 0 })
  }
  return conflictCount > 0 && await rekeyConflicts(conflicts!, space) > 0
}

/**
 * 撞到別的空間的列換過 id 之後要再推一輪。一輪就把整批要換的 id 換完(伺服器連子列參照的父列都會檢查),
 * 第二輪推換過 id 的列;第三輪只是保險。
 */
const MAX_PUSH_PASSES = 3

async function pushDirty(space: string, fetchFn: typeof fetch, holdLogsAfter?: number): Promise<void> {
  for (let pass = 0; pass < MAX_PUSH_PASSES; pass++) {
    const dirty = await readDirty()
    if (holdLogsAfter !== undefined) dirty.review_logs = dirty.review_logs.filter((l) => l.reviewed_at <= holdLogsAfter)
    if (Object.values(dirty).every((rows) => rows.length === 0)) return
    const chunks = buildPushChunks(dirty)
    let rekeyed = false
    // Push chunk-by-chunk; clear each chunk's dirty flags only after its own POST
    // succeeds. If a later chunk's POST fails we stop (throw) — chunks already
    // cleared stay cleared, so the next syncNow resumes with just the remaining
    // dirty rows instead of resending everything from scratch.
    for (const chunk of chunks) {
      const res = await fetchFn('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sync-space': space },
        body: JSON.stringify(chunkBody(chunk)),
      })
      if (!res.ok) throw new Error(`push failed: ${res.status}`)
      const pushRes = await res.json().catch(() => null) as SyncPushResponse | null
      if (await applyPushResponse(chunk, pushRes, space)) rekeyed = true
    }
    if (!rekeyed) return
  }
}

type PullOutcome = 'merged' | 'switched' | 'moved'

/**
 * 拉下 since 之後的變更併進本機。游標在拉的期間變了就不併、不寫游標(回 'moved'):
 * 被重設(還原備份、清空這台重新下載)時,這份資料只有舊游標之後的變更,併進來再把游標往前推,
 * 之前的東西就再也拉不到了;被別的同步往前推時,那一次已經併過。
 */
async function pullOnce(space: string, fetchFn: typeof fetch): Promise<PullOutcome> {
  const since = (await db.meta.get('sync_cursor'))?.value ?? 0
  const res = await fetchFn(`/api/sync?since=${since}`, { headers: { 'x-sync-space': space } })
  if (!res.ok) throw new Error(`pull failed: ${res.status}`)
  const data: SyncPullResponse = await res.json()
  let outcome: PullOutcome = 'merged'
  await db.transaction('rw', [db.decks, db.notes, db.cards, db.review_logs, db.settings, db.meta], async () => {
    // 同步進行中若金鑰被切換(換空間會清空本機),放棄把舊空間的 pull 併入新空間。
    // 在交易內讀 sync_space 與游標,與 setSyncSpace、還原備份、清空本機的交易互斥,杜絕競態。
    const cur = await db.meta.get('sync_space')
    if ((typeof cur?.value === 'string' ? cur.value : '') !== space) { outcome = 'switched'; return }
    if (((await db.meta.get('sync_cursor'))?.value ?? 0) !== since) { outcome = 'moved'; return }
    await mergeTable(db.decks, data.decks)
    await mergeTable(db.notes, data.notes)
    // 還沒套 0006 migration 的舊伺服器不回 suspended,補 0 讓本機的列形狀完整
    await mergeTable(db.cards, data.cards.map((c) => ({ ...c, suspended: c.suspended ?? 0 })))
    await mergeTable(db.settings, data.settings ?? []) // 還沒套 0005 migration 的舊伺服器不回這張表
    for (const log of data.review_logs) {
      if (!(await db.review_logs.get(log.id))) await db.review_logs.put({ ...log, dirty: 0 })
    }
    // 只有真的合併到東西才需要收斂,空的 pull 不必掃全表
    if (data.decks.length + data.notes.length + data.cards.length > 0) await reconcile()
    await db.meta.put({ key: 'sync_cursor', value: data.seq })
    await db.meta.put({ key: 'last_sync_at', value: Date.now() })
  })
  return outcome
}

/**
 * holdRecentLogs:最近 RECENT_LOG_HOLD_MS 內的複習紀錄這次先不推(卡片照推)。複習中「一直延後、最多等 60 秒」
 * 的那一次用:剛按錯、馬上復原的那筆還沒上傳就刪掉了 —— 上傳過的紀錄在伺服器上刪不掉,
 * 別台會多算一次(今天的新卡、統計、最佳化都會用到)。
 */
export async function syncNow(fetchFn: typeof fetch = fetch, opts?: { holdRecentLogs?: boolean }): Promise<SyncResult> {
  // 沒設金鑰 = 純本機模式,一個 request 都不發。空金鑰以前會落在公用的預設空間,
  // 等於每個沒設金鑰的人共寫同一份資料;現在改成資料就留在這台裝置,
  // 使用者在設定頁存下一組金鑰之後才開始同步。
  const space = await getSyncSpace()
  if (space === '') {
    // 有金鑰時失敗過、後來切回純本機的話,舊旗標會永遠掛在導覽列紅點與牌組頁橫幅上
    // —— 這裡不再連線,那個錯誤也就不再成立
    await db.meta.delete('sync_error').catch(() => {})
    return { ok: false, skipped: true, reason: 'local-only' }
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, skipped: true, reason: 'offline' }
  }
  try {
    const holdLogsAfter = opts?.holdRecentLogs ? Date.now() - RECENT_LOG_HOLD_MS : undefined
    await pushDirty(space, fetchFn, holdLogsAfter)
    // 游標被動過就用新的游標再拉一次(還原備份後的整理靠這次拉到的資料,不能少)
    let outcome: PullOutcome = 'moved'
    for (let attempt = 0; attempt < 3 && outcome === 'moved'; attempt++) outcome = await pullOnce(space, fetchFn)
    if (outcome === 'switched') return { ok: false, skipped: true, reason: 'switched' }
    if (outcome === 'moved') return { ok: false, skipped: true, reason: 'busy' }
    await db.meta.delete('sync_error')
    // 帶著本機資料合併進空間後等著併的同名牌組(見 adoptSyncSpace):要等同步成功、空間的牌組都拉下來了
    // 才併得了 —— 合併當下那次同步失敗的話,就在之後第一次成功的同步做。併完馬上推上去
    const folded = await runPendingFold()
    if (folded > 0) await pushDirty(space, fetchFn, holdLogsAfter)
    return folded > 0 ? { ok: true, folded } : { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // 背景同步的失敗沒有畫面可報,寫進 meta 讓導覽列紅點/牌組頁橫幅撿去顯示
    await db.meta.put({ key: 'sync_error', value: message }).catch(() => {})
    return { ok: false, error: message }
  }
}

/**
 * 連上一組金鑰之前的確認:用哪一個金鑰、那個空間有幾副牌組。連不上回 null(什麼都不要改)。
 * 舊版可以自訂金鑰,大小寫有差、原樣存下來;正規化後剛好像產生器格式的舊金鑰(例如 JapanN3Study)
 * 會被改寫成另一個空間 —— 正規化後的空間是空的、照原樣打的那個有東西,就用原樣的。
 */
export async function probeSyncKey(
  input: string, normalized: string, fetchFn: typeof fetch = fetch,
): Promise<{ key: string; decks: number } | null> {
  const decks = await countSpaceDecks(normalized, fetchFn)
  if (decks === null) return null
  const raw = input.trim()
  if (decks > 0 || raw === '' || raw === normalized) return { key: normalized, decks }
  // 照原樣的只試放得進 header 的(舊版存得下來、也真的同步過的):全形字、長音符號這類放不進去
  try {
    new Headers({ 'x-sync-space': raw })
  } catch {
    return { key: normalized, decks }
  }
  const rawDecks = await countSpaceDecks(raw, fetchFn)
  // 第二個沒問到就當連不上:「沒問到」不能當成「空的」,讓人以為打錯、或連進正規化那個空的空間
  if (rawDecks === null) return null
  if (rawDecks > 0) return { key: raw, decks: rawDecks }
  return { key: normalized, decks }
}

/**
 * 空間的概況:沒刪除的牌組數,與空間認得的每一副牌組的 id(含刪掉的;舊版伺服器沒有,是 null)。
 * 連不上、或伺服器還是舊版沒有這個端點,回 null —— 呼叫端就什麼都不改,等連上網路再試。
 */
export async function fetchSpaceSummary(
  space: string, fetchFn: typeof fetch = fetch,
): Promise<{ decks: number; ids: string[] | null } | null> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null
  try {
    const res = await fetchFn('/api/sync/summary', { headers: { 'x-sync-space': space } })
    if (!res.ok) return null
    const data = await res.json() as { decks?: unknown; ids?: unknown }
    if (typeof data.decks !== 'number') return null
    const ids = Array.isArray(data.ids) ? data.ids.filter((x): x is string => typeof x === 'string') : null
    return { decks: data.decks, ids }
  } catch {
    return null
  }
}

/** 連上一組金鑰之前先看那個空間有幾副牌組(不含已刪除的);連不上回 null */
export async function countSpaceDecks(space: string, fetchFn: typeof fetch = fetch): Promise<number | null> {
  return (await fetchSpaceSummary(space, fetchFn))?.decks ?? null
}

let pendingSync: ReturnType<typeof setTimeout> | undefined
let pendingSince = 0

/**
 * 連續操作一直把同步往後延的時候,從第一次要求起最多等這麼久就先同步一次。
 * 複習時每評一張就延一次:一張接一張背,整段都不會上傳,別台看到的是舊狀態,背景補推也會超過上限。
 */
export const MAX_SYNC_WAIT_MS = 60_000
/** 等到上限才推的那一次,最近這麼久的複習紀錄先留著(見 syncNow 的 holdRecentLogs) */
export const RECENT_LOG_HOLD_MS = 10_000

/**
 * 資料異動後的延遲同步:匯入、編輯、改設定之後呼叫。
 * debounce 幾秒讓連續操作(逐張編輯、連按開關)合併成一次請求,但最多等 MAX_SYNC_WAIT_MS。
 */
export function requestSync(delayMs = 3000, fetchFn: typeof fetch = fetch): void {
  const now = Date.now()
  if (pendingSync === undefined) pendingSince = now
  clearTimeout(pendingSync)
  const wait = Math.max(0, Math.min(delayMs, pendingSince + MAX_SYNC_WAIT_MS - now))
  // 等到上限才推(還在連續操作中):最近的複習紀錄先留著,剛按錯馬上復原的不會已經傳出去
  const capped = wait < delayMs
  pendingSync = setTimeout(() => {
    pendingSync = undefined
    if (!capped) { void syncNow(fetchFn); return }
    void (async () => {
      await syncNow(fetchFn, { holdRecentLogs: true })
      // 留下來的那幾筆過一會兒再推(還在評分的話,下一次延遲同步本來就會一起帶走)
      if (pendingSync === undefined && await db.review_logs.where('dirty').equals(1).count() > 0) {
        requestSync(RECENT_LOG_HOLD_MS + 1000, fetchFn)
      }
    })()
  }, wait)
}

/** keepalive 請求的內容上限:瀏覽器對「還在路上的 keepalive 請求」總共只給 64KB,超過直接失敗 */
export const KEEPALIVE_BUDGET = 60_000
let keepaliveInFlight = false

/**
 * 頁面要被收到背景時補推一次(鎖螢幕、換 App、關分頁):手機上背到一半被打斷,晚上在電腦打開才不會
 * 拿到舊狀態、同一批卡再背一次。keepalive 讓請求在頁面凍結、關閉後還能送完,但總量只有 64KB ——
 * 只挑放得下的列推一次(跟一般同步同樣父表在前),其餘留給回到前景後的同步。
 * visibilitychange 與 pagehide 常常連發,同時只送一個;推不上去也不記成同步失敗,這只是順手補推。
 */
export async function pushBeforeHidden(fetchFn: typeof fetch = fetch): Promise<void> {
  if (keepaliveInFlight) return
  keepaliveInFlight = true
  try {
    const space = await getSyncSpace()
    if (space === '' || (typeof navigator !== 'undefined' && navigator.onLine === false)) return
    const chunk = emptyChunk()
    const enc = new TextEncoder()
    let bytes = 128 // {"decks":[],"notes":[],...} 的外框
    let rows = 0
    for (const item of tagRows(await readDirty())) {
      const { dirty: _d, ...wire } = item.row
      const size = enc.encode(JSON.stringify(wire)).length + 1
      if (bytes + size > KEEPALIVE_BUDGET) break
      addToChunk(chunk, item)
      bytes += size
      rows++
    }
    if (rows === 0) return
    const res = await fetchFn('/api/sync', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json', 'x-sync-space': space },
      body: JSON.stringify(chunkBody(chunk)),
    })
    // 回應可能永遠等不到(頁面已凍結);等得到就照一般同步清掉 dirty
    if (res.ok) await applyPushResponse(chunk, await res.json().catch(() => null) as SyncPushResponse | null, space)
  } catch {
    // 下次同步會補
  } finally {
    keepaliveInFlight = false
  }
}

export function setupAutoSync(): void {
  const run = () => { void syncNow() }
  window.addEventListener('online', run)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void pushBeforeHidden()
  })
  window.addEventListener('pagehide', () => { void pushBeforeHidden() })
  // 手機上的 PWA 常駐背景、很少冷啟動 —— 回到前景也要同步,
  // 但切分頁會讓 visibilitychange 連發,60 秒內只跑一次
  let lastRun = 0
  const guarded = () => {
    if (Date.now() - lastRun < 60_000) return
    lastRun = Date.now()
    run()
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') guarded()
  })
  setInterval(guarded, 15 * 60_000) // 長開不動的頁面(桌機掛著)每 15 分鐘補一次
  guarded()
}
