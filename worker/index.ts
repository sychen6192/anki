import { Hono } from 'hono'
import type {
  CardRecord, DeckRecord, NoteRecord, ReviewLogRecord, SyncPush, SyncPullResponse,
} from '../shared/types'

export type Env = { DB: D1Database }

const app = new Hono<{ Bindings: Env }>()

// 之後要上鎖:`wrangler secret put SYNC_TOKEN` 並取消下行註解(Env 加 SYNC_TOKEN: string)
// app.use('/api/*', async (c, next) => { if (c.req.header('x-sync-token') !== c.env.SYNC_TOKEN) return c.text('unauthorized', 401); await next() })

app.get('/api/health', (c) => c.json({ ok: true }))

const TABLE_COLS = {
  decks: ['id', 'name', 'new_per_day', 'updated_at', 'deleted'],
  notes: ['id', 'deck_id', 'expression', 'reading', 'meaning', 'reversed', 'updated_at', 'deleted'],
  cards: ['id', 'note_id', 'deck_id', 'direction', 'due', 'stability', 'difficulty',
    'elapsed_days', 'scheduled_days', 'learning_steps', 'reps', 'lapses', 'state',
    'last_review', 'updated_at', 'deleted'],
  review_logs: ['id', 'card_id', 'rating', 'state', 'due', 'stability', 'difficulty',
    'elapsed_days', 'last_elapsed_days', 'scheduled_days', 'reviewed_at'],
} as const

type TableName = keyof typeof TABLE_COLS

async function nextSeq(db: D1Database): Promise<number> {
  const row = await db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'seq' RETURNING value")
    .first<{ value: number }>()
  return row!.value
}

async function upsertRow(db: D1Database, table: TableName, row: Record<string, unknown>): Promise<void> {
  // seq is allocated up front, before we know whether this row will actually be
  // written (the LWW/idempotency check below may cause it to be ignored). That
  // leaves a harmless gap in server_seq for ignored rows — pull's cursor semantics
  // only rely on server_seq being monotonically increasing, not contiguous, so gaps
  // are safe.
  const seq = await nextSeq(db)
  const cols = TABLE_COLS[table]
  const allCols = [...cols, 'server_seq']
  const placeholders = allCols.map(() => '?').join(', ')
  const values = [...cols.map((c) => (row[c] === undefined ? null : row[c])), seq]

  if (table === 'review_logs') {
    // review_logs are immutable events keyed by id: atomic no-op on duplicate id.
    await db.prepare(`INSERT OR IGNORE INTO review_logs (${allCols.join(', ')}) VALUES (${placeholders})`)
      .bind(...values)
      .run()
    return
  }

  // Atomic LWW upsert: a single statement replaces the previous SELECT-then-INSERT
  // OR REPLACE, so two near-simultaneous pushes to the same row can no longer
  // interleave a stale write over a newer one — the "is this row newer?" check and
  // the write happen as one statement, not as separate round trips a race could
  // land between. New id -> inserted. Existing id with strictly newer updated_at ->
  // updated. Existing id with older/equal updated_at -> WHERE clause false, DO
  // UPDATE is skipped, row is left untouched (LWW: 較舊或同時間戳忽略).
  const updateSet = cols.map((c) => `${c} = excluded.${c}`).concat('server_seq = excluded.server_seq').join(', ')
  await db.prepare(`
    INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${updateSet}
    WHERE excluded.updated_at > ${table}.updated_at
  `)
    .bind(...values)
    .run()
}

app.post('/api/sync', async (c) => {
  const body = await c.req.json<SyncPush>()
  for (const t of ['decks', 'notes', 'cards', 'review_logs'] as const) {
    for (const row of body[t] ?? []) {
      await upsertRow(c.env.DB, t, row as unknown as Record<string, unknown>)
    }
  }
  return c.json({ ok: true })
})

app.get('/api/sync', async (c) => {
  const since = Number(c.req.query('since') ?? '0')
  if (Number.isNaN(since) || since < 0) return c.json({ error: 'invalid since' }, 400)
  const db = c.env.DB
  const pullTable = async <T>(table: TableName): Promise<T[]> => {
    const res = await db.prepare(`SELECT * FROM ${table} WHERE server_seq > ?`).bind(since)
      .all<T & { server_seq: number }>()
    return res.results.map(({ server_seq: _s, ...rest }) => rest as unknown as T)
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

export default app
