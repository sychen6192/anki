# 日文重音(ピッチアクセント)功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 為既有的 Anki-like PWA 加上日文重音標註 — 資料存 `notes.accent`,由 kanjium 字典(上雲 D1)自動查詢並可手動修改,複習卡與編輯器以「高低線圖 + 數字」呈現。

**Architecture:** `notes` 加一個 `accent: string` 欄位隨既有逐筆 LWW 同步走。D1 新增唯讀參考表 `accent_dict`(kanjium 12.4 萬筆),透過新的公開端點 `POST /api/accent/lookup` 三段式查詢(漢字+読み精確 → 読み唯一解 → 去尾「な」)。顯示層 `src/lib/pitch.ts` 是純函式(拍切分 + 高低 pattern),`<PitchAccent>` 只負責把 pattern 映成 span。自動標註有三個入口:CSV 匯入頁、筆記編輯器、牌組「自動標註重音」按鈕,一律經 repo 寫入。

**Tech Stack:** TypeScript / React 19 / Vite / Dexie(IndexedDB)/ Hono on Cloudflare Workers / D1(SQLite)/ Vitest + @cloudflare/vitest-pool-workers。

## Global Constraints

以下為既有系統的專案級規則(copy 自 spec 與前次計畫),**每個 task 都隱含適用**:

- UI 文案一律 **zh-TW**(繁體中文);錯誤訊息也是。
- 時間戳一律 **epoch 毫秒**(`Date.now()`);布林一律 **`0 | 1`**(IndexedDB 不索引真布林)。
- 刪除一律 **軟刪除**(`deleted = 1` 墓碑),不做實體刪除。
- 所有使用者寫入一律經 **`src/db/repo.ts`** 的函式(唯一例外:`src/lib/sync.ts` 同步合併、`src/lib/backup.ts` 還原)。寫入時設 `dirty: 1` 並推進 `updated_at`。
- 新 id 一律 `crypto.randomUUID()`。
- commit 訊息用 **conventional commits**(`feat:` / `fix:` / `test:` / `docs:` / `refactor:`),結尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 重音字串合法格式:**`/^\d+(,\d+)*$/` 或空字串 `''`**。空字串 = 未標註。
- 同步 API 維持公開無驗證(既有已接受風險;`SYNC_TOKEN` 預留在 `worker/index.ts` 註解)。**本功能新端點 `/api/accent/lookup` 同樣公開唯讀,不新增驗證。**
- 每個 db.batch() 分批上限沿用既有 `STATEMENTS_PER_BATCH = 100`。
- lookup 單次請求 items 上限 **200**;前端超過自動分批。
- Vitest 前端測試檔在 `test/`(node env + `fake-indexeddb`);Worker 測試檔在 `worker/*.spec.ts`(`@cloudflare/vitest-pool-workers`)。
- 每個 task 收尾前跑一次完整相關測試,輸出必須乾淨(無多餘 warning)。

## 檔案結構(本功能新增/修改)

**新增:**
- `migrations/0002_accent.sql` — `ALTER notes ADD accent` + `accent_dict` 表 + 索引。
- `src/lib/pitch.ts` — `splitMorae` / `pitchPattern`(純函式,拍切分與高低 pattern)。
- `src/components/PitchAccent.tsx` — 顯示元件(reading + accent → 線圖 + 數字)。
- `src/lib/accent.ts` — client 端:`isValidAccent` / `lookupAccents` / `fillMissingAccents`。
- `scripts/build-accent-dict.mjs` — 從 kanjium `accents.txt` 產出 `scripts/accent-dict.sql`(gitignore)。
- `test/pitch.test.ts`、`test/accent.test.ts`、`worker/accent.spec.ts` — 測試。

**修改:**
- `shared/types.ts` — `NoteRecord` 加 `accent: string`。
- `src/db/db.ts` — Dexie version 2 upgrade(舊 notes 補 `accent: ''`)。
- `worker/index.ts` — `TABLE_COLS.notes` 加 `accent` + `COL_DEFAULTS` 向下相容 + lookup 端點。
- `src/db/repo.ts` — `NoteInput` 加 `accent`,三個寫入函式帶上 accent。
- `src/lib/csv.ts` — 重音欄別名 / mapRows / exportCsv。
- `src/pages/ImportPage.tsx` — 匯入時自動標註。
- `src/pages/DeckDetail.tsx` — 編輯器重音欄 + 預覽 + 自動查詢;牌組「自動標註重音」按鈕。
- `src/pages/Review.tsx` — 答案面 reading 改用 `<PitchAccent>`。
- `src/styles.css` — `.pitch` 系列樣式。
- `.gitignore`、`README.md`、`vocab.csv`(修 `到着` 読み)。

---

## Task 1: 資料模型 — accent 欄位貫穿 types / DB / worker / repo

把 `accent: string` 加到 note 資料模型的每一層,讓欄位「存在且會同步」,同時保持整個專案編譯與測試綠燈。這是後續所有 task 的地基。

**Files:**
- Modify: `shared/types.ts`(`NoteRecord`)
- Create: `migrations/0002_accent.sql`
- Modify: `src/db/db.ts`(Dexie version 2)
- Modify: `worker/index.ts`(`TABLE_COLS`、`COL_DEFAULTS`、`buildRowStatements`)
- Modify: `src/db/repo.ts`(`NoteInput`、`createNote`、`createNotes`、`updateNote`)
- Modify: `test/csv.test.ts`(既有 `NoteRecord` 字面值補 `accent`,僅為編譯;斷言不變)
- Test: `test/repo.test.ts`(新增 accent 持久化案例)、`worker/sync.spec.ts`(新增 accent round-trip)

**Interfaces:**
- Produces:
  - `NoteRecord.accent: string`(合法值 `/^\d+(,\d+)*$/` 或 `''`)
  - `NoteInput = { expression: string; reading: string; meaning: string; reversed: boolean; accent: string }`
  - `createNote(deckId, input)` / `createNotes(deckId, inputs)` / `updateNote(id, patch)` 皆讀寫 `accent`
  - D1 `notes.accent TEXT NOT NULL DEFAULT ''`、表 `accent_dict(expression, reading, pitch)` + `idx_accent_dict_reading`
  - worker 對 push 中缺 `accent` 的 note 以 `''` 補上(向下相容)

- [ ] **Step 1: 寫失敗測試 — repo 持久化 accent**

在 `test/repo.test.ts` 的 `describe('note 與卡片生成', ...)` 內新增:

```ts
  it('createNote 儲存 accent;updateNote 可更新 accent', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '食べる', reading: 'たべる', meaning: '吃', reversed: false, accent: '2' })
    expect((await db.notes.get(note.id))!.accent).toBe('2')
    await updateNote(note.id, { accent: '0,3' })
    expect((await db.notes.get(note.id))!.accent).toBe('0,3')
  })
```

同時把該檔已存在的每個 `createNote(...)` / `createNotes(...)` 呼叫都補上 `accent: ''`(否則型別缺欄位,例如第 35、44、52、60、72、80-84、96 行等各處 `{ expression, reading, meaning, reversed }` 物件)。逐一加 `accent: ''`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run --config vitest.config.ts test/repo.test.ts`
Expected: FAIL — TypeScript 報 `NoteInput`/`NoteRecord` 缺 `accent`,或新案例斷言 `undefined !== '2'`。

- [ ] **Step 3: types.ts 加欄位**

`shared/types.ts` 的 `NoteRecord`(第 6-10 行)改為:

```ts
export interface NoteRecord {
  id: string; deck_id: string
  expression: string; reading: string; meaning: string; reversed: 0 | 1
  accent: string
  updated_at: number; deleted: 0 | 1
}
```

- [ ] **Step 4: D1 migration 0002**

Create `migrations/0002_accent.sql`:

```sql
ALTER TABLE notes ADD COLUMN accent TEXT NOT NULL DEFAULT '';

