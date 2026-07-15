# 同步金鑰(sync namespace)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓同一個 D1 部署上「不同同步金鑰 = 不同的獨立資料空間」,朋友設自己的金鑰即擁有與擁有者完全分開的複習紀錄。

**Architecture:** D1 四張同步表加一個**只存在伺服器**的 `namespace` 欄。客戶端把金鑰放 HTTP header `x-sync-space` 送出;伺服器 push 時把該批列標成該 namespace、pull 時 `WHERE namespace = ? AND server_seq > ?` 並剝除 namespace。金鑰存在客戶端 Dexie `meta.sync_space`。擁有者現有 869 筆用一次性後端 `UPDATE` 搬進私密金鑰。

**Tech Stack:** TypeScript / React / Dexie(IndexedDB)/ Hono on Cloudflare Workers / D1 / Vitest + @cloudflare/vitest-pool-workers。

## Global Constraints

- UI 文案 zh-TW;錯誤訊息 zh-TW。時間戳 epoch 毫秒;布林 `0|1`;軟刪除墓碑。
- 使用者寫入走 repo;同步/備份/本設定為既有例外。conventional commits,結尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- **namespace 只在伺服器**:客戶端本地(Dexie)不新增欄位、不儲存 namespace。
- 金鑰經 HTTP header **`x-sync-space`** 傳送;空或未帶 = namespace `''`(預設空間)。伺服器為權威方:push 一律以 header 值覆蓋每列 namespace(忽略 client 送的值);pull 依 header 值過濾並**剝除 `namespace` 與 `server_seq`**。
- 金鑰存客戶端 `meta`,key = `sync_space`(字串)。**換金鑰要重置 `sync_cursor`**(游標歸零、下次全量重拉)。
- `accent_dict` 不分區、不動。全域 `server_seq` 計數器維持共用、單調遞增(跨 namespace 的 gap 無害)。
- 同一 namespace 內:LWW upsert(較新蓋較舊、同/舊時間戳忽略)、review_logs 以 id 冪等(`INSERT OR IGNORE`)—— 語意皆不變。
- 既有 worker 測試單一已知/可接受的 miniflare compat-date 警告以外,輸出須乾淨。
- 安全定位:輕量分區,非帳號驗證(知道金鑰者可存取該空間)。不在此範圍實作 SYNC_TOKEN/登入。

## 檔案結構

**新增:**
- `migrations/0003_namespace.sql` — 四張表 `ADD COLUMN namespace` + `(namespace, server_seq)` 複合索引。
- `src/lib/space.ts` — 金鑰讀寫與清空本機:`getSyncSpace` / `setSyncSpace` / `clearLocalData`。

**修改:**
- `worker/index.ts` — `TABLE_COLS` 四張表加 `'namespace'`;`POST /api/sync` 讀 header 並注入 namespace;`GET /api/sync` 依 header 過濾 + 剝除 namespace。
- `worker/sync.spec.ts` — 補 namespace 隔離測試。
- `src/db/db.ts` — `MetaRow.value` 放寬為 `number | string`。
- `src/lib/sync.ts` — 讀金鑰、push/pull 都帶 `x-sync-space` header。
- `test/sync.test.ts` — 補 header/換金鑰/清空本機測試。
- `src/pages/SettingsPage.tsx` — 同步金鑰區塊 + 清空本機。
- `README.md` — 金鑰用法 / 搬移步驟 / 安全說明。

---

## Task 1: 伺服器 namespace 分區(migration + worker + 測試)

在伺服器端加 namespace:schema、push 標記、pull 過濾/剝除,並用 worker 測試證明空間隔離。純伺服器改動,可獨立測試。

**Files:**
- Create: `migrations/0003_namespace.sql`
- Modify: `worker/index.ts`(`TABLE_COLS`、`app.post('/api/sync')`、`app.get('/api/sync')`)
- Test: `worker/sync.spec.ts`

