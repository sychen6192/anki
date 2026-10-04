import { Hono, type Context, type MiddlewareHandler } from 'hono'
import type {
  CardRecord, ConflictTable, DeckRecord, NoteRecord, ReviewLogRecord, SettingRecord, SyncPush, SyncPullResponse,
  SyncPushResponse,
} from '../shared/types'
import { isStandardSyncKey } from '../shared/syncKey'
import { MAX_FIELD_CHARS } from '../shared/limits'
import { derivedId } from '../shared/derivedId'

/** 限流器(wrangler.jsonc 的 ratelimits)。每一種的次數與時間窗不同,所以各自一個綁定 */
type LimiterName =
  | 'SYNC_LIMITER' | 'SUMMARY_LIMITER' | 'LEGACY_KEY_LIMITER' | 'SHARE_CREATE_LIMITER' | 'SHARE_READ_LIMITER' | 'ACCENT_LIMITER'

export type Env = {
  DB: D1Database
  ASSETS: Fetcher
} & Partial<Record<LimiterName, RateLimit>>

type AppContext = Context<{ Bindings: Env }>

const app = new Hono<{ Bindings: Env }>()

// 不明錯誤回結構化 JSON,別讓 Hono 吐 HTML 500(客戶端要能 parse)
app.onError((err, c) => {
  console.error(JSON.stringify({ level: 'error', path: c.req.path, message: err.message }))
  return c.json({ error: 'internal error' }, 500)
})

// 之後要上鎖:`wrangler secret put SYNC_TOKEN` 並取消下段註解(Env 加 SYNC_TOKEN: string)。
// 注意用 timingSafeEqual 而非 !==,避免逐字比對的時間差洩漏。
// app.use('/api/*', async (c, next) => {
//   const enc = new TextEncoder()
//   const got = enc.encode(c.req.header('x-sync-token') ?? '')
//   const want = enc.encode(c.env.SYNC_TOKEN)
//   const ok = got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want)
//   if (!ok) return c.text('unauthorized', 401)
//   await next()
// })

// API 的回應一律不快取:同一個網址(/api/sync/summary、/api/sync?since=0)依 x-sync-space 是不同空間的資料,
// 而 410 這類狀態碼瀏覽器預設可以快取 —— 實測 Chrome 會拿刪過的金鑰收到的 410 去回答下一組金鑰的請求
app.use('/api/*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})

app.get('/api/health', (c) => c.json({ ok: true }))

// ---------- 限流 ----------
// API 不用登入,誰都能打:沒有限流的話,一支腳本就能猜金鑰、把 D1 灌爆(帳單)、拿分享當免費的檔案空間。
// 依來源 IP 計數(Cloudflare 的 Rate Limiting binding,計數在各機房、最終一致:是煞車不是精確的配額)。
// 各端點的量見 wrangler.jsonc;正常使用碰不到 —— 用戶端遇到 429 會照 Retry-After 等一下再送(見 src/lib/sync.ts)。

/**
 * 計數用的 key:IPv4 用整個位址;IPv6 只取前 64 位元 —— 一般一戶分到一整段 /64,
 * 用完整位址的話換個尾碼就是新的一份額度。
 */
export function rateLimitKey(ip: string): string {
  if (!ip.includes(':')) return ip
  // 寫成 IPv6 的 IPv4(::ffff:1.2.3.4):照 IPv4 算,不然全部擠進同一個 0:0:0:0 的額度
  if (ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1)
  const [head, tail = ''] = ip.toLowerCase().split('::')
  const left = head === '' ? [] : head.split(':')
  const right = ip.includes('::') && tail !== '' ? tail.split(':') : []
  const groups = ip.includes('::')
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64'
}

/**
 * 這個請求超過額度了嗎。沒有綁定、拿不到來源 IP(worker 測試)或來源是本機時不限:
 * 線上一定有 cf-connecting-ip,也不會是 127.0.0.1;wrangler dev 會模擬限流器、把所有本機請求都算成 127.0.0.1,
 * 不跳過的話,本機測試一分鐘輸入金鑰超過 20 次就被擋。限流器自己出錯也放行:它壞掉不該連同步一起擋掉。
 */
async function overLimit(c: AppContext, name: LimiterName): Promise<boolean> {
  const limiter = c.env[name]
  const ip = c.req.header('cf-connecting-ip')
  if (limiter === undefined || ip === undefined || ip === '' || ip === '127.0.0.1' || ip === '::1') return false
  try {
    return !(await limiter.limit({ key: rateLimitKey(ip) })).success
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', path: c.req.path, message: `rate limiter: ${String(err)}` }))
    return false
  }
}

/** 超過額度回 429,帶 Retry-After(秒,與該限流器的時間窗一致) */
const limit = (name: LimiterName, retryAfterSec: number): MiddlewareHandler<{ Bindings: Env }> => async (c, next) => {
  if (await overLimit(c, name)) {
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ error: 'too many requests' }, 429)
  }
  await next()
}