CREATE TABLE accent_dict (
  expression TEXT NOT NULL,
  reading    TEXT NOT NULL,
  pitch      TEXT NOT NULL,
  PRIMARY KEY (expression, reading)
);
CREATE INDEX idx_accent_dict_reading ON accent_dict(reading);
```

- [ ] **Step 5: Dexie version 2 upgrade**

`src/db/db.ts` 的 constructor 內,在 `this.version(1).stores({...})` 之後接一段 version 2(stores 結構不變,只跑資料 upgrade 補欄位):

```ts
    this.version(2).stores({
      decks: 'id, dirty',
      notes: 'id, deck_id, dirty',
      cards: 'id, note_id, deck_id, due, dirty',
      review_logs: 'id, card_id, reviewed_at, dirty',
      meta: 'key',
    }).upgrade(async (tx) => {
      await tx.table('notes').toCollection().modify((n: { accent?: string }) => { n.accent = '' })
    })
```

- [ ] **Step 6: worker 加欄位 + 向下相容預設**

`worker/index.ts`:

(a) `TABLE_COLS.notes`(第 17 行)在 `'meaning'` 後加 `'accent'`:

```ts
  notes: ['id', 'deck_id', 'expression', 'reading', 'meaning', 'accent', 'reversed', 'updated_at', 'deleted'],
```

(b) 在 `TABLE_COLS` 定義之後、`type TableName` 之前加預設表:

```ts
// 舊 client 不會送 accent;缺欄位的 note 以 '' 補上(notes.accent 是 NOT NULL)。
// 其餘欄位缺值仍走 null(例如 cards.last_review 本來就可 null)。
const COL_DEFAULTS: Partial<Record<TableName, Record<string, unknown>>> = {
  notes: { accent: '' },
}
```

(c) `buildRowStatements` 內的 `const values = ...`(第 48 行)改為套用預設:

```ts
  const values = cols.map((c) => {
    const v = row[c]
    if (v !== undefined) return v
    const def = COL_DEFAULTS[table]?.[c]
    return def !== undefined ? def : null
  })
```

- [ ] **Step 7: repo 帶上 accent**

`src/db/repo.ts`:

(a) `NoteInput`(第 5 行)加 `accent`:

```ts
export interface NoteInput { expression: string; reading: string; meaning: string; reversed: boolean; accent: string }
```

(b) `createNote` 的 note 物件(第 40-44 行)加 `accent: input.accent.trim(),`(放在 `meaning` 之後):

```ts
  const note: Local<NoteRecord> = {
    id: crypto.randomUUID(), deck_id: deckId,
    expression: input.expression.trim(), reading: input.reading.trim(), meaning: input.meaning.trim(),
    accent: input.accent.trim(),
    reversed: input.reversed ? 1 : 0, updated_at: t, deleted: 0, dirty: 1,
  }
```

(c) `createNotes` 的 map(第 55-59 行)同樣加 `accent: input.accent.trim(),`:

```ts
  const notes: Local<NoteRecord>[] = inputs.map((input) => ({
    id: crypto.randomUUID(), deck_id: deckId,
    expression: input.expression.trim(), reading: input.reading.trim(), meaning: input.meaning.trim(),
    accent: input.accent.trim(),
    reversed: input.reversed ? 1 : 0, updated_at: t, deleted: 0, dirty: 1,
  }))
```

(d) `updateNote` 的 `db.notes.update`(第 74-79 行)加 accent(沿用「patch 沒給就保留原值」的模式):

```ts
    await db.notes.update(id, {
      expression: (patch.expression ?? note.expression).trim(),
      reading: (patch.reading ?? note.reading).trim(),
      meaning: (patch.meaning ?? note.meaning).trim(),
      accent: (patch.accent ?? note.accent).trim(),
      reversed, updated_at: t, dirty: 1,
    })
```

- [ ] **Step 8: 修既有 csv.test.ts 的 NoteRecord 字面值(僅編譯)**

`test/csv.test.ts` 的 exportCsv 測試(第 74-77 行)兩個 `NoteRecord` 物件各加 `accent: ''`:

```ts
    const notes = [
      { id: '1', deck_id: 'd', expression: '犬', reading: 'いぬ', meaning: '狗', accent: '', reversed: 0, updated_at: 0, deleted: 0 },
      { id: '2', deck_id: 'd', expression: '猫', reading: 'ねこ', meaning: '貓', accent: '', reversed: 0, updated_at: 0, deleted: 1 },
    ] satisfies NoteRecord[]
```

（此 task 不改 exportCsv 輸出,斷言維持原樣;重音欄在 Task 6 才加。）

- [ ] **Step 9: 寫 worker accent round-trip 測試**

`worker/sync.spec.ts` 的 `describe('/api/sync', ...)` 內新增:

```ts
  it('note 的 accent 會 round-trip;缺 accent 的舊 push 補成空字串', async () => {
    await push({ ...empty, notes: [
      { id: 'n1', deck_id: 'd1', expression: '食べる', reading: 'たべる', meaning: '吃', accent: '2', reversed: 0, updated_at: 1000, deleted: 0 },
      { id: 'n2', deck_id: 'd1', expression: '犬', reading: 'いぬ', meaning: '狗', reversed: 0, updated_at: 1000, deleted: 0 }, // 故意不含 accent
    ] })
    const out = await pull(0)
    const byId = Object.fromEntries(out.notes.map((n: { id: string }) => [n.id, n]))
    expect(byId.n1.accent).toBe('2')
    expect(byId.n2.accent).toBe('')
  })
```

- [ ] **Step 10: 跑測試確認全綠**

Run: `npx vitest run --config vitest.config.ts test/repo.test.ts test/csv.test.ts`
Expected: PASS（含新 accent 案例）。

Run: `npm run test:worker`
Expected: PASS（含新 accent round-trip;既有 8 個案例照過）。

Run: `npm run build`
Expected: 型別檢查 + 打包成功,無錯。

- [ ] **Step 11: Commit**

```bash
git add shared/types.ts migrations/0002_accent.sql src/db/db.ts worker/index.ts src/db/repo.ts test/repo.test.ts test/csv.test.ts worker/sync.spec.ts
git commit -m "feat: add accent field to note model across types, db, worker, repo

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: pitch.ts — 拍切分與高低 pattern(純函式)

顯示重音的核心邏輯,完全純函式、與 React 無關,方便徹底單元測試。

**Files:**
- Create: `src/lib/pitch.ts`
- Test: `test/pitch.test.ts`

**Interfaces:**
- Produces:
  - `splitMorae(reading: string): string[]` — 依拍切分(小假名併前拍;っ/ん/ー 各自成拍)
  - `pitchPattern(moraCount: number, accent: number): { high: boolean[]; dropAfter: number | null } | null` — 高低陣列與降調位置;非法回 `null`

- [ ] **Step 1: 寫失敗測試**