**Interfaces:**
- Produces:
  - D1 四表各有 `namespace TEXT NOT NULL DEFAULT ''`。
  - `POST /api/sync`:讀 header `x-sync-space`(預設 `''`),把 body 每列 namespace 設為該值後 upsert。
  - `GET /api/sync?since=`:讀 header `x-sync-space`,回 `WHERE namespace = ? AND server_seq > ?` 的列,並剝除 `namespace` 與 `server_seq`;頂層 `seq` 仍為全域值。

- [ ] **Step 1: 寫失敗測試 — namespace 隔離**

`worker/sync.spec.ts` 檔案末端、`describe('/api/sync', ...)` 區塊內新增(沿用檔案頂端既有的 `empty`、`deck`、`env`、`app`):

```ts
  // 帶 x-sync-space header 的 push/pull
  async function pushNs(space: string, body: unknown) {
    const res = await app.request('/api/sync', {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-sync-space': space },
    }, env)
    expect(res.status).toBe(200)
  }
  async function pullNs(space: string, since = 0): Promise<any> {
    const res = await app.request(`/api/sync?since=${since}`, { headers: { 'x-sync-space': space } }, env)
    expect(res.status).toBe(200)
    return res.json()
  }

  it('namespace 隔離:A 空間 push 的資料,B 空間與預設空間都看不到', async () => {
    await pushNs('spaceA', { ...empty, decks: [deck({ id: 'da', name: 'A的牌組' })] })
    await pushNs('spaceB', { ...empty, decks: [deck({ id: 'db', name: 'B的牌組' })] })

    const outA = await pullNs('spaceA')
    const outB = await pullNs('spaceB')
    const outDefault = await pull(0) // 無 header = 預設空間 ''

    expect(outA.decks.map((d: { id: string }) => d.id)).toEqual(['da'])
    expect(outB.decks.map((d: { id: string }) => d.id)).toEqual(['db'])
    expect(outDefault.decks).toHaveLength(0)
  })

  it('pull 回傳的列不含 namespace(內部欄位不外洩)', async () => {
    await pushNs('spaceA', { ...empty, decks: [deck({ id: 'da' })] })
    const outA = await pullNs('spaceA')
    expect(outA.decks[0].namespace).toBeUndefined()
    expect(outA.decks[0].server_seq).toBeUndefined()
  })

  it('同一 namespace 內 LWW 仍正確', async () => {
    await pushNs('spaceA', { ...empty, decks: [deck({ id: 'da', updated_at: 1000, name: 'old' })] })
    await pushNs('spaceA', { ...empty, decks: [deck({ id: 'da', updated_at: 2000, name: 'new' })] })
    await pushNs('spaceA', { ...empty, decks: [deck({ id: 'da', updated_at: 1500, name: 'stale' })] })
    const outA = await pullNs('spaceA')
    expect(outA.decks).toHaveLength(1)
    expect(outA.decks[0].name).toBe('new')
  })
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run --config vitest.workers.config.ts worker/sync.spec.ts`
Expected: FAIL — 尚無 namespace 欄/過濾;A、B、預設空間會互相看到對方資料(隔離斷言失敗),且 `namespace` 未被剝除。

- [ ] **Step 3: D1 migration 0003**

Create `migrations/0003_namespace.sql`:

```sql
ALTER TABLE decks ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
ALTER TABLE review_logs ADD COLUMN namespace TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_decks_ns_seq ON decks(namespace, server_seq);
CREATE INDEX idx_notes_ns_seq ON notes(namespace, server_seq);
CREATE INDEX idx_cards_ns_seq ON cards(namespace, server_seq);
CREATE INDEX idx_logs_ns_seq ON review_logs(namespace, server_seq);
```

- [ ] **Step 4: worker — TABLE_COLS 四表加 namespace**

`worker/index.ts` 的 `TABLE_COLS`(第 15-23 行)每張表的欄位陣列**末端加 `'namespace'`**:

