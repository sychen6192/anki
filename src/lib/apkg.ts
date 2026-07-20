import { unzipSync } from 'fflate'
import { decompress as zstdDecompress } from 'fzstd'
import type { Database, SqlJsStatic } from 'sql.js'

export interface ApkgNotetype { id: string; name: string; fieldNames: string[]; noteCount: number }
export interface ApkgNote { notetypeId: string; fields: string[] }
export interface ApkgParse {
  notetypes: ApkgNotetype[]
  notes: ApkgNote[]
  /** apkg 內卡片最多的牌組名(人類可讀,巢狀用 ::),用來當預設牌組名稱 */
  deckName: string
}

/**
 * Anki 匯出時「一律」會塞一份假的 collection.anki2(裡面只有一筆「請更新 Anki」的提示 note),
 * 所以必須依新到舊的順序取第一個存在的檔案,不能先看 collection.anki2。
 */
const COLLECTION_FILES: { name: string; zstd: boolean }[] = [
  { name: 'collection.anki21b', zstd: true },
  { name: 'collection.anki21', zstd: false },
  { name: 'collection.anki2', zstd: false },
]

const FIELD_SEP = '\u001f'

export type SqlLoader = () => Promise<SqlJsStatic>

let sqlPromise: Promise<SqlJsStatic> | null = null

/** 瀏覽器端:動態載入 sql.js 與它的 wasm(不進 PWA precache,體積約 1.2MB)。 */
const loadSqlInBrowser: SqlLoader = () => {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
        import('sql.js'),
        import('sql.js/dist/sql-wasm.wasm?url'),
      ])
      return initSqlJs({ locateFile: () => wasmUrl })
    })().catch((e) => { sqlPromise = null; throw e })
  }
  return sqlPromise
}

function queryRows(db: Database, sql: string): unknown[][] {
  const res = db.exec(sql)
  return res.length > 0 ? res[0].values : []
}

function tableExists(db: Database, name: string): boolean {
  return queryRows(db, `SELECT 1 FROM sqlite_master WHERE type='table' AND name='${name}'`).length > 0
}

/** 新版 schema(18)把名稱放在純文字欄位,不需要解 protobuf。 */
function readNewSchemaNotetypes(db: Database): Map<string, { name: string; fieldNames: string[] }> {
  const out = new Map<string, { name: string; fieldNames: string[] }>()
  for (const [id, name] of queryRows(db, 'SELECT id, name FROM notetypes')) {
    out.set(String(id), { name: String(name ?? ''), fieldNames: [] })
  }
  for (const [ntid, name] of queryRows(db, 'SELECT ntid, name FROM fields ORDER BY ntid, ord')) {
    out.get(String(ntid))?.fieldNames.push(String(name ?? ''))
  }
  return out
}

/** 舊版 schema(11)把所有 notetype 塞在 col.models 這個 JSON 欄位裡。 */
function readLegacyNotetypes(db: Database): Map<string, { name: string; fieldNames: string[] }> {
  const out = new Map<string, { name: string; fieldNames: string[] }>()
  const row = queryRows(db, 'SELECT models FROM col LIMIT 1')[0]
  if (!row) return out
  let models: Record<string, { name?: string; flds?: { name?: string; ord?: number }[] }>
  try {
    models = JSON.parse(String(row[0] ?? '{}'))
  } catch {
    return out
  }
  for (const [id, model] of Object.entries(models)) {
    const flds = [...(model.flds ?? [])].sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0))
    out.set(String(id), { name: String(model.name ?? ''), fieldNames: flds.map((f) => String(f.name ?? '')) })
  }
  return out
}

/** 新版 decks.name 的巢狀分隔符是 0x1f,不是 ::;舊版 col.decks JSON 則已經是 ::。 */
function readMainDeckName(db: Database): string {
  const top = queryRows(
    db,
    `SELECT CASE WHEN odid != 0 THEN odid ELSE did END AS home, COUNT(*) AS n
     FROM cards GROUP BY home ORDER BY n DESC LIMIT 1`,
  )[0]
  if (!top) return ''
  const deckId = String(top[0])

  if (tableExists(db, 'decks')) {
    const row = queryRows(db, `SELECT name FROM decks WHERE id = ${deckId}`)[0]
    return row ? String(row[0] ?? '').replace(/\u001f/g, '::') : ''
  }
  const col = queryRows(db, 'SELECT decks FROM col LIMIT 1')[0]
  if (!col) return ''
  try {
    const decks: Record<string, { name?: string }> = JSON.parse(String(col[0] ?? '{}'))
    return String(decks[deckId]?.name ?? '')
  } catch {
    return ''
  }
}

function readCollection(db: Database): ApkgParse {
  if (!tableExists(db, 'notes')) throw new Error('這個檔案裡沒有 Anki 的 notes 資料表')

  const types = tableExists(db, 'notetypes') ? readNewSchemaNotetypes(db) : readLegacyNotetypes(db)

  const notes: ApkgNote[] = []
  const counts = new Map<string, number>()
  for (const [mid, flds] of queryRows(db, 'SELECT mid, flds FROM notes')) {
    const notetypeId = String(mid)
    notes.push({ notetypeId, fields: String(flds ?? '').split(FIELD_SEP) })
    counts.set(notetypeId, (counts.get(notetypeId) ?? 0) + 1)
  }

  const notetypes: ApkgNotetype[] = [...counts.entries()]
    .map(([id, noteCount]) => {
      const t = types.get(id)
      const widest = Math.max(0, ...notes.filter((n) => n.notetypeId === id).map((n) => n.fields.length))
      // notetype 被改過時,note 的欄位數可能和目前定義不同 — 用序號補齊,讓使用者仍能對應
      const fieldNames = [...(t?.fieldNames ?? [])]
      while (fieldNames.length < widest) fieldNames.push(`欄位 ${fieldNames.length + 1}`)
      return { id, name: t?.name || `樣板 ${id}`, fieldNames, noteCount }
    })
    .sort((a, b) => b.noteCount - a.noteCount)

  return { notetypes, notes, deckName: tableExists(db, 'cards') ? readMainDeckName(db) : '' }
}

function extractCollectionBytes(apkg: Uint8Array): Uint8Array {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(apkg)
  } catch {
    throw new Error('這不像是 Anki 牌組檔(.apkg):無法解開壓縮檔')
  }
  for (const { name, zstd } of COLLECTION_FILES) {
    const raw = files[name]
    if (!raw) continue
    if (!zstd) return raw
    try {
      return zstdDecompress(raw)
    } catch {
      throw new Error(`無法解壓縮 ${name}(zstd 解壓失敗)`)
    }
  }
  throw new Error('這不像是 Anki 牌組檔(.apkg):裡面找不到 collection 資料')
}

/** 解析 .apkg 位元組,取出 note 文字與欄位名稱。不含排程、媒體與 tags。 */
export async function parseApkg(apkg: Uint8Array, loadSql: SqlLoader = loadSqlInBrowser): Promise<ApkgParse> {
  const bytes = extractCollectionBytes(apkg)
  const SQL = await loadSql()
  let db: Database
  try {
    db = new SQL.Database(bytes)
  } catch {
    throw new Error('collection 檔案不是有效的 SQLite 資料庫')
  }
  try {
    return readCollection(db)
  } finally {
    db.close()
  }
}