const TABLE_COLS = {
  decks: ['id', 'name', 'new_per_day', 'updated_at', 'deleted', 'namespace'],
  notes: ['id', 'deck_id', 'expression', 'reading', 'meaning', 'accent', 'reversed', 'updated_at', 'deleted', 'namespace'],
  cards: ['id', 'note_id', 'deck_id', 'direction', 'due', 'stability', 'difficulty',
    'elapsed_days', 'scheduled_days', 'learning_steps', 'reps', 'lapses', 'state',
    'last_review', 'suspended', 'updated_at', 'deleted', 'namespace'],
  review_logs: ['id', 'card_id', 'rating', 'state', 'due', 'stability', 'difficulty',
    'elapsed_days', 'last_elapsed_days', 'scheduled_days', 'reviewed_at', 'namespace'],
  settings: ['id', 'value', 'updated_at', 'deleted', 'namespace'],
} as const

// 舊 client 不會送 accent / suspended;缺的欄位補預設值(兩欄都是 NOT NULL)。
// 其餘欄位缺值仍走 null(例如 cards.last_review 本來就可 null)。
// 代價:舊 client 評分一張卡會把它的 suspended 洗回 0 —— 與 accent 同一個已接受的邊角,
// 只在各裝置版本不一致的期間發生。
const COL_DEFAULTS: Partial<Record<TableName, Record<string, unknown>>> = {
  notes: { accent: '' },
  cards: { suspended: 0 },
}

type TableName = keyof typeof TABLE_COLS

// server_seq is no longer bound as a JS-computed value: it's taken inline via a
// subquery on meta so that "bump seq" + "write row" become two statements in the
// SAME db.batch() call — D1 executes a batch as one atomic transaction, running
// statements in order, so the write's subquery sees exactly the value its own
// preceding bump produced (same per-row semantics as the old sequential
// nextSeq()-then-INSERT, just packed into one API call instead of two).
const SEQ_EXPR = "(SELECT value FROM meta WHERE key = 'seq')"
const BUMP_SEQ_SQL = "UPDATE meta SET value = value + 1 WHERE key = 'seq'"

// Two statements per row: [0] bumps the shared seq counter, [1] does the actual
// write. Bumping unconditionally (even for rows the LWW/idempotency check below
// will end up ignoring) leaves a harmless gap in server_seq — pull's cursor
// semantics only rely on server_seq being monotonically increasing, not
// contiguous, so gaps are safe.
//
// 注意:namespace 不在 upsert 的 conflict target —— conflict 仍以 id(全表唯一 PK)為準。
// 同一個 id 已經在別的空間時,push 先查出來、不寫、回報給客戶端換新 id(見 findTaken);
// upsert 的 WHERE 再擋一次,就算查完到寫入之間有別的空間寫進同一個 id,也不會把那一列搬走。
// 這是刻意的輕量設計(非安全邊界);見 spec 2026-07-16-sync-namespace-design.md「安全」。
function buildRowStatements(
  db: D1Database, table: TableName, row: Record<string, unknown>,
): [D1PreparedStatement, D1PreparedStatement] {
  const bump = db.prepare(BUMP_SEQ_SQL)
  const cols = TABLE_COLS[table]
  const allCols = [...cols, 'server_seq']
  const colPlaceholders = cols.map(() => '?').join(', ')
  const values = cols.map((c) => {
    const v = row[c]
    if (v !== undefined) return v
    const def = COL_DEFAULTS[table]?.[c]
    return def !== undefined ? def : null
  })

  if (table === 'review_logs') {
    // review_logs are immutable events keyed by id: atomic no-op on duplicate id.
    const write = db.prepare(
      `INSERT OR IGNORE INTO review_logs (${allCols.join(', ')}) VALUES (${colPlaceholders}, ${SEQ_EXPR})`,
    ).bind(...values)
    return [bump, write]
  }

  // Atomic LWW upsert: a single statement replaces the previous SELECT-then-INSERT
  // OR REPLACE, so two near-simultaneous pushes to the same row can no longer
  // interleave a stale write over a newer one — the "is this row newer?" check and
  // the write happen as one statement, not as separate round trips a race could
  // land between. New id -> inserted. Existing id with strictly newer updated_at ->
  // updated. Existing id with older/equal updated_at -> WHERE clause false, DO
  // UPDATE is skipped, row is left untouched (LWW: 較舊或同時間戳忽略).
  // 別的空間的同 id 列也不動(不搬走)。
  const updateSet = cols.map((c) => `${c} = excluded.${c}`).concat('server_seq = excluded.server_seq').join(', ')
  const write = db.prepare(`
    INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${colPlaceholders}, ${SEQ_EXPR})
    ON CONFLICT(id) DO UPDATE SET ${updateSet}
    WHERE excluded.updated_at > ${table}.updated_at AND ${table}.namespace = excluded.namespace
  `).bind(...values)
  return [bump, write]
}