Create `test/pitch.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { splitMorae, pitchPattern } from '../src/lib/pitch'

describe('splitMorae', () => {
  it('小假名(拗音)併入前一拍', () => {
    expect(splitMorae('きょう')).toEqual(['きょ', 'う'])       // 2 拍
    expect(splitMorae('しゅう')).toEqual(['しゅ', 'う'])
  })
  it('促音 っ、撥音 ん、長音 ー 各自成拍', () => {
    expect(splitMorae('がっこう')).toEqual(['が', 'っ', 'こ', 'う']) // 4 拍
    expect(splitMorae('しんぶん')).toEqual(['し', 'ん', 'ぶ', 'ん']) // 4 拍
    expect(splitMorae('ケーキ')).toEqual(['ケ', 'ー', 'キ'])         // 3 拍(片假名長音)
  })
  it('一般假名逐字一拍', () => {
    expect(splitMorae('たべる')).toEqual(['た', 'べ', 'る'])
  })
  it('空字串回空陣列', () => {
    expect(splitMorae('')).toEqual([])
  })
})

describe('pitchPattern', () => {
  it('平板 [0]:第一拍低、其餘高、無降調', () => {
    expect(pitchPattern(3, 0)).toEqual({ high: [false, true, true], dropAfter: null })
  })
  it('頭高 [1]:第一拍高、其後降', () => {
    expect(pitchPattern(3, 1)).toEqual({ high: [true, false, false], dropAfter: 1 })
  })
  it('中高 [2](たべる):第2拍高、第2拍後降', () => {
    expect(pitchPattern(3, 2)).toEqual({ high: [false, true, false], dropAfter: 2 })
  })
  it('尾高 [3](3拍字):第2、3拍高、末拍後降(降在助詞)', () => {
    expect(pitchPattern(3, 3)).toEqual({ high: [false, true, true], dropAfter: 3 })
  })
  it('單拍字 [0] 與 [1]', () => {
    expect(pitchPattern(1, 0)).toEqual({ high: [false], dropAfter: null })
    expect(pitchPattern(1, 1)).toEqual({ high: [true], dropAfter: 1 })
  })
  it('非法輸入回 null:accent 超過拍數、負數、拍數為 0', () => {
    expect(pitchPattern(2, 3)).toBeNull()
    expect(pitchPattern(3, -1)).toBeNull()
    expect(pitchPattern(0, 0)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run --config vitest.config.ts test/pitch.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/pitch'`。

- [ ] **Step 3: 實作 pitch.ts**

Create `src/lib/pitch.ts`:

```ts
// 拗音用的小假名(平/片假名):併入前一拍。促音 っ/ッ、撥音 ん/ン、長音 ー 不在此集合,各自成拍。
const SMALL_KANA = new Set('ゃゅょぁぃぅぇぉゎ' + 'ャュョァィゥェォヮ')

/** 把読み依「拍(mora)」切分。 */
export function splitMorae(reading: string): string[] {
  const morae: string[] = []
  for (const ch of reading) {
    if (SMALL_KANA.has(ch) && morae.length > 0) morae[morae.length - 1] += ch
    else morae.push(ch)
  }
  return morae
}

export interface Pattern { high: boolean[]; dropAfter: number | null }

/**
 * 由拍數與重音數字算高低 pattern。
 * accent(N)語意:0=平板、1=頭高、2..M=中高/尾高(第 N 拍後降)。
 * dropAfter = 降調發生在「第幾拍之後」(1-based);平板為 null。
 * 非法(N<0、N>拍數、拍數為 0、非整數)回 null,由呼叫端只顯示數字不畫線。
 */
export function pitchPattern(moraCount: number, accent: number): Pattern | null {
  if (!Number.isInteger(accent) || accent < 0 || moraCount === 0 || accent > moraCount) return null
  const high = new Array<boolean>(moraCount).fill(false)
  if (accent === 0) {
    for (let i = 1; i < moraCount; i++) high[i] = true
    return { high, dropAfter: null }
  }
  // accent >= 1:第 2..N 拍高(頭高時此迴圈不執行),第 1 拍高僅在頭高成立。
  for (let i = 1; i < accent; i++) high[i] = true
  if (accent === 1) high[0] = true
  return { high, dropAfter: accent }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run --config vitest.config.ts test/pitch.test.ts`
Expected: PASS（全部案例）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/pitch.ts test/pitch.test.ts
git commit -m "feat: add pitch accent mora-splitting and high/low pattern helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: PitchAccent 元件 + 樣式,複習卡答案面套用

把 pitch pattern 映成 span,並在複習卡答案面取代原本純文字読み。元件極薄(邏輯都在 Task 2),以 `npm run build` 與最終 Playwright 驗證。

**Files:**
- Create: `src/components/PitchAccent.tsx`
- Modify: `src/styles.css`(加 `.pitch` 系列)
- Modify: `src/pages/Review.tsx`(第 116 行 reading 顯示)

**Interfaces:**
- Consumes: `splitMorae`、`pitchPattern`(Task 2);`NoteRecord.accent`(Task 1)
- Produces: `<PitchAccent reading={string} accent={string} />` — accent 為空時只顯示純 reading;非空時顯示線圖 + `[數字]`

- [ ] **Step 1: 實作 PitchAccent 元件**

Create `src/components/PitchAccent.tsx`:

```tsx
import { splitMorae, pitchPattern } from '../lib/pitch'

interface Props { reading: string; accent: string }

/**
 * 顯示読み + 重音。accent 為空 → 只顯示純 reading(維持既有外觀)。
 * accent 非空 → 依第一個重音數字畫高低線,並在後面列出 [全部數字]。
 * 多重音(如 "0,3")只畫第一個的線,數字全列。pattern 非法時退回純 reading + 數字。
 */
export function PitchAccent({ reading, accent }: Props) {
  if (accent === '') return <span className="reading">{reading}</span>

  const morae = splitMorae(reading)
  const primary = Number.parseInt(accent.split(',')[0] ?? '', 10)
  const pattern = Number.isNaN(primary) ? null : pitchPattern(morae.length, primary)

  return (
    <span className="pitch reading">
      {pattern ? (
        <span className="pitch-morae">
          {morae.map((m, i) => (
            <span
              key={i}
              className={
                'mora' + (pattern.high[i] ? ' high' : '') + (pattern.dropAfter === i + 1 ? ' drop' : '')
              }
            >
              {m}
            </span>
          ))}
        </span>
      ) : (
        <span>{reading}</span>
      )}
      <span className="pitch-num">[{accent}]</span>
    </span>
  )
}
```

- [ ] **Step 2: 加樣式**

`src/styles.css` 於 `.reading` 規則(第 25 行)之後新增:

```css
.pitch { display: inline-flex; align-items: flex-start; gap: 6px; }
.pitch-morae { display: inline-flex; }
.pitch-morae .mora { border-top: 2px solid transparent; line-height: 1.9; padding: 0 1px; }
.pitch-morae .mora.high { border-top-color: currentColor; }
.pitch-morae .mora.drop { border-right: 2px solid currentColor; }
.pitch-num { font-size: 0.7em; opacity: 0.65; }
```

- [ ] **Step 3: Review 答案面套用**

`src/pages/Review.tsx`:

(a) 檔頭 import 區(第 1-8 行附近)加:

```ts
import { PitchAccent } from '../components/PitchAccent'
```

(b) 第 116 行:

```tsx
            {note.reading !== '' && <p className="reading">{note.reading}</p>}
```

改為:

```tsx
            {note.reading !== '' && <PitchAccent reading={note.reading} accent={note.accent} />}
```

（`<PitchAccent>` 自帶 `reading` class,外層 `<p>` 移除;若版面需要區塊感,元件已是 inline-flex,足夠。）

- [ ] **Step 4: 驗證編譯與打包**

Run: `npm run build`
Expected: 成功,無型別錯誤。（元件的視覺正確性在 Task 10 以 Playwright 驗證。）

- [ ] **Step 5: Commit**

