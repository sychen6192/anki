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
  if (table === 'review_logs') {
    const existing = await db.prepare('SELECT id FROM review_logs WHERE id = ?').bind(row.id).first()
    if (existing) return
  } else {
    const existing = await db.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`)
      .bind(row.id).first<{ updated_at: number }>()
    if (existing && existing.updated_at >= (row.updated_at as number)) return // LWW:較舊或同時間戳忽略
  }
  const cols = [...TABLE_COLS[table], 'server_seq']
  const seq = await nextSeq(db)
  await db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(...TABLE_COLS[table].map((c) => (row[c] === undefined ? null : row[c])), seq)
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