// D1 batch() = 1 API call (subrequest) regardless of how many statements it holds,
// which is exactly what lets a big push stay under Cloudflare's per-invocation
// subrequest limit. Still chunk at 100 statements (50 rows) per batch call to stay
// well under D1's bound-param/statement-count limits per call.
const STATEMENTS_PER_BATCH = 100

// Each row contributes exactly 2 statements (bump + write, see buildRowStatements)
// and callers rely on chunk boundaries never splitting a row's pair across two
// db.batch() calls. That only holds if STATEMENTS_PER_BATCH is even — enforce it
// once at module load instead of re-deriving/trusting it at every call site.
if (STATEMENTS_PER_BATCH % 2 !== 0) throw new Error('STATEMENTS_PER_BATCH must be even')

// 一個欄位最長 MAX_FIELD_CHARS 字(shared/limits.ts):不讓一個請求塞進幾 MB(灌爆 D1)。
// 超過的那一列跳過(回報給客戶端,客戶端留著 dirty),同一次推送的其他列照常存,不會整台卡住
/** 一次推送的上限:客戶端每批最多 200 列、約 1 MB(見 src/lib/sync.ts 的 PUSH_CHUNK_*),留好幾倍的餘裕 */
const MAX_PUSH_BYTES = 4_000_000
const MAX_PUSH_ROWS = 1_000

/**
 * 只放行能安全 bind 進 D1 的資料:每個欄位必須是字串/數字/null。
 * 一筆壞掉的資料(欄位是物件或陣列)會讓 .bind() 當場拋錯,整個 push 失敗;
 * 而客戶端的 push 迴圈一失敗就不會走到 pull,那台裝置的同步會**永久卡住**,
 * 每次重試都在同一筆壞資料上死。所以壞的那筆在這裡跳過,不連累其他列。
 */
function isStorableRow(table: TableName, row: Record<string, unknown>): boolean {
  if (typeof row.id !== 'string' || row.id === '') return false
  const stamp = table === 'review_logs' ? row.reviewed_at : row.updated_at
  if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return false
  return TABLE_COLS[table].every((col) => {
    const v = row[col]
    return v === undefined || v === null || (typeof v === 'string' && v.length <= MAX_FIELD_CHARS)
      || (typeof v === 'number' && Number.isFinite(v))
  })
}

/**
 * 設定列的 id 是固定的名稱(例如 'fsrs'),不像其他表是全域唯一的 UUID;而資料表以 id 當全表共用的主鍵
 * —— 兩個空間都存 'fsrs' 就會搶同一列(較新的那個空間把它搬走,另一個空間從此拉不到自己的設定)。
 * 所以存進資料庫時在 id 前面加上空間、讀出來再拿掉;以前存的(沒有前綴)照樣讀得到。
 * 不改 schema,舊版 worker 與新版 schema 並存時也不會出錯。
 */
const settingStorageId = (space: string, id: string): string => `${space}:${id}`
const settingClientId = (space: string, id: string): string =>
  id.startsWith(`${space}:`) ? id.slice(space.length + 1) : id

const CONFLICT_TABLES = ['decks', 'notes', 'cards', 'review_logs'] as const satisfies readonly ConflictTable[]

/** 子列參照父列的欄位:父列是別的空間的,子列就算自己的 id 沒問題也不存(存了就指向這個空間沒有的列) */
const PARENT_REFS: Partial<Record<ConflictTable, readonly (readonly [string, ConflictTable])[]>> = {
  notes: [['deck_id', 'decks']],
  cards: [['note_id', 'notes'], ['deck_id', 'decks']],
  review_logs: [['card_id', 'cards']],
}

type IdSets = Record<ConflictTable, Set<string>>
const emptyIdSets = (): IdSets => ({ decks: new Set(), notes: new Set(), cards: new Set(), review_logs: new Set() })

/**
 * 這次推送的 id(以及它們參照的父列 id)裡,要客戶端換 id 再推的那些:
 * - 已經屬於別的空間:資料表以 id 當全部空間共用的主鍵,同一個 id 推進另一個空間,以前會把那一列從原本的空間
 *   「搬走」—— 例如在另一台還原了某個空間的備份、再用新的金鑰開始同步,原本那個空間的牌組就整批不見。
 * - 這個空間裡已經有換過 id 的那一筆(derivedId(空間, id)):別台帶著同一份資料進來時換過 id 了
 *   (例如舊空間還在時就離開,見 src/lib/space.ts 的 rekeyLocalRows、rekeyConflicts)。照原 id 寫進去就變成兩份、
 *   複習紀錄算兩次;客戶端換成同一個 derivedId 再推,就照 updated_at 跟那一筆合併。
 * 這些都不寫、回報給客戶端,由客戶端換 id 再推(原本的空間原封不動)。
 */