```bash
git add src/components/PitchAccent.tsx src/styles.css src/pages/Review.tsx
git commit -m "feat: render pitch accent (line + number) on review card back

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: accent.ts — client 端查詢與批次填充

前端呼叫 lookup API 的封裝:格式驗證、200 筆自動分批、對缺重音的列批次填充。全部可用 mock fetch 單元測試。

**Files:**
- Create: `src/lib/accent.ts`
- Test: `test/accent.test.ts`

**Interfaces:**
- Produces:
  - `isValidAccent(s: string): boolean` — `''` 或 `/^\d+(,\d+)*$/`
  - `lookupAccents(items: {expression: string; reading: string}[], fetchFn?): Promise<(string | null)[]>` — 與 items 同序,查無為 `null`,超過 200 自動分批
  - `fillMissingAccents<T extends {expression: string; reading: string; accent: string}>(rows: T[], fetchFn?): Promise<{ rows: T[]; filled: number; missed: number }>` — 只查 `accent === ''` 的列,回填新物件(不 mutate 輸入),並回填/查無計數

- [ ] **Step 1: 寫失敗測試**

Create `test/accent.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { isValidAccent, lookupAccents, fillMissingAccents } from '../src/lib/accent'

describe('isValidAccent', () => {
  it('接受空字串與數字/逗號組合,拒絕其他', () => {
    expect(isValidAccent('')).toBe(true)
    expect(isValidAccent('0')).toBe(true)
    expect(isValidAccent('0,3')).toBe(true)
    expect(isValidAccent('12')).toBe(true)
    expect(isValidAccent('a')).toBe(false)
    expect(isValidAccent('1,')).toBe(false)
    expect(isValidAccent('1.5')).toBe(false)
    expect(isValidAccent('[2]')).toBe(false)
  })
})

// 假 fetch:回傳每個 item 的 reading 長度當假 pitch,方便斷言分批與對位。
function fakeFetch(capture: { count: number; batchSizes: number[] }) {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { items: { reading: string }[] }
    capture.count++
    capture.batchSizes.push(body.items.length)
    return new Response(JSON.stringify({ results: body.items.map((it) => String(it.reading.length)) }))
  }) as unknown as typeof fetch
}

describe('lookupAccents', () => {
  it('回傳與輸入同序的結果', async () => {
    const cap = { count: 0, batchSizes: [] as number[] }
    const out = await lookupAccents([{ expression: 'a', reading: 'xx' }, { expression: 'b', reading: 'y' }], fakeFetch(cap))
    expect(out).toEqual(['2', '1'])
    expect(cap.count).toBe(1)
  })
  it('超過 200 筆自動分批,結果仍對位', async () => {
    const cap = { count: 0, batchSizes: [] as number[] }
    const items = Array.from({ length: 250 }, (_, i) => ({ expression: `e${i}`, reading: 'z'.repeat((i % 3) + 1) }))
    const out = await lookupAccents(items, fakeFetch(cap))
    expect(out).toHaveLength(250)
    expect(cap.batchSizes).toEqual([200, 50])
    expect(out[0]).toBe('1')
    expect(out[249]).toBe(String(((249 % 3) + 1)))
  })
  it('HTTP 非 2xx 丟錯', async () => {
    const bad = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(lookupAccents([{ expression: 'a', reading: 'b' }], bad)).rejects.toThrow('lookup failed: 500')
  })
})