```ts
const TABLE_COLS = {
  decks: ['id', 'name', 'new_per_day', 'updated_at', 'deleted', 'namespace'],
  notes: ['id', 'deck_id', 'expression', 'reading', 'meaning', 'accent', 'reversed', 'updated_at', 'deleted', 'namespace'],
  cards: ['id', 'note_id', 'deck_id', 'direction', 'due', 'stability', 'difficulty',
    'elapsed_days', 'scheduled_days', 'learning_steps', 'reps', 'lapses', 'state',
    'last_review', 'updated_at', 'deleted', 'namespace'],
  review_logs: ['id', 'card_id', 'rating', 'state', 'due', 'stability', 'difficulty',
    'elapsed_days', 'last_elapsed_days', 'scheduled_days', 'reviewed_at', 'namespace'],
} as const
```

(`buildRowStatements` 不改:它依 `TABLE_COLS[table]` 逐欄取 `row[c]`,namespace 由下一步的 handler 注入列物件。)

- [ ] **Step 5: worker — POST 注入 namespace**

`worker/index.ts` 的 `app.post('/api/sync', ...)`(第 97-110 行)改為讀 header 並把每列 namespace 設為該值:

```ts
app.post('/api/sync', async (c) => {
  const body = await c.req.json<SyncPush>()
  const space = c.req.header('x-sync-space') ?? ''
  const db = c.env.DB
  const statements: D1PreparedStatement[] = []
  for (const t of ['decks', 'notes', 'cards', 'review_logs'] as const) {
    for (const row of body[t] ?? []) {
      const r = { ...(row as unknown as Record<string, unknown>), namespace: space }
      statements.push(...buildRowStatements(db, t, r))
    }
  }
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + STATEMENTS_PER_BATCH))
  }
  return c.json({ ok: true })
})
```

- [ ] **Step 6: worker — GET 過濾 + 剝除 namespace**

`worker/index.ts` 的 `app.get('/api/sync', ...)`(第 112-130 行)改為讀 header、過濾 namespace、剝除 namespace 與 server_seq:

```ts
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
```

- [ ] **Step 7: 跑測試確認通過**

Run: `npx vitest run --config vitest.workers.config.ts worker/sync.spec.ts`
Expected: PASS(新 3 個 namespace 案例 + 既有案例;既有案例無 header → 在預設空間 `''` push/pull,行為不變)。

Run: `npm run test:worker`
Expected: PASS(accent.spec + sync.spec 全過)。

- [ ] **Step 8: Commit**

```bash
git add migrations/0003_namespace.sql worker/index.ts worker/sync.spec.ts
git commit -m "feat: server-side namespace partitioning for sync (x-sync-space)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: 客戶端金鑰(space.ts + sync.ts header + 測試)

客戶端存/讀金鑰、同步時帶 `x-sync-space` header,並提供換金鑰(重置游標)與清空本機。可用 fake-indexeddb + mock fetch 測試。

**Files:**
- Create: `src/lib/space.ts`
- Modify: `src/db/db.ts`(`MetaRow.value`)、`src/lib/sync.ts`(header)
- Test: `test/sync.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `x-sync-space` 協定。
- Produces:
  - `getSyncSpace(): Promise<string>` — 讀 `meta.sync_space`,無則 `''`。
  - `setSyncSpace(key: string): Promise<void>` — 寫入 `meta.sync_space`(trim),並刪除 `meta.sync_cursor`(游標歸零)。
  - `clearLocalData(): Promise<void>` — 清空 decks/notes/cards/review_logs 與 `meta.sync_cursor`,**保留 `meta.sync_space`**。
  - `syncNow` 的 push POST 與 pull GET 都帶 header `x-sync-space: <目前金鑰>`。

- [ ] **Step 1: 寫失敗測試**

在 `test/sync.test.ts` 末端新增(檔案已 import `db`、`syncNow`,並在 `beforeEach` 重置 DB):