async function findTaken(db: D1Database, space: string, want: IdSets): Promise<IdSets> {
  const out = await findIds(db, space, want, '!=')
  const twins = emptyIdSets()
  const original = new Map<string, string>()
  for (const t of CONFLICT_TABLES) {
    for (const id of want[t]) {
      const twin = derivedId(space, id)
      twins[t].add(twin)
      original.set(`${t}\u0000${twin}`, id)
    }
  }
  const present = await findIds(db, space, twins, '=')
  for (const t of CONFLICT_TABLES) for (const twin of present[t]) out[t].add(original.get(`${t}\u0000${twin}`)!)
  return out
}

/** want 裡哪些 id 在別的空間(!=)或這個空間(=)已經有了 */
async function findIds(db: D1Database, space: string, want: IdSets, op: '=' | '!='): Promise<IdSets> {
  const out = emptyIdSets()
  const tables = CONFLICT_TABLES.filter((t) => want[t].size > 0)
  if (tables.length === 0) return out
  // 一個參數帶整串 id(json_each),不受 D1 每句 100 個綁定參數的限制
  const results = await db.batch<{ id: string }>(tables.map((t) => db.prepare(
    `SELECT id FROM ${t} WHERE id IN (SELECT value FROM json_each(?)) AND namespace ${op} ?`,
  ).bind(JSON.stringify([...want[t]]), space)))
  tables.forEach((t, i) => { for (const r of results[i].results) out[t].add(r.id) })
  return out
}

// ---------- 同步空間的檢查與刪除 ----------

const SPACE_TABLES = ['decks', 'notes', 'cards', 'review_logs', 'settings'] as const

/** 刪除過的空間只記金鑰的雜湊:資料庫外洩也拿不到金鑰本身 */
async function spaceHash(space: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(space))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 這個空間在伺服器上有沒有任何一列(舊版自訂的金鑰只能繼續用已經有資料的空間) */
async function spaceHasRows(db: D1Database, space: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT ${SPACE_TABLES.map((t) => `EXISTS (SELECT 1 FROM ${t} WHERE namespace = ?1)`).join(' OR ')} AS found`,
  ).bind(space).first<{ found: number }>()
  return row !== null && row.found !== 0
}

const purgeSpace = (db: D1Database, space: string): D1PreparedStatement[] =>
  SPACE_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE namespace = ?`).bind(space))

const isDeleted = async (db: D1Database, space: string): Promise<boolean> =>
  await db.prepare('SELECT 1 AS x FROM deleted_spaces WHERE space_hash = ?').bind(await spaceHash(space)).first() !== null

/**
 * 不是產生器格式的金鑰(舊版自訂的 test、1234…):每個同步端點都會透露「這個空間在不在」,拉的還會整份給出去,
 * 所以不管打哪個端點都算進同一份很緊的額度 —— 不然查空間的額度再緊,拿 GET /api/sync 一樣能快速猜。
 * 產生的金鑰猜不到,不受這個限制。超過回 429 的 Response,沒超過回 null
 */
async function overLegacyLimit(c: AppContext, space: string): Promise<Response | null> {
  if (isStandardSyncKey(space) || !await overLimit(c, 'LEGACY_KEY_LIMITER')) return null
  c.header('Retry-After', '60')
  return c.json({ error: 'too many requests' }, 429)
}

/**
 * 同步端點共用的金鑰檢查(x-sync-space)。不過關就回 Response,過關回空間名稱:
 * - 沒帶金鑰:400。以前沒帶的會落在公用的預設空間 '',等於大家共寫一份;現在的用戶端沒金鑰就不連線。
 * - 刪除過的空間:410(順手再清一次;推送那邊寫完也會再查一次,見 POST /api/sync)。
 * - 不是產生器格式、空間裡又沒東西:400。舊版可以自訂金鑰(test、1234 這種一猜就中),
 *   已經在用的照舊能用(用戶端會建議換新的),但不能再拿來開新空間。
 */
async function checkSpace(c: AppContext): Promise<string | Response> {
  const space = c.req.header('x-sync-space') ?? ''
  if (space === '') return c.json({ error: 'missing space' }, 400)
  const legacyLimited = await overLegacyLimit(c, space)
  if (legacyLimited) return legacyLimited
  const db = c.env.DB
  if (await isDeleted(db, space)) {
    await db.batch(purgeSpace(db, space))
    return c.json({ error: 'space deleted' }, 410)
  }
  if (!isStandardSyncKey(space) && !(await spaceHasRows(db, space))) return c.json({ error: 'invalid space' }, 400)
  return space
}