describe('fillMissingAccents', () => {
  it('只查 accent 為空的列,回填並計數,已填的保留', async () => {
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { items: { expression: string }[] }
      // 只有 expression 'hit' 查得到
      return new Response(JSON.stringify({ results: body.items.map((it) => (it.expression === 'hit' ? '1' : null)) }))
    }) as unknown as typeof fetch

    const rows = [
      { expression: 'keep', reading: 'a', accent: '2' },   // 已有,不查
      { expression: 'hit', reading: 'b', accent: '' },      // 查得到
      { expression: 'miss', reading: 'c', accent: '' },     // 查無
    ]
    const res = await fillMissingAccents(rows, fetchFn)
    expect(res.rows[0].accent).toBe('2')
    expect(res.rows[1].accent).toBe('1')
    expect(res.rows[2].accent).toBe('')
    expect(res.filled).toBe(1)
    expect(res.missed).toBe(1)
    // 不 mutate 輸入
    expect(rows[1].accent).toBe('')
  })
  it('沒有缺空的列時不呼叫 fetch', async () => {
    const spy = vi.fn()
    const res = await fillMissingAccents([{ expression: 'a', reading: 'b', accent: '0' }], spy as unknown as typeof fetch)
    expect(spy).not.toHaveBeenCalled()
    expect(res).toMatchObject({ filled: 0, missed: 0 })
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run --config vitest.config.ts test/accent.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/accent'`。

- [ ] **Step 3: 實作 accent.ts**

Create `src/lib/accent.ts`:

```ts
const LOOKUP_CHUNK = 200

export function isValidAccent(s: string): boolean {
  return s === '' || /^\d+(,\d+)*$/.test(s)
}

export interface AccentQuery { expression: string; reading: string }

/** 呼叫 /api/accent/lookup;>200 筆自動分批。回傳與 items 同序,查無為 null。 */
export async function lookupAccents(
  items: AccentQuery[], fetchFn: typeof fetch = fetch,
): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(items.length).fill(null)
  for (let i = 0; i < items.length; i += LOOKUP_CHUNK) {
    const slice = items.slice(i, i + LOOKUP_CHUNK)
    const res = await fetchFn('/api/accent/lookup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: slice }),
    })
    if (!res.ok) throw new Error(`lookup failed: ${res.status}`)
    const data = (await res.json()) as { results: (string | null)[] }
    data.results.forEach((r, k) => { out[i + k] = r })
  }
  return out
}

/** 對 accent 為空的列批次查詢並回填(回傳新物件,不 mutate 輸入)。 */
export async function fillMissingAccents<T extends { expression: string; reading: string; accent: string }>(
  rows: T[], fetchFn: typeof fetch = fetch,
): Promise<{ rows: T[]; filled: number; missed: number }> {
  const targets: number[] = []
  rows.forEach((r, i) => { if (r.accent === '') targets.push(i) })
  if (targets.length === 0) return { rows, filled: 0, missed: 0 }

  const results = await lookupAccents(
    targets.map((i) => ({ expression: rows[i].expression, reading: rows[i].reading })), fetchFn,
  )
  const out = rows.map((r) => ({ ...r }))
  let filled = 0, missed = 0
  targets.forEach((i, k) => {
    const pitch = results[k]
    if (pitch != null) { out[i].accent = pitch; filled++ } else missed++
  })
  return { rows: out, filled, missed }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run --config vitest.config.ts test/accent.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/accent.ts test/accent.test.ts
git commit -m "feat: add client accent lookup and batch-fill helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: worker lookup 端點 — 三段式查詢

`POST /api/accent/lookup`:漢字+読み精確 → 読み唯一解 → 去尾「な」。所有 SELECT 走 `db.batch()` 分批,不逐項單發。

**Files:**
- Modify: `worker/index.ts`
- Test: `worker/accent.spec.ts`

**Interfaces:**
- Consumes: `accent_dict` 表(Task 1 migration)
- Produces: `POST /api/accent/lookup`,body `{ items: {expression, reading}[] }`(≤200),回 `{ results: (string|null)[] }`;items 非陣列/空/超過 200/元素缺欄位 → 400

- [ ] **Step 1: 寫失敗測試**

Create `worker/accent.spec.ts`:

```ts
import { env } from 'cloudflare:test'
import { beforeEach, describe, it, expect } from 'vitest'
import app from './index'

async function seed(rows: [string, string, string][]) {
  for (const [expression, reading, pitch] of rows) {
    await env.DB.prepare('INSERT INTO accent_dict (expression, reading, pitch) VALUES (?, ?, ?)')
      .bind(expression, reading, pitch).run()
  }
}

async function lookup(items: unknown): Promise<Response> {
  return app.request('/api/accent/lookup', {
    method: 'POST', body: JSON.stringify({ items }),
    headers: { 'content-type': 'application/json' },
  }, env)
}

beforeEach(async () => {
  await seed([
    ['食べる', 'たべる', '2'],
    ['箸', 'はし', '1'],
    ['橋', 'はし', '2'],        // 同読み不同 pitch → 読み反查應「不猜」
    ['駅', 'えき', '1'],        // 唯一 えき
    ['簡単', 'かんたん', '3'],   // な形容詞去尾後的本體
  ])
})

describe('/api/accent/lookup', () => {
  it('精確命中(漢字+読み)', async () => {
    const res = await lookup([{ expression: '食べる', reading: 'たべる' }])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: ['2'] })
  })

  it('読み反查:唯一解採用,多解不猜(回 null)', async () => {
    const res = await lookup([
      { expression: '駅前', reading: 'えき' },   // 漢字不同但読み唯一 → '1'
      { expression: '端', reading: 'はし' },     // はし 有兩種 pitch → null
    ])
    expect(await res.json()).toEqual({ results: ['1', null] })
  })

  it('な形容詞:去尾「な」後精確命中', async () => {
    const res = await lookup([{ expression: '簡単な', reading: 'かんたんな' }])
    expect(await res.json()).toEqual({ results: ['3'] })
  })

  it('查無回 null', async () => {
    const res = await lookup([{ expression: 'ぜんぜんない', reading: 'ぜんぜんない' }])
    expect(await res.json()).toEqual({ results: [null] })
  })

  it('片假名 reading 正規化為平假名後仍命中', async () => {
    const res = await lookup([{ expression: '食べる', reading: 'タベル' }])
    expect(await res.json()).toEqual({ results: ['2'] })
  })

  it('items 非陣列 / 空 / 超過 200 / 元素缺欄位 → 400', async () => {
    expect((await lookup('nope')).status).toBe(400)
    expect((await lookup([])).status).toBe(400)
    expect((await lookup(Array.from({ length: 201 }, () => ({ expression: 'a', reading: 'b' })))).status).toBe(400)
    expect((await lookup([{ expression: 'a' }])).status).toBe(400)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run --config vitest.workers.config.ts worker/accent.spec.ts`
Expected: FAIL — 端點不存在(404),或 JSON 結構不符。

- [ ] **Step 3: 實作 lookup 端點**

`worker/index.ts`,在 `app.get('/api/sync', ...)` 之後、`export default app` 之前新增。先加正規化 helper(放在 `SEQ_EXPR` 常數附近或端點上方皆可):

```ts
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
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run --config vitest.workers.config.ts worker/accent.spec.ts`
Expected: PASS（全部案例）。

Run: `npm run test:worker`
Expected: PASS（accent.spec + sync.spec 皆過）。

- [ ] **Step 5: Commit**

```bash
git add worker/index.ts worker/accent.spec.ts
git commit -m "feat: add /api/accent/lookup with three-stage dict matching

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: CSV 匯入/匯出支援重音欄

`csv.ts` 認得「重音」欄別名、mapRows 帶上並清理 accent、exportCsv 多一欄。純函式,更新既有 csv.test.ts。

**Files:**
- Modify: `src/lib/csv.ts`
- Test: `test/csv.test.ts`

**Interfaces:**
- Consumes: `isValidAccent`(Task 4)
- Produces:
  - `ParsedRow = { expression: string; reading: string; meaning: string; accent: string }`
  - `CsvMapping = { expression: number; reading: number | null; meaning: number; accent: number | null }`
  - `autoMapHeaders` 認 `重音/アクセント/accent/pitch`;`mapRows` 對不合法 accent 清成 `''`;`exportCsv` 輸出 `單字,讀音,意思,重音`

- [ ] **Step 1: 更新測試**

`test/csv.test.ts`:

(a) 檔頭 import 加 `isValidAccent` 不需要;改動 autoMap 期望值(第 21、24、27 行)以含 accent key,並新增重音相關案例。把 `autoMapHeaders` 的三個既有斷言改為:

```ts
  it('認得 vocab.csv 表頭並忽略 id 欄', () => {
    expect(autoMapHeaders(['id', '漢字', '拼音', '中文翻譯'])).toEqual({ expression: 1, reading: 2, meaning: 3, accent: null })
  })
  it('認得 front/back 表頭(無讀音無重音)', () => {
    expect(autoMapHeaders(['front', 'back'])).toEqual({ expression: 0, reading: null, meaning: 1, accent: null })
  })
  it('認得重音欄', () => {
    expect(autoMapHeaders(['漢字', '讀音', '意思', '重音'])).toEqual({ expression: 0, reading: 1, meaning: 2, accent: 3 })
  })
  it('認不得時回傳 null(首列是資料而非表頭)', () => {
    expect(autoMapHeaders(['0001', 'たった今', 'たったいま', '剛才'])).toBeNull()
  })
```

(b) mapRows 既有案例補 `accent: ''`(因為那些 mapping 沒有 accent 欄),並加 accent 清理案例:

```ts
  it('依 mapping 取值、修剪空白、丟掉缺單字或缺意思的列', () => {
    const rows = [
      ['1', ' 犬 ', 'いぬ', ' 狗 '],
      ['2', '', 'x', 'y'],
      ['3', 'z', 'w', ''],
    ]
    expect(mapRows(rows, { expression: 1, reading: 2, meaning: 3, accent: null })).toEqual([
      { expression: '犬', reading: 'いぬ', meaning: '狗', accent: '' },
    ])
  })
  it('mapping.reading 為 null 時讀音為空字串', () => {
    expect(mapRows([['a', 'b']], { expression: 0, reading: null, meaning: 1, accent: null })).toEqual([
      { expression: 'a', reading: '', meaning: 'b', accent: '' },
    ])
  })
  it('讀取重音欄;不合法值清成空字串', () => {
    const rows = [['犬', 'いぬ', '狗', '1'], ['猫', 'ねこ', '貓', 'bad']]
    expect(mapRows(rows, { expression: 0, reading: 1, meaning: 2, accent: 3 })).toEqual([
      { expression: '犬', reading: 'いぬ', meaning: '狗', accent: '1' },
      { expression: '猫', reading: 'ねこ', meaning: '貓', accent: '' },
    ])
  })
```

(c) dedupeRows 既有兩案例的 row 物件補 `accent: ''`(因為 ParsedRow 現在含 accent;第 51-52、61-64 行的物件字面值各加 `accent: ''`)。

(d) exportCsv 案例(第 73-82 行)改為驗證四欄與 accent 輸出:

```ts
  it('輸出 單字,讀音,意思,重音 表頭並跳過墓碑', () => {
    const notes = [
      { id: '1', deck_id: 'd', expression: '犬', reading: 'いぬ', meaning: '狗', accent: '2', reversed: 0, updated_at: 0, deleted: 0 },
      { id: '2', deck_id: 'd', expression: '猫', reading: 'ねこ', meaning: '貓', accent: '', reversed: 0, updated_at: 0, deleted: 1 },
    ] satisfies NoteRecord[]
    const csv = exportCsv(notes)
    expect(csv.split('\n')[0]).toBe('單字,讀音,意思,重音')
    expect(csv).toContain('犬,いぬ,狗,2')
    expect(csv).not.toContain('猫')
  })
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run --config vitest.config.ts test/csv.test.ts`
Expected: FAIL — mapping 缺 accent key、ParsedRow 無 accent、export 表頭不符。

- [ ] **Step 3: 實作 csv.ts 變更**

`src/lib/csv.ts`:

(a) 檔頭 import:

```ts
import Papa from 'papaparse'
import type { NoteRecord } from '../../shared/types'
import { isValidAccent } from './accent'
```

(b) 型別與別名:

```ts
export interface CsvMapping { expression: number; reading: number | null; meaning: number; accent: number | null }
export interface ParsedRow { expression: string; reading: string; meaning: string; accent: string }

const EXPRESSION_ALIASES = ['漢字', '單字', '单字', 'expression', 'word', 'front', '正面']
const READING_ALIASES = ['拼音', '読み', '讀音', '读音', 'reading', 'kana', '假名']
const MEANING_ALIASES = ['中文翻譯', '中文翻译', '意思', '翻譯', '翻译', 'meaning', 'back', '背面']
const ACCENT_ALIASES = ['重音', 'アクセント', 'accent', 'pitch']
```

(c) `autoMapHeaders` 回傳加 accent:

```ts
export function autoMapHeaders(headers: string[]): CsvMapping | null {
  const norm = headers.map((h) => h.trim().toLowerCase())
  const find = (aliases: string[]) => {
    const i = norm.findIndex((h) => aliases.some((a) => a.toLowerCase() === h))
    return i === -1 ? null : i
  }
  const expression = find(EXPRESSION_ALIASES)
  const meaning = find(MEANING_ALIASES)
  if (expression === null || meaning === null) return null
  return { expression, reading: find(READING_ALIASES), meaning, accent: find(ACCENT_ALIASES) }
}
```

(d) `mapRows` 帶上並清理 accent:

```ts
export function mapRows(rows: string[][], mapping: CsvMapping): ParsedRow[] {
  return rows
    .map((r) => {
      const rawAccent = mapping.accent === null ? '' : (r[mapping.accent] ?? '').trim()
      return {
        expression: (r[mapping.expression] ?? '').trim(),
        reading: mapping.reading === null ? '' : (r[mapping.reading] ?? '').trim(),
        meaning: (r[mapping.meaning] ?? '').trim(),
        accent: isValidAccent(rawAccent) ? rawAccent : '',
      }
    })
    .filter((r) => r.expression !== '' && r.meaning !== '')
}
```

(e) `exportCsv` 多一欄:

```ts
export function exportCsv(notes: NoteRecord[]): string {
  const csv = Papa.unparse({
    fields: ['單字', '讀音', '意思', '重音'],
    data: notes.filter((n) => !n.deleted).map((n) => [n.expression, n.reading, n.meaning, n.accent]),
  })
  return csv.replace(/\r/g, '')
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run --config vitest.config.ts test/csv.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/csv.ts test/csv.test.ts
git commit -m "feat: support accent column in CSV import and export

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: 匯入頁自動標註重音

匯入時對缺重音(CSV 沒帶)的列批次呼叫 lookup 自動填;離線/失敗照常匯入不中斷;摘要顯示自動標註與查無筆數。

**Files:**
- Modify: `src/pages/ImportPage.tsx`

**Interfaces:**
- Consumes: `fillMissingAccents`(Task 4);`createNotes`(帶 accent,Task 1);`ParsedRow`(含 accent,Task 6)

- [ ] **Step 1: 匯入流程加入自動標註**

`src/pages/ImportPage.tsx`:

(a) import 區加:

```ts
import { fillMissingAccents } from '../lib/accent'
```

(b) summary state 型別(第 19 行)擴充:

```ts
  const [summary, setSummary] = useState<{ imported: number; skipped: ParsedRow[]; annotated: number; missed: number; annotateSkipped: boolean } | null>(null)
```

(c) `doImport`(第 41-59 行)改為:去重後、寫入前先自動標註:

```ts
  const doImport = async () => {
    if (!mapping || parsed.length === 0 || busy) return
    setBusy(true)
    try {
      let targetId = deckId
      if (targetId === 'new') targetId = (await createDeck(newDeckName.trim() || '新牌組')).id
      const existing = await db.notes.where('deck_id').equals(targetId).filter((n) => !n.deleted).toArray()
      const keys = new Set(existing.map((n) => noteKey(n.expression, n.reading)))
      const { toImport, skipped } = dedupeRows(parsed, keys)

      // 自動標註:對 CSV 沒帶重音的列查字典;離線或 API 失敗時照常匯入(留空),不中斷。
      let rows = toImport
      let annotated = 0, missed = 0, annotateSkipped = false
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        annotateSkipped = true
      } else {
        try {
          const res = await fillMissingAccents(toImport)
          rows = res.rows; annotated = res.filled; missed = res.missed
        } catch {
          annotateSkipped = true
        }
      }

      await createNotes(targetId, rows.map((r) => ({ ...r, reversed: false })))
      setSummary({ imported: rows.length, skipped, annotated, missed, annotateSkipped })
      setErrMsg('')
    } catch (e) {
      setSummary(null)
      setErrMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
```

(d) summary 顯示區塊(第 117-126 行)加自動標註結果:

```tsx
        {summary && (
          <div className="summary">
            <p>✓ 匯入 {summary.imported} 筆,跳過重複 {summary.skipped.length} 筆</p>
            {summary.annotateSkipped
              ? <p className="hint">離線或字典查詢失敗,未自動標註重音(可稍後在牌組頁按「自動標註重音」)</p>
              : <p className="hint">自動標註重音 {summary.annotated} 筆,查無 {summary.missed} 筆</p>}
            {summary.skipped.length > 0 && (
              <ul>{summary.skipped.map((r, i) => (
                <li key={i}>{r.expression}{r.reading && `(${r.reading})`} — {r.meaning}</li>
              ))}</ul>
            )}
          </div>
        )}
```

- [ ] **Step 2: 驗證編譯與打包**

Run: `npm run build`
Expected: 成功。（匯入流程的自動標註核心 `fillMissingAccents` 已在 Task 4 單元測試涵蓋;頁面整合在 Task 10 以 Playwright 驗證。）

- [ ] **Step 3: Commit**

```bash
git add src/pages/ImportPage.tsx
git commit -m "feat: auto-annotate pitch accent on CSV import (offline-safe)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: 編輯器重音欄 + 即時預覽 + 自動查詢

牌組詳情頁的筆記編輯器加重音輸入欄(格式驗證)、`<PitchAccent>` 即時預覽、「自動查詢」按鈕(查目前 單字+読み,寫進輸入欄不直接存檔)。

**Files:**
- Modify: `src/pages/DeckDetail.tsx`

**Interfaces:**
- Consumes: `isValidAccent`、`lookupAccents`(Task 4);`PitchAccent`(Task 3);`NoteInput.accent`、`updateNote`/`createNote`(Task 1)

- [ ] **Step 1: 編輯器加欄位與行為**

`src/pages/DeckDetail.tsx`:

(a) import 區(第 1-9 行)加:

```ts
import { isValidAccent, lookupAccents } from '../lib/accent'
import { PitchAccent } from '../components/PitchAccent'
```

(b) `EMPTY`(第 11 行)加 accent:

```ts
const EMPTY: NoteInput = { expression: '', reading: '', meaning: '', reversed: false, accent: '' }
```

(c) 元件內、`saveNote` 之前新增自動查詢 handler(用既有 `busy` ref 防重入,錯誤寫既有 `errMsg`):

```ts
  const [looking, setLooking] = useState(false)
  const lookupOne = async () => {
    if (!form.expression.trim()) { setErrMsg('請先輸入單字'); return }
    setLooking(true)
    try {
      const [pitch] = await lookupAccents([{ expression: form.expression.trim(), reading: form.reading.trim() }])
      if (pitch != null) { setForm((f) => ({ ...f, accent: pitch })); setErrMsg(null) }
      else setErrMsg('字典查無此字的重音')
    } catch (e) {
      setErrMsg(`查詢失敗:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLooking(false)
    }
  }
```

(d) `saveNote`(第 35-53 行)在必填檢查後加 accent 格式檢查:

```ts
    if (!form.expression.trim() || !form.meaning.trim()) {
      setErrMsg('單字與意思為必填')
      return
    }
    if (!isValidAccent(form.accent.trim())) {
      setErrMsg('重音格式錯誤(只能是數字,多重音用逗號分隔,如 0 或 0,3)')
      return
    }
```

(e) 編輯表單(第 110-125 行)在「意思」input 之後、reversed label 之前插入重音欄與預覽:

```tsx
          <input placeholder="意思" value={form.meaning}
            onChange={(e) => setForm({ ...form, meaning: e.target.value })} />
          <div className="accent-field">
            <input placeholder="重音(如 0、2、0,3;可空)" value={form.accent}
              onChange={(e) => setForm({ ...form, accent: e.target.value })} />
            <button type="button" className="btn secondary" disabled={looking} onClick={lookupOne}>
              {looking ? '查詢中…' : '自動查詢'}
            </button>
          </div>
          {form.reading.trim() !== '' && form.accent.trim() !== '' && isValidAccent(form.accent.trim()) && (
            <div className="accent-preview"><PitchAccent reading={form.reading.trim()} accent={form.accent.trim()} /></div>
          )}
```

(f) 編輯既有卡片時(第 136-139 行的「編輯」按鈕)帶上 accent:

```tsx
            <button className="link" onClick={() => {
              setEditingId(n.id)
              setForm({ expression: n.expression, reading: n.reading, meaning: n.meaning, reversed: n.reversed === 1, accent: n.accent })
            }}>編輯</button>
```

- [ ] **Step 2: 驗證編譯與打包**

Run: `npm run build`
Expected: 成功。（查詢與驗證核心在 Task 4 已測;UI 於 Task 10 以 Playwright 驗證。）

- [ ] **Step 3: Commit**

```bash
git add src/pages/DeckDetail.tsx
git commit -m "feat: accent input, live preview, and auto-lookup in note editor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: 牌組「自動標註重音」按鈕(回填整副)

牌組詳情頁工具列加按鈕:掃描該牌組所有 `accent === ''` 且存活的筆記,批次查詢後逐筆 `updateNote` 回填。busy 防重入,完成顯示「標註 N 筆 / 查無 M 筆」。這是現有 869 字的回填入口。

**Files:**
- Modify: `src/pages/DeckDetail.tsx`

**Interfaces:**
- Consumes: `fillMissingAccents`(Task 4);`updateNote`(Task 1)

- [ ] **Step 1: 加回填 handler 與按鈕**

`src/pages/DeckDetail.tsx`:

(a) 元件內加狀態與 handler(沿用既有 `busy` ref 與 `errMsg`):

```ts
  const [annotateMsg, setAnnotateMsg] = useState<string | null>(null)
  const annotateDeck = async () => {
    if (busy.current) return
    const blanks = notes.filter((n) => n.accent === '')
    if (blanks.length === 0) { setAnnotateMsg('這副牌組沒有待標註的卡片'); return }
    busy.current = true
    setAnnotateMsg(`標註中…(${blanks.length} 筆)`)
    try {
      const { rows, filled, missed } = await fillMissingAccents(
        blanks.map((n) => ({ id: n.id, expression: n.expression, reading: n.reading, accent: n.accent })),
      )
      for (const r of rows) {
        if (r.accent !== '') await updateNote(r.id, { accent: r.accent })
      }
      setAnnotateMsg(`完成:標註 ${filled} 筆,查無 ${missed} 筆`)
      setErrMsg(null)
    } catch (e) {
      setAnnotateMsg(null)
      setErrMsg(`自動標註失敗:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      busy.current = false
    }
  }
```

註:`fillMissingAccents` 的泛型 `T` 只要求 `{expression, reading, accent}`,這裡多帶 `id` 讓回填時對得回筆記;回傳 `rows` 保序且含 `id`。

(b) import `fillMissingAccents`(若 Task 8 已 import `lookupAccents`,把它併成一行):

```ts
import { fillMissingAccents, isValidAccent, lookupAccents } from '../lib/accent'
```

(c) 工具列(第 102-108 行)加按鈕與訊息:

```tsx
      <div className="toolbar">
        <Link to={`/review/${deck.id}`} className="btn">開始複習</Link>
        <button className="btn secondary" onClick={() => download(`${deck.name}.csv`, exportCsv(notes))}>
          匯出 CSV
        </button>
        <button className="btn secondary" onClick={() => { setEditingId('new'); setForm(EMPTY) }}>＋新增卡片</button>
        <button className="btn secondary" onClick={annotateDeck}>自動標註重音</button>
      </div>
      {annotateMsg && <p className="hint">{annotateMsg}</p>}
```

- [ ] **Step 2: 驗證編譯與打包**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 3: Commit**

```bash
git add src/pages/DeckDetail.tsx
git commit -m "feat: add per-deck bulk pitch accent backfill button

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: 建置字典、上雲、回填 869 字、部署、實機驗證、文件

把功能接上真實環境:建 kanjium 字典 SQL、套 0002 migration、灌 `accent_dict`(local + remote)、部署、對雲端 869 字回填、Playwright 驗證顯示、修 `到着` 読み、更新 README/.gitignore。

**Files:**
- Create: `scripts/build-accent-dict.mjs`
- Modify: `.gitignore`、`README.md`、`vocab.csv`

**Interfaces:**
- Consumes: 前面所有 task 的成果(`/api/accent/lookup`、`accent_dict` 表、牌組回填按鈕)

- [ ] **Step 1: 字典建置腳本**

Create `scripts/build-accent-dict.mjs`:

```js
// 用法:
//   1) curl -sL -o scripts/accents.txt \
//        https://raw.githubusercontent.com/mifunetoshiro/kanjium/master/data/source_files/raw/accents.txt
//   2) node scripts/build-accent-dict.mjs
//   產出 scripts/accent-dict.sql(gitignore)。資料來源:kanjium(mifunetoshiro/kanjium),CC 授權,僅個人使用。
import fs from 'node:fs'

const SRC = 'scripts/accents.txt'
const OUT = 'scripts/accent-dict.sql'
const ROWS_PER_INSERT = 500 // 每個 INSERT 的 VALUES 列數,避免單一 statement 過大

const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
const validPitch = (s) => /^\d+(,\d+)*$/.test(s)
const esc = (s) => s.replace(/'/g, "''")

const seen = new Set()
const rows = []
for (const line of fs.readFileSync(SRC, 'utf8').split('\n')) {
  const [expression, reading, pitch] = line.split('\t')
  if (!expression || !pitch) continue
  const hira = kataToHira((reading || expression).trim())
  const p = pitch.trim()
  if (!validPitch(p)) continue
  const key = expression + ' ' + hira
  if (seen.has(key)) continue // 同 (expression, reading) 取第一筆
  seen.add(key)
  rows.push([expression, hira, p])
}

const parts = ['DELETE FROM accent_dict;']
for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
  const values = rows.slice(i, i + ROWS_PER_INSERT)
    .map(([e, r, p]) => `('${esc(e)}','${esc(r)}','${esc(p)}')`).join(',')
  parts.push(`INSERT INTO accent_dict (expression, reading, pitch) VALUES ${values};`)
}
fs.writeFileSync(OUT, parts.join('\n') + '\n')
console.log(`wrote ${rows.length} rows to ${OUT}`)
```

- [ ] **Step 2: .gitignore 排除產物**

`.gitignore` 末尾加:

```
scripts/accents.txt
scripts/accent-dict.sql
```

- [ ] **Step 3: 產生字典 SQL**

```bash
curl -sL -o scripts/accents.txt https://raw.githubusercontent.com/mifunetoshiro/kanjium/master/data/source_files/raw/accents.txt
node scripts/build-accent-dict.mjs
```

Expected: 印出 `wrote ~124000 rows to scripts/accent-dict.sql`(數量級對即可)。

- [ ] **Step 4: 套 0002 migration + 灌字典(本機),煙霧測試 lookup**

```bash
npx wrangler d1 migrations apply anki-pwa --local
npx wrangler d1 execute anki-pwa --local --file=scripts/accent-dict.sql
npx wrangler d1 execute anki-pwa --local --command "SELECT count(*) AS n FROM accent_dict"
```

Expected: migration 顯示 0002 已套用;count 約 124k。若 `execute --file` 因檔案過大被拒,改分段(腳本已是多個 INSERT,可用 `split` 或分次 execute)——記錄實際採用方式。

- [ ] **Step 5: 套 0002 migration + 灌字典(remote 正式庫)**

```bash
npx wrangler d1 migrations apply anki-pwa --remote
npx wrangler d1 execute anki-pwa --remote --file=scripts/accent-dict.sql
npx wrangler d1 execute anki-pwa --remote --command "SELECT count(*) AS n FROM accent_dict"
```

Expected: 0002 套用成功(notes 多 accent 欄、accent_dict 建立);remote count 約 124k。

- [ ] **Step 6: 修 vocab.csv 的 到着 読み**

`vocab.csv` 第 275 行:

```
0297,到着,到着,到達、抵達
```

改為:

```
0297,到着,とうちゃく,到達、抵達
```

- [ ] **Step 7: 部署**

```bash
npm run build
npm run test:worker
npx wrangler deploy
```

Expected: build 綠;worker 測試綠;deploy 印出 `https://anki-pwa.<account>.workers.dev` 與版本 id。

- [ ] **Step 8: 實機驗證(Playwright MCP)**

用 Playwright 開啟部署 URL,執行:

1. 進牌組詳情頁 → 按「自動標註重音」→ 等待完成訊息「標註 N 筆 / 查無 M 筆」(預期 N 約 760+、M 約 90±)。截圖。
2. 進複習頁,翻到答案面 → 確認読み上方有高低線、後面有 `[數字]`。截圖(至少 2 張不同重音型:平板 [0] 與非 [0])。
3. 編輯任一卡片 → 清空重音 → 按「自動查詢」→ 欄位出現數字、預覽線圖更新。截圖。
4. 修正 到着:編輯該卡把読み改 `とうちゃく`(若尚未同步),或確認 Step 6 的 CSV 修正已反映;按自動查詢確認取得重音。
5. 到設定頁按「立即同步」→ 無錯誤;`curl https://anki-pwa.<account>.workers.dev/api/sync?since=0` 抽查數筆 note 的 `accent` 非空。

把截圖與 lookup 抽查結果記錄在報告。

- [ ] **Step 9: 更新 README**

`README.md`:

(a) 「功能」清單加一項:

```
- 日文重音(ピッチアクセント):自動標註(kanjium 字典)、卡片與編輯器以高低線圖顯示
```

(b) 新增章節(放在「CSV 格式說明」之後):

```markdown
## 日文重音字典

重音由開源字典 [kanjium](https://github.com/mifunetoshiro/kanjium)(mifunetoshiro/kanjium)提供,存於 D1 表 `accent_dict`。建置與載入:

```bash
curl -sL -o scripts/accents.txt https://raw.githubusercontent.com/mifunetoshiro/kanjium/master/data/source_files/raw/accents.txt
node scripts/build-accent-dict.mjs                              # 產出 scripts/accent-dict.sql
npx wrangler d1 migrations apply anki-pwa --remote              # 套用 0002(notes.accent 欄 + accent_dict 表)
npx wrangler d1 execute anki-pwa --remote --file=scripts/accent-dict.sql
```

- 匯入 CSV 時,對沒帶「重音」欄的列會自動查字典填入(離線則留空)
- 牌組詳情頁「自動標註重音」可一鍵回填整副牌組的空白重音
- 編輯器可手動輸入重音(格式:數字,多重音用逗號,如 `0` 或 `0,3`)或按「自動查詢」
- 匯入表頭支援「重音 / アクセント / accent / pitch」欄;匯出含「重音」欄
```

(c) 「CSV 格式說明」中匯出欄位說明(第 57 行)更新為四欄:

```
- 匯出時(牌組詳情頁「匯出 CSV」)欄位為單字、讀音、意思、重音四欄
```

- [ ] **Step 9b: Commit(程式與文件;字典 SQL 與 accents.txt 已 gitignore)**

```bash
git add scripts/build-accent-dict.mjs .gitignore README.md vocab.csv
git commit -m "feat: build/load kanjium accent dict, backfill deck, docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 10: 最終回歸**

```bash
npm test
npm run test:worker
npm run build
```

Expected: 全綠。回報:單元測試數、worker 測試數、build 結果、Playwright 驗證摘要(回填筆數、截圖)、remote `accent_dict` 筆數。

---

## Self-Review(對照 spec 檢查)

- **資料模型**(spec §資料模型):Task 1 `NoteRecord.accent` + Dexie v2 upgrade + D1 0002 + worker 向下相容 ✅
- **accent_dict 表**(spec §D1 新表):Task 1 建表,Task 10 灌資料 ✅
- **字典建置腳本**(spec §字典建置腳本):Task 10 `build-accent-dict.mjs`(片假名→平假名、剔除非法 pitch、去重、DELETE 開頭可重跑)✅
- **查詢 API 三段式 + 200 上限 + db.batch**(spec §查詢 API):Task 5 ✅
- **三個自動標註入口**(spec §自動標註入口):Task 7 匯入頁、Task 8 編輯器、Task 9 牌組回填 ✅
- **離線/失敗不中斷匯入**(spec §入口 1):Task 7 navigator.onLine + try/catch ✅
- **顯示元件 splitMorae/pitchPattern/線圖+數字/正面不顯示**(spec §顯示元件):Task 2 純函式、Task 3 元件僅在答案面 ✅
- **CSV 別名 + 驗證 + 匯出欄**(spec §CSV):Task 6 ✅
- **修 到着 読み**(spec §順手修資料):Task 10 Step 6 ✅
- **測試**(spec §測試):pitch(Task 2)、accent client(Task 4)、lookup worker(Task 5)、csv(Task 6)、Playwright(Task 10)✅。註:元件與頁面無 RTL 測試基礎設施(未安裝,spec 未要求新增),邏輯以純函式徹底覆蓋 + Playwright 實機驗證替代,已於 Task 3/7/8/9 明記。
- **非目標**(spec §非目標):未做片語拆解、詞性推導、前端離線字典、驗證變更、正面顯示 — 計畫皆未觸及 ✅
- **授權致謝**(spec §資料來源):Task 10 README kanjium 出處 ✅

型別一致性:`NoteInput.accent`、`ParsedRow.accent`、`CsvMapping.accent`、`isValidAccent`、`lookupAccents`、`fillMissingAccents`、`pitchPattern`/`splitMorae`、`PitchAccent` 命名跨 task 一致。
