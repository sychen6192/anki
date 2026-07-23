import { Hono } from 'hono'
import type {
  CardRecord, DeckRecord, NoteRecord, ReviewLogRecord, SyncPush, SyncPullResponse,
} from '../shared/types'

export type Env = { DB: D1Database; ASSETS: Fetcher }

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

app.get('/api/health', (c) => c.json({ ok: true }))

const TABLE_COLS = {
  decks: ['id', 'name', 'new_per_day', 'updated_at', 'deleted', 'namespace'],
  notes: ['id', 'deck_id', 'expression', 'reading', 'meaning', 'accent', 'reversed', 'updated_at', 'deleted', 'namespace'],
  cards: ['id', 'note_id', 'deck_id', 'direction', 'due', 'stability', 'difficulty',
    'elapsed_days', 'scheduled_days', 'learning_steps', 'reps', 'lapses', 'state',
    'last_review', 'updated_at', 'deleted', 'namespace'],
  review_logs: ['id', 'card_id', 'rating', 'state', 'due', 'stability', 'difficulty',
    'elapsed_days', 'last_elapsed_days', 'scheduled_days', 'reviewed_at', 'namespace'],
} as const

// 舊 client 不會送 accent;缺欄位的 note 以 '' 補上(notes.accent 是 NOT NULL)。
// 其餘欄位缺值仍走 null(例如 cards.last_review 本來就可 null)。
const COL_DEFAULTS: Partial<Record<TableName, Record<string, unknown>>> = {
  notes: { accent: '' },
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
// 跨 namespace 的隔離因此仰賴「id 全域唯一(UUID)」+「換金鑰時客戶端強制清空本機」。
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
  const updateSet = cols.map((c) => `${c} = excluded.${c}`).concat('server_seq = excluded.server_seq').join(', ')
  const write = db.prepare(`
    INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${colPlaceholders}, ${SEQ_EXPR})
    ON CONFLICT(id) DO UPDATE SET ${updateSet}
    WHERE excluded.updated_at > ${table}.updated_at
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
    return v === undefined || v === null || typeof v === 'string'
      || (typeof v === 'number' && Number.isFinite(v))
  })
}

app.post('/api/sync', async (c) => {
  const body = await c.req.json<SyncPush>().catch(() => null)
  if (body === null || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400)
  const space = c.req.header('x-sync-space') ?? ''
  const db = c.env.DB
  const statements: D1PreparedStatement[] = []
  // 跳過的列會回報給客戶端,客戶端據此保留 dirty(資料沒被丟掉,只是沒存進去)
  const skipped: string[] = []
  for (const t of ['decks', 'notes', 'cards', 'review_logs'] as const) {
    const rows = body[t]
    if (rows === undefined || rows === null) continue
    if (!Array.isArray(rows)) return c.json({ error: `invalid ${t}` }, 400)
    for (const row of rows) {
      const r = { ...(row as unknown as Record<string, unknown>), namespace: space }
      if (row === null || typeof row !== 'object' || !isStorableRow(t, r)) {
        skipped.push(typeof (row as { id?: unknown })?.id === 'string' ? (row as { id: string }).id : '')
        continue
      }
      statements.push(...buildRowStatements(db, t, r))
    }
  }
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + STATEMENTS_PER_BATCH))
  }
  return c.json({ ok: true, skipped })
})

app.get('/api/sync', async (c) => {
  const since = Number(c.req.query('since') ?? '0')
  if (Number.isNaN(since) || since < 0) return c.json({ error: 'invalid since' }, 400)
  const space = c.req.header('x-sync-space') ?? ''
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

app.post('/api/accent/lookup', async (c) => {
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

app.post('/api/share', async (c) => {
  const body = await c.req.json<{ name?: unknown; rows?: unknown }>().catch(() => null)
  if (body === null || typeof body.name !== 'string' || body.name.trim() === '') {
    return c.json({ error: 'name is required' }, 400)
  }
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
  if (payload.length > 1_000_000) return c.json({ error: 'payload too large' }, 400)
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
  const row = await c.env.DB.prepare('SELECT name, payload FROM shares WHERE code = ?')
    .bind(code).first<{ name: string; payload: string }>().catch(() => null)
  if (row === null) return shell
  const count = (JSON.parse(row.payload) as unknown[]).length
  const meta =
    `<meta property="og:title" content="${escapeHtml(row.name)} — 字卡牌組分享">` +
    `<meta property="og:description" content="${count} 個單字,點開直接匯入">` +
    `<meta property="og:type" content="website">`
  return new HTMLRewriter()
    .on('head', { element(el) { el.append(meta, { html: true }) } })
    .transform(shell)
})

app.get('/api/share/:code', async (c) => {
  const row = await c.env.DB.prepare('SELECT name, payload FROM shares WHERE code = ?')
    .bind(c.req.param('code')).first<{ name: string; payload: string }>()
  if (row === null) return c.json({ error: 'not found' }, 404)
  return c.json({ name: row.name, rows: JSON.parse(row.payload) })
})

export default app