/**
 * 刪除雲端資料:空間裡五張表的列全部刪掉,並記下這組金鑰已經刪除(之後同步一律 410,見 checkSpace)。
 * 同一個 batch = 同一個交易,不會刪到一半。重送(例如回應在路上掉了)照樣回成功。
 * 一鍵分享的牌組不在空間裡(誰拿到連結誰就能匯入),不受影響,180 天後自動清掉。
 */
app.delete('/api/sync', limit('SYNC_LIMITER', 10), async (c) => {
  const space = c.req.header('x-sync-space') ?? ''
  if (space === '') return c.json({ error: 'missing space' }, 400)
  const legacyLimited = await overLegacyLimit(c, space)
  if (legacyLimited) return legacyLimited
  const db = c.env.DB
  // 舊版自訂、雲端又沒東西的金鑰:沒有可刪的,這種金鑰本來也開不了新空間,不必記
  if (!isStandardSyncKey(space) && !(await spaceHasRows(db, space))) return c.json({ ok: true })
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO deleted_spaces (space_hash, deleted_at) VALUES (?, ?)')
      .bind(await spaceHash(space), Date.now()),
    ...purgeSpace(db, space),
  ])
  return c.json({ ok: true })
})

app.post('/api/sync', limit('SYNC_LIMITER', 10), async (c) => {
  const checked = await checkSpace(c)
  if (checked instanceof Response) return checked
  const space = checked
  if (Number(c.req.header('content-length') ?? 0) > MAX_PUSH_BYTES) return c.json({ error: 'payload too large' }, 413)
  const raw = await c.req.text()
  // 沒帶 Content-Length(分塊傳送)的也要擋:讀完再量一次
  if (raw.length > MAX_PUSH_BYTES) return c.json({ error: 'payload too large' }, 413)
  let body: SyncPush | null = null
  try { body = JSON.parse(raw) as SyncPush } catch { body = null }
  if (body === null || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400)
  const rowCount = SPACE_TABLES.reduce((n, t) => n + (Array.isArray(body[t]) ? (body[t] as unknown[]).length : 0), 0)
  if (rowCount > MAX_PUSH_ROWS) return c.json({ error: 'too many rows' }, 413)
  const db = c.env.DB
  // 跳過的列會回報給客戶端,客戶端據此保留 dirty(資料沒被丟掉,只是沒存進去)
  const skipped: string[] = []
  // 存不下而跳過的列(例如欄位太長):它的子列也不能存,不然別台會拉到指向不存在的字的卡片
  const rejected = emptyIdSets()
  const rowsToWrite: { t: TableName; r: Record<string, unknown> }[] = []
  for (const t of ['decks', 'notes', 'cards', 'review_logs', 'settings'] as const) {
    const rows = body[t]
    if (rows === undefined || rows === null) continue
    if (!Array.isArray(rows)) return c.json({ error: `invalid ${t}` }, 400)
    for (const row of rows) {
      const r: Record<string, unknown> = { ...(row as unknown as Record<string, unknown>), namespace: space }
      if (row === null || typeof row !== 'object' || !isStorableRow(t, r)) {
        const id = typeof (row as { id?: unknown })?.id === 'string' ? (row as { id: string }).id : ''
        skipped.push(id)
        if (t !== 'settings' && id !== '') rejected[t].add(id)
        continue
      }
      if (t === 'settings') r.id = settingStorageId(space, r.id as string)
      rowsToWrite.push({ t, r })
    }
  }

  const want = emptyIdSets()
  for (const { t, r } of rowsToWrite) {
    if (t === 'settings') continue
    want[t].add(r.id as string)
    for (const [col, parent] of PARENT_REFS[t] ?? []) {
      if (typeof r[col] === 'string') want[parent].add(r[col] as string)
    }
  }
  const taken = await findTaken(db, space, want)
  // 跳過的父列以前就存過(這次只是改了之後存不下):子列照常寫,指向的是空間裡原本那一列。
  // 子列自己已經在空間裡(例如之前那一批先存了)也照常寫:別台早就拉到了,擋下它的更新與墓碑只會讓它永遠清不掉。
  // 這兩種都要問資料庫:把可能被連帶跳過的父列、子列(子列的子列也算,資料照 牌組 → 字 → 卡片 → 紀錄 的順序)一起查
  const maybe = emptyIdSets()
  for (const t of CONFLICT_TABLES) for (const id of rejected[t]) maybe[t].add(id)
  const check = emptyIdSets()
  for (const { t, r } of rowsToWrite) {
    if (t === 'settings') continue
    for (const [col, parent] of PARENT_REFS[t] ?? []) {
      if (!maybe[parent].has(r[col] as string)) continue
      check[parent].add(r[col] as string)
      check[t].add(r.id as string)
      maybe[t].add(r.id as string)
    }
  }
  const stored = await findIds(db, space, check, '=')
  const conflictSets = emptyIdSets()
  const statements: D1PreparedStatement[] = []
  for (const { t, r } of rowsToWrite) {
    if (t !== 'settings') {
      const id = r.id as string
      // 父列這次存不下、空間裡也沒有:子列一起跳過(子列的子列也是)
      if (!stored[t].has(id) && (PARENT_REFS[t] ?? []).some(([col, parent]) =>
        rejected[parent].has(r[col] as string) && !stored[parent].has(r[col] as string))) {
        rejected[t].add(id)
        skipped.push(id)
        continue
      }
      if (taken[t].has(id)) {
        conflictSets[t].add(id)
        skipped.push(id)
        continue
      }
      const takenParents = (PARENT_REFS[t] ?? []).filter(([col, parent]) => taken[parent].has(r[col] as string))
      if (takenParents.length > 0) {
        // 父列也回報成衝突:就算它沒在這次推送裡(客戶端那邊沒改過),客戶端也會把它換 id、連同子列再推一次,
        // 不然子列每次都被跳過,永遠卡在「還沒同步」
        for (const [col, parent] of takenParents) conflictSets[parent].add(r[col] as string)
        skipped.push(id)
        continue
      }
    }
    statements.push(...buildRowStatements(db, t, r))
  }
  const conflicts: Partial<Record<ConflictTable, string[]>> = {}
  for (const t of CONFLICT_TABLES) if (conflictSets[t].size > 0) conflicts[t] = [...conflictSets[t]]
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + STATEMENTS_PER_BATCH))
  }
  // 開頭檢查過之後、寫進去之前,剛好有人刪了這個空間(例如另一台按了刪除,這台在背景補推):這批寫進了刪掉的空間。
  // D1 的寫入一個一個排隊:刪除要嘛在這次查詢之前就生效(這裡查得到、自己清掉),要嘛在最後一批寫入之後
  // (刪除自己會清掉),兩種都不會留下東西 —— 不能指望這台還有下一個請求來清(切到背景的補推就只有這一次)
  if (statements.length > 0 && await isDeleted(db, space)) {
    await db.batch(purgeSpace(db, space))
    return c.json({ error: 'space deleted' }, 410)
  }
  // 存不下、空間裡也沒有的列:回報給客戶端,這次同步後面幾批裡它們的子列先留著不推(子列常常在下一批,
  // 這一批的連帶跳過管不到),免得別台拉到指向不存在的字的卡片
  const rejectedIds = emptyIdSets()
  for (const t of CONFLICT_TABLES) for (const id of rejected[t]) if (!stored[t].has(id)) rejectedIds[t].add(id)
  const inSpace = await findIds(db, space, rejectedIds, '=')
  const held = CONFLICT_TABLES.flatMap((t) => [...rejectedIds[t]].filter((id) => !inSpace[t].has(id)))
  const resp: SyncPushResponse = {
    ok: true, skipped, ...(Object.keys(conflicts).length > 0 ? { conflicts } : {}), ...(held.length > 0 ? { held } : {}),
  }
  return c.json(resp)
})