```ts
import { getSyncSpace, setSyncSpace, clearLocalData } from '../src/lib/space'
import { createDeck, createNote } from '../src/db/repo'

describe('sync namespace / space', () => {
  it('syncNow 會在 push 與 pull 都帶上 x-sync-space header', async () => {
    await setSyncSpace('space1')
    await createDeck('要推送的牌組') // 造一筆 dirty 資料,強制 push

    const seen: { url: string; space: string | null }[] = []
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({ url: String(input), space: headers.get('x-sync-space') })
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true }))
      return new Response(JSON.stringify({ decks: [], notes: [], cards: [], review_logs: [], seq: 0 }))
    }) as unknown as typeof fetch

    const r = await syncNow(fetchFn)
    expect(r.ok).toBe(true)
    const post = seen.find((s) => s.url === '/api/sync')
    const get = seen.find((s) => s.url.startsWith('/api/sync?since='))
    expect(post?.space).toBe('space1')
    expect(get?.space).toBe('space1')
  })

  it('setSyncSpace 寫入金鑰並把 sync_cursor 歸零', async () => {
    await db.meta.put({ key: 'sync_cursor', value: 42 })
    await setSyncSpace('  mykey  ')
    expect(await getSyncSpace()).toBe('mykey') // 有 trim
    expect(await db.meta.get('sync_cursor')).toBeUndefined()
  })

  it('clearLocalData 清空四表與游標,但保留金鑰', async () => {
    await setSyncSpace('keepme')
    const deck = await createDeck('A')
    await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' })
    await db.meta.put({ key: 'sync_cursor', value: 7 })

    await clearLocalData()

    expect(await db.decks.count()).toBe(0)
    expect(await db.notes.count()).toBe(0)
    expect(await db.cards.count()).toBe(0)
    expect(await db.review_logs.count()).toBe(0)
    expect(await db.meta.get('sync_cursor')).toBeUndefined()
    expect(await getSyncSpace()).toBe('keepme')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run --config vitest.config.ts test/sync.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/space'`,或 header 為 null(sync.ts 尚未帶 header)。

- [ ] **Step 3: 放寬 MetaRow.value 型別**

`src/db/db.ts` 的 `MetaRow`(第 5 行)改為允許字串(金鑰是字串;既有數值用途以 template string / `Date()` 使用,不受影響):

```ts
export interface MetaRow { key: string; value: number | string }
```

- [ ] **Step 4: 實作 space.ts**

Create `src/lib/space.ts`:

```ts
import { db } from '../db/db'

/** 讀取本機同步金鑰;未設為空字串(預設空間)。 */
export async function getSyncSpace(): Promise<string> {
  const row = await db.meta.get('sync_space')
  return typeof row?.value === 'string' ? row.value : ''
}

/** 設定同步金鑰並把同步游標歸零(下次全量重拉新空間)。 */
export async function setSyncSpace(key: string): Promise<void> {
  await db.transaction('rw', [db.meta], async () => {
    await db.meta.put({ key: 'sync_space', value: key.trim() })
    await db.meta.delete('sync_cursor')
  })
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
```

- [ ] **Step 5: sync.ts 帶上 header**

`src/lib/sync.ts`:

(a) 檔頭 import 區加:

```ts
import { getSyncSpace } from './space'
```

(b) `syncNow` 函式開頭、`navigator.onLine` 檢查之後,取得金鑰:

```ts
export async function syncNow(fetchFn: typeof fetch = fetch): Promise<SyncResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, skipped: true }
  const space = await getSyncSpace()
  try {
```

(c) push 的 POST(現為 `headers: { 'content-type': 'application/json' }`)加上金鑰 header:

```ts
        const res = await fetchFn('/api/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sync-space': space },
          body: JSON.stringify(body),
        })
```

(d) pull 的 GET(現為 `fetchFn(\`/api/sync?since=${since}\`)`)加上金鑰 header:

```ts
    const res = await fetchFn(`/api/sync?since=${since}`, { headers: { 'x-sync-space': space } })
```

- [ ] **Step 6: 跑測試確認通過**

Run: `npx vitest run --config vitest.config.ts test/sync.test.ts`
Expected: PASS(3 個新案例 + 既有 syncNow 案例;既有案例未設金鑰 → header 為 `''`,fake server 忽略 header,行為不變)。

Run: `npm test`
Expected: PASS(全部前端測試)。

Run: `npm run build`
Expected: 成功(若 `MetaRow.value` 放寬導致某處數值用法型別報錯,於該處最小修正 —— 例如以 `Number(x)` 或 `as number` 收斂 —— 保持 build 綠)。