// 連上一組金鑰之前先看那個空間有沒有東西:連不上就什麼都不改,空的多半是金鑰打錯
// (打錯一碼會連進一個全新的空間,看起來像資料全不見)。有金鑰的人本來就能拉下整個空間,這裡不多透露什麼。
app.get('/api/sync/summary', limit('SUMMARY_LIMITER', 60), async (c) => {
  const checked = await checkSpace(c)
  if (checked instanceof Response) return checked
  const space = checked
  // decks:沒刪除的牌組數(「空間是空的嗎」)。ids:空間認得的每一副牌組(含刪掉的)——
  // 帶著本機資料合併進來時,這些不是這台新帶進去的,不拿去併同名牌組
  const { results } = await c.env.DB.prepare('SELECT id, deleted FROM decks WHERE namespace = ?')
    .bind(space).all<{ id: string; deleted: number }>()
  return c.json({ decks: results.filter((r) => !r.deleted).length, ids: results.map((r) => r.id) })
})

app.get('/api/sync', limit('SYNC_LIMITER', 10), async (c) => {
  const since = Number(c.req.query('since') ?? '0')
  if (Number.isNaN(since) || since < 0) return c.json({ error: 'invalid since' }, 400)
  const checked = await checkSpace(c)
  if (checked instanceof Response) return checked
  const space = checked
  const db = c.env.DB
  const pullTable = async <T>(table: TableName): Promise<T[]> => {
    const res = await db.prepare(`SELECT * FROM ${table} WHERE namespace = ? AND server_seq > ?`)
      .bind(space, since).all<T & { server_seq: number; namespace: string }>()
    return res.results.map(({ server_seq: _s, namespace: _n, ...rest }) => rest as unknown as T)
  }
  const seqRow = await db.prepare("SELECT value FROM meta WHERE key = 'seq'").first<{ value: number }>()
  const resp: SyncPullResponse = {
    decks: await pullTable<DeckRecord>('decks'),
    notes: await pullTable<NoteRecord>('notes'),
    cards: await pullTable<CardRecord>('cards'),
    review_logs: await pullTable<ReviewLogRecord>('review_logs'),
    settings: (await pullTable<SettingRecord>('settings')).map((s) => ({ ...s, id: settingClientId(space, s.id) })),
    seq: seqRow!.value,
  }
  return c.json(resp)
})