- [ ] **Step 7: Commit**

```bash
git add src/lib/space.ts src/db/db.ts src/lib/sync.ts test/sync.test.ts
git commit -m "feat: client sync key (x-sync-space header, cursor reset, clear-local)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: 設定頁金鑰 UI + 清空本機

設定頁新增「同步金鑰」區塊:顯示/輸入金鑰、儲存(重置游標並同步)、清空本機、注意事項文案。核心 helper 已於 Task 2 測過;本頁以 build + Playwright 驗證(本 repo 無元件測試基礎設施,plan 明訂視覺/流程於 Task 4 實機驗證)。

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `getSyncSpace` / `setSyncSpace` / `clearLocalData`(Task 2);`syncNow`(既有)。

- [ ] **Step 1: 設定頁加金鑰區塊**

`src/pages/SettingsPage.tsx` 全檔改為(在既有「同步」「備份」之間插入「同步金鑰」區塊,並用 `useLiveQuery` 顯示目前金鑰):

```tsx
import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { exportBackup, importBackup } from '../lib/backup'
import { download } from '../lib/download'
import { syncNow } from '../lib/sync'
import { getSyncSpace, setSyncSpace, clearLocalData } from '../lib/space'

export default function SettingsPage() {
  const lastSync = useLiveQuery(() => db.meta.get('last_sync_at'), [])
  const currentSpace = useLiveQuery(() => getSyncSpace(), [])
  const [msg, setMsg] = useState('')
  const [keyInput, setKeyInput] = useState<string | null>(null)

  const doSync = async () => {
    setMsg('同步中…')
    const r = await syncNow()
    setMsg(r.ok ? '✓ 同步完成' : r.skipped ? '目前離線,已跳過' : `同步失敗:${r.error}`)
  }

  const saveKey = async () => {
    const key = (keyInput ?? currentSpace ?? '').trim()
    await setSyncSpace(key)
    setKeyInput(null)
    setMsg('金鑰已更新,同步中…')
    const r = await syncNow()
    setMsg(r.ok ? '✓ 已切換空間並同步完成' : r.skipped ? '金鑰已更新(目前離線)' : `同步失敗:${r.error}`)
  }

  const doClearLocal = async () => {
    if (!confirm('清空本機所有牌組/卡片/複習紀錄(雲端不受影響),之後可用目前金鑰重新同步取回。確定?')) return
    await clearLocalData()
    setMsg('本機已清空,重新同步中…')
    const r = await syncNow()
    setMsg(r.ok ? '✓ 已清空並重新同步' : r.skipped ? '本機已清空(目前離線)' : `同步失敗:${r.error}`)
  }

  return (
    <div>
      <h1>設定</h1>
      <h2>同步</h2>
      <div className="settings-block">
        <p className="hint">
          上次同步:{lastSync ? new Date(lastSync.value).toLocaleString('zh-TW') : '從未'}
        </p>
        <button className="btn" onClick={doSync}>立即同步</button>
        {msg && <p>{msg}</p>}
      </div>

      <h2>同步金鑰</h2>
      <div className="settings-block">
        <label>金鑰(空白 = 預設空間)
          <input value={keyInput ?? currentSpace ?? ''} placeholder="例如一串不好猜的字"
            onChange={(e) => setKeyInput(e.target.value)} />
        </label>
        <div className="form-actions">
          <button className="btn" onClick={saveKey}>儲存金鑰</button>
          <button className="btn danger" onClick={doClearLocal}>清空本機資料</button>
        </div>
        <p className="hint">
          不同金鑰 = 不同的獨立資料空間,可分給朋友各自使用。
          金鑰形同該空間的密碼、經公開網路傳送,並非登入驗證 —— 請用不同且不好猜的金鑰。
          在已有資料的裝置上換金鑰前,建議先「清空本機資料」,避免舊資料混進新空間。
        </p>
      </div>

      <h2>備份</h2>
      <div className="settings-block">
        <button className="btn secondary" onClick={async () =>
          download(`字卡備份-${new Date().toISOString().slice(0, 10)}.json`, await exportBackup(), 'application/json')
        }>下載完整備份(JSON)</button>
        <label>還原備份:
          <input type="file" accept="application/json" onChange={async (e) => {
            const f = e.target.files?.[0]
            if (!f) return
            if (!confirm('還原會清空本機資料,並在下次同步時以備份內容覆蓋雲端與其他裝置,確定?')) return
            try {
              await importBackup(await f.text())
              setMsg('✓ 還原完成,建議立即同步')
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              setMsg(`還原失敗:${message}`)
            }
          }} />
        </label>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 驗證編譯與打包**

Run: `npm run build`
Expected: 成功,無型別錯誤。(金鑰讀寫/清空已在 Task 2 單元測過;本頁流程於 Task 4 以 Playwright 驗證。)

- [ ] **Step 3: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat: sync key settings UI (set key, clear local data, guidance)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: 套 migration、搬移擁有者資料、部署、文件、實機驗證隔離

把功能接上真實環境:套 0003、部署、把擁有者現有 869 筆搬進私密金鑰、驗證第二個空間互不可見、更新 README。

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes:前三個 task 的成果。

- [ ] **Step 1: 套 migration 0003(local + remote)**

```bash
npx wrangler d1 migrations apply anki-pwa --local
npx wrangler d1 migrations apply anki-pwa --remote
```

Expected: `0003_namespace.sql` 兩邊皆 ✅。

- [ ] **Step 2: 部署**

```bash
npm run build
npm run test:worker
npx wrangler deploy
```

Expected: build 綠、worker 測試綠、deploy 印出版本 id 與網址。

- [ ] **Step 3: 選定擁有者金鑰並搬移現有資料(remote)**

選一組不好猜的金鑰(以下用 `OWNER_KEY` 代表,實際填入真值,例如 `sychen-<隨機字串>`)。在 remote 跑一次(把預設空間 `''` 的現有資料移入金鑰):

```bash
npx wrangler d1 execute anki-pwa --remote --command "UPDATE decks SET namespace='OWNER_KEY' WHERE namespace=''; UPDATE notes SET namespace='OWNER_KEY' WHERE namespace=''; UPDATE cards SET namespace='OWNER_KEY' WHERE namespace=''; UPDATE review_logs SET namespace='OWNER_KEY' WHERE namespace='';"
```

驗證:

```bash
npx wrangler d1 execute anki-pwa --remote --command "SELECT namespace, count(*) n FROM notes GROUP BY namespace" --json
```

Expected: 只有一列 `namespace='OWNER_KEY'`、n≈869,`''` 無資料(或 0 列)。

- [ ] **Step 4: 實機驗證(Playwright MCP)— 擁有者空間**

用 Playwright 開部署 URL(需先 unregister 舊 service worker + 清 caches 取得新版):

1. 進設定 → 同步金鑰填入 `OWNER_KEY` → 儲存金鑰 → 立即同步。
2. 回牌組列表 → 應看到「日文單字」869 筆(擁有者資料在金鑰空間內,正常可見)。截圖。
3. `curl` 驗證隔離:
   ```bash
   curl -s -H 'x-sync-space: OWNER_KEY' 'https://anki-pwa.<account>.workers.dev/api/sync?since=0' | head -c 200
   curl -s 'https://anki-pwa.<account>.workers.dev/api/sync?since=0' | head -c 200   # 無 header = 預設空間,應為空
   ```
   Expected:帶 `OWNER_KEY` 有 decks/notes;無 header 的 decks/notes 為空陣列。

- [ ] **Step 5: 實機驗證 — 第二個獨立空間**

1. 設定 → 「清空本機資料」→ 確認(模擬另一人的乾淨裝置)。
2. 同步金鑰改填 `friendtest` → 儲存金鑰 → 立即同步。
3. 牌組列表 → 應為**空**(friendtest 是全新空間,看不到擁有者的資料)。截圖。
4. 建一個新牌組(如「朋友的牌組」)→ 立即同步。
5. `curl -s -H 'x-sync-space: friendtest' '<URL>/api/sync?since=0'` → 只有「朋友的牌組」;`curl -H 'x-sync-space: OWNER_KEY'` 仍只有擁有者的、看不到 friendtest 的。
6. **收尾**:設定金鑰改回 `OWNER_KEY` → 清空本機 → 立即同步 → 確認 869 筆回來。截圖。並清掉測試資料:
   ```bash
   npx wrangler d1 execute anki-pwa --remote --command "DELETE FROM decks WHERE namespace='friendtest'; DELETE FROM notes WHERE namespace='friendtest'; DELETE FROM cards WHERE namespace='friendtest'; DELETE FROM review_logs WHERE namespace='friendtest';"
   ```

- [ ] **Step 6: 更新 README**

`README.md`:「功能」清單加一項、並在「啟用 SYNC_TOKEN 上鎖」之前新增章節:

```markdown
## 同步金鑰(多人分開使用)

同一個部署上,不同「同步金鑰」= 不同的獨立資料空間。設定頁「同步金鑰」填入一組字串即進入該空間;空白 = 預設空間。把 App 分給朋友時,請他設一組**自己的、不好猜的**金鑰,他的複習紀錄就與你完全分開。

- 金鑰存在各裝置本機(不同步);同一個人的多台裝置要填**相同**金鑰才會同步到一起。
- 換金鑰前,若該裝置已有其他空間的資料,先按「清空本機資料」(只清本機,雲端不受影響),避免混入新空間。
- 安全性:金鑰形同該空間的密碼、經公開 API 傳送,**不是登入驗證** —— 知道金鑰的人即可存取該空間。要更硬的隔離請改上 `SYNC_TOKEN`(見下)或自行加入登入。
```

「功能」清單加:

```markdown
- 同步金鑰:同一部署上以金鑰切分獨立資料空間,可分給不同人各自使用
```

- [ ] **Step 7: Commit + 最終回歸**

```bash
git add README.md
git commit -m "docs: sync key (namespace) usage and security notes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Run: `npm test`、`npm run test:worker`、`npm run build`
Expected: 全綠。回報:前端/worker 測試數、隔離驗證摘要(擁有者空間 869、friendtest 隔離、收尾回復 869)、remote `notes` 依 namespace 的分佈。

---

## Self-Review(對照 spec)

- **namespace 只在伺服器 + header 協定**(spec §資料模型/§同步協定):Task 1 ✅
- **push 標記 / pull 過濾 + 剝除 namespace 與 server_seq**(spec §同步協定):Task 1 Step 5-6 ✅
- **金鑰存 meta.sync_space / 換金鑰重置游標 / 清空本機**(spec §客戶端變更):Task 2 space.ts ✅
- **push+pull 帶 x-sync-space header**(spec §同步協定):Task 2 Step 5 ✅
- **設定頁金鑰 UI + 清空本機 + 安全文案**(spec §設定頁 UI):Task 3 ✅
- **擁有者資料一次性後端 UPDATE 搬移 + rollout 順序**(spec §擁有者資料搬移):Task 4 Step 3、5 收尾清殘留 ✅
- **accent_dict 不分區**(spec §資料模型):三個 task 皆未觸及 accent_dict ✅
- **向下相容(無 header → '')**(spec §向下相容):Task 1 既有測試無 header 仍過 ✅
- **測試:namespace 隔離 / 同空間 LWW / review_logs 冪等 / pull 不含 namespace(worker);header/換金鑰/清空(前端);實機隔離(Playwright)**(spec §測試):Task 1、2、4 ✅
- **安全誠實面 / 非目標(不做登入)**(spec §安全/§非目標):文案(Task 3、Task 4 README)點明;未實作登入 ✅

型別一致性:`getSyncSpace`/`setSyncSpace`/`clearLocalData`、header `x-sync-space`、`meta.sync_space`、`MetaRow.value: number | string` 跨 task 一致。namespace 為 server-only、client 端不出現於資料列,與 Task 2 不改 Dexie schema 一致。