// 片假名 → 平假名,讓字典(平假名 reading)與各種輸入對得上。
const kataToHira = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))

// 把 statements 依 STATEMENTS_PER_BATCH 分批送 db.batch(),不逐項單發(避免超過子請求上限)。
async function batchAll(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  const out: D1Result[] = []
  for (let i = 0; i < stmts.length; i += STATEMENTS_PER_BATCH) {
    out.push(...await db.batch(stmts.slice(i, i + STATEMENTS_PER_BATCH)))
  }
  return out
}

interface Pair { expression: string; reading: string }

// 精確查(漢字+読み),回傳與 pairs 同序的 (pitch|null)[]。
async function queryExact(db: D1Database, pairs: Pair[]): Promise<(string | null)[]> {
  if (pairs.length === 0) return []
  const stmts = pairs.map((p) =>
    db.prepare('SELECT pitch FROM accent_dict WHERE expression = ? AND reading = ? LIMIT 1').bind(p.expression, p.reading))
  return (await batchAll(db, stmts)).map((r) => {
    const row = (r.results as { pitch: string }[])[0]
    return row ? row.pitch : null
  })
}

// 読み反查:只有唯一 pitch 才採用,多解回 null。
async function queryByReading(db: D1Database, readings: string[]): Promise<(string | null)[]> {
  if (readings.length === 0) return []
  const stmts = readings.map((r) => db.prepare('SELECT DISTINCT pitch FROM accent_dict WHERE reading = ?').bind(r))
  return (await batchAll(db, stmts)).map((r) => {
    const rows = r.results as { pitch: string }[]
    return rows.length === 1 ? rows[0].pitch : null
  })
}

async function lookupAccents(db: D1Database, items: Pair[]): Promise<(string | null)[]> {
  const norm = items.map((it) => ({ expression: it.expression, reading: kataToHira(it.reading) }))
  const out = await queryExact(db, norm)

  // 第二段:読み反查(對第一段的 miss)
  const missIdx = out.flatMap((v, i) => (v === null ? [i] : []))
  if (missIdx.length) {
    const byReading = await queryByReading(db, missIdx.map((i) => norm[i].reading))
    missIdx.forEach((i, k) => { if (byReading[k] !== null) out[i] = byReading[k] })
  }

  // 第三段:漢字與読み皆以「な」結尾 → 去尾後再跑精確 + 読み反查
  const naIdx = out.flatMap((v, i) =>
    (v === null && norm[i].expression.endsWith('な') && norm[i].reading.endsWith('な') ? [i] : []))
  if (naIdx.length) {
    const stripped = naIdx.map((i) => ({
      expression: norm[i].expression.slice(0, -1), reading: norm[i].reading.slice(0, -1),
    }))
    const ex = await queryExact(db, stripped)
    const stillMiss: { idx: number; reading: string }[] = []
    naIdx.forEach((i, k) => {
      if (ex[k] !== null) out[i] = ex[k]
      else stillMiss.push({ idx: i, reading: stripped[k].reading })
    })
    if (stillMiss.length) {
      const byReading = await queryByReading(db, stillMiss.map((s) => s.reading))
      stillMiss.forEach((s, k) => { if (byReading[k] !== null) out[s.idx] = byReading[k] })
    }
  }
  return out
}

app.post('/api/accent/lookup', limit('ACCENT_LIMITER', 10), async (c) => {
  const body = await c.req.json<{ items?: unknown }>().catch(() => ({}))
  const items = (body as { items?: unknown }).items
  if (!Array.isArray(items)) return c.json({ error: 'items must be an array' }, 400)
  if (items.length === 0) return c.json({ error: 'items is empty' }, 400)
  if (items.length > 200) return c.json({ error: 'too many items (max 200)' }, 400)
  for (const it of items) {
    if (typeof it?.expression !== 'string' || typeof it?.reading !== 'string') {
      return c.json({ error: 'each item needs string expression and reading' }, 400)
    }
  }
  const results = await lookupAccents(c.env.DB, items as Pair[])
  return c.json({ results })
})

// ---------- 一鍵分享牌組 ----------
// 一份分享 = 一個隨機 code。內容是純單字列(不含排程),誰拿到連結誰就能匯入,
// 與同步空間無關。code 8 字 × 31 種 ≈ 2^40,夠擋亂猜。

const SHARE_MAX_ROWS = 5000
const SHARE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function genShareCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => SHARE_ALPHABET[b % SHARE_ALPHABET.length]).join('')
}

interface ShareRow { expression: string; reading: string; meaning: string; accent: string }

app.post('/api/share', limit('SHARE_CREATE_LIMITER', 60), async (c) => {
  // 大牌組的 JSON 上傳可觀(869 筆約 57KB),客戶端會 gzip(約剩 1/3)再送
  let body: { name?: unknown; rows?: unknown } | null = null
  try {
    const text = c.req.header('x-body-gzip') === '1'
      ? await new Response(c.req.raw.body!.pipeThrough(new DecompressionStream('gzip'))).text()
      : await c.req.text()
    body = JSON.parse(text) as { name?: unknown; rows?: unknown }
  } catch {
    body = null
  }
  if (body === null || typeof body.name !== 'string' || body.name.trim() === '') {
    return c.json({ error: 'name is required' }, 400)
  }
  if (body.name.length > 200) return c.json({ error: 'name too long' }, 400)
  if (!Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > SHARE_MAX_ROWS) {
    return c.json({ error: `rows must be 1..${SHARE_MAX_ROWS}` }, 400)
  }
  const rows: ShareRow[] = []
  for (const r of body.rows as Record<string, unknown>[]) {
    if (r === null || typeof r !== 'object') return c.json({ error: 'invalid row' }, 400)
    const { expression, reading, meaning, accent } = r
    if (typeof expression !== 'string' || expression === '' || typeof meaning !== 'string' || meaning === '') {
      return c.json({ error: 'each row needs expression and meaning' }, 400)
    }
    rows.push({
      expression,
      reading: typeof reading === 'string' ? reading : '',
      meaning,
      accent: typeof accent === 'string' ? accent : '',
    })
  }
  const payload = JSON.stringify(rows)
  // 869 個字的牌組約 57 KB:600 KB 放得下 SHARE_MAX_ROWS 個字,又不讓分享變成免費的檔案空間
  if (payload.length > 600_000) return c.json({ error: 'payload too large' }, 400)
  const code = genShareCode()
  // 順手清掉半年前的舊分享,表才不會被匿名寫入無限養大
  const cutoff = Date.now() - 180 * 86400_000
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM shares WHERE created_at < ?').bind(cutoff),
    c.env.DB.prepare('INSERT INTO shares (code, name, payload, created_at) VALUES (?, ?, ?, ?)')
      .bind(code, body.name.trim(), payload, Date.now()),
  ])
  return c.json({ code })
})

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))

// 分享連結貼到 LINE/Discord 時要有像樣的預覽:/import 先進 worker,
// 有 share 參數就把牌組名與筆數塞進 og: 標籤,其餘原樣回 SPA shell。
app.get('/import', async (c) => {
  const shell = await c.env.ASSETS.fetch(new URL('/', c.req.url))
  const code = c.req.query('share')
  if (code === undefined || code === '') return shell
  // 打開分享連結是一般的換頁,超過額度不回 429 錯誤頁:照樣給頁面,只是不查預覽(頁面自己讀分享時才會被擋)
  if (await overLimit(c, 'SHARE_READ_LIMITER')) return shell
  const row = await c.env.DB.prepare('SELECT name, payload FROM shares WHERE code = ?')
    .bind(code).first<{ name: string; payload: string }>().catch(() => null)
  if (row === null) return shell
  const count = (JSON.parse(row.payload) as unknown[]).length
  const meta =
    `<meta property="og:title" content="${escapeHtml(row.name)} — 字卡牌組分享">` +
    `<meta property="og:description" content="${count} 個單字，點開直接匯入">` +
    `<meta property="og:type" content="website">`
  return new HTMLRewriter()
    .on('head', { element(el) { el.append(meta, { html: true }) } })
    .transform(shell)
})

app.get('/api/share/:code', limit('SHARE_READ_LIMITER', 60), async (c) => {
  const row = await c.env.DB.prepare('SELECT name, payload FROM shares WHERE code = ?')
    .bind(c.req.param('code')).first<{ name: string; payload: string }>()
  if (row === null) return c.json({ error: 'not found' }, 404)
  return c.json({ name: row.name, rows: JSON.parse(row.payload) })
})

export default app
