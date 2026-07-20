# 匯入 Anki 牌組(.apkg)設計文件

日期:2026-07-21
狀態:已與使用者確認

## 目標

讓使用者把 Anki 的 `.apkg` 牌組檔(自己匯出的,或從 AnkiWeb 下載的共享牌組)匯入本 app。只取 note 的文字內容,卡片一律從新卡開始由 FSRS 重新排程。

## 範圍

**包含**:在匯入頁新增「Anki 牌組」分頁,可選 `.apkg` 檔 → 解析 → 選 notetype → 欄位對應 → 預覽 → 匯入成一個牌組。

**不包含**:排程進度(due/ivl/reps/factor)、媒體檔(圖片/音訊)、tags、note type 模板、`.colpkg` 全庫還原、匯出成 .apkg。

## 使用者決策(已確認)

1. 檔案格式:`.apkg`(不是 Anki 的純文字匯出)
2. 排程:**只匯入內容**,全部當新卡
3. 多個子牌組:**全部併成一個新牌組**

## .apkg 格式要點

(來源:ankitects/anki `rslib/src/import_export/package/`、`rslib/src/storage/`、`rslib/src/text.rs`)

`.apkg` 是 zip。裡面可能有三種 collection 檔:

| 檔名 | 內容 | 何時出現 |
|---|---|---|
| `collection.anki21b` | zstd 壓縮的 SQLite(schema 18) | 現行預設匯出 |
| `collection.anki21` | 未壓縮 SQLite(schema 11) | 勾「支援舊版 Anki」時 |
| `collection.anki2` | 未壓縮 SQLite(schema 11) | 極舊版匯出 |

**陷阱**:Anki 的匯出程式碼**無條件**寫入一個 `collection.anki2` 佔位檔,裡面只有一筆「Please update Anki」的假 note。所以解析時必須依 `anki21b → anki21 → anki2` 的順序取第一個存在者,絕不能先看 `anki2`。檔名同時決定了是否需要 zstd 解壓(只有 `anki21b` 要)。zstd 未使用自訂 dictionary,壓縮等級為預設。

**讀 note**:`notes` 表的 `flds` 欄以 **0x1F(Unit Separator)** 分隔各欄位值;`mid` 指向 notetype id。

**讀欄位名**:
- schema 18:`SELECT ord, name FROM fields WHERE ntid = ? ORDER BY ord` — `name` 是純 TEXT 欄,不在 protobuf blob 裡;notetype 名同理在 `notetypes.name`。
- schema 11:`col.models` 是一整包 JSON,key 為 notetype id 字串,值含 `name` 與 `flds: [{name, ord}]`。

**讀牌組名**(只用來當預設牌組名稱):
- schema 18:`decks.name` 是純 TEXT,但**巢狀分隔符是 0x1F 不是 `::`**,顯示前要 `replace(/\x1f/g, '::')`。
- schema 11:`col.decks` JSON,`name` 已經是 `::` 形式。
- note 沒有 deck 欄位;deck 在 `cards.did`(若在 filtered deck 則真正的家在 `cards.odid`)。本功能只需要「主要牌組名」當預設值,取 cards 中出現最多次的 home deck 即可。

**欄位文字清理**(規則對照 anki 的 `text.rs`/`template_filters.rs`/`cloze.rs`):
- 區塊標籤(`br|p|div|li|tr|table|...`)先換成空白,再去掉所有 HTML 標籤、註解、`<style>`/`<script>` 區塊
- 解 HTML entity(含數值型 `&#160;`),再把 U+00A0 換成一般空白
- 去掉 `[sound:xxx.mp3]`
- cloze `{{c1::答案}}` / `{{c1,2::答案::提示}}` → 取答案文字
- furigana:`/ ?([^ >]+?)\[(.+?)\]/`,若 `[` 後接 `sound:` 則不視為 furigana。base = 群組 1,reading = 群組 2

## 架構

三個新單元,職責分離:

**`src/lib/ankiText.ts`** — 純文字處理,無相依。
```ts
stripAnkiHtml(html: string): string          // 標籤/entity/sound/cloze 全部清掉
splitFurigana(text: string): { base: string; reading: string }
```

**`src/lib/apkg.ts`** — 解析 .apkg 位元組成結構化資料,不碰 Dexie、不碰 UI。
```ts
interface ApkgNotetype { id: string; name: string; fieldNames: string[]; noteCount: number }
interface ApkgNote { notetypeId: string; fields: string[] }
interface ApkgParse { notetypes: ApkgNotetype[]; notes: ApkgNote[]; deckName: string }
parseApkg(bytes: Uint8Array): Promise<ApkgParse>
```
內部流程:`unzipSync`(fflate)→ 選 collection 檔 → 需要時 `decompress`(fzstd)→ sql.js `new SQL.Database(bytes)` → 偵測 schema(有沒有 `notetypes` 表)→ 讀 notetypes/fields 或 `col.models` → 讀 notes → 讀主要牌組名 → `db.close()`。sql.js 以動態 `import()` 載入,wasm 用 `sql.js/dist/sql-wasm.wasm?url` 交給 `locateFile`。

**`src/lib/apkgMap.ts`** — 把解析結果映射成既有的 `ParsedRow[]`。
```ts
interface ApkgMapping { expression: number; reading: number | null; meaning: number; accent: number | null }
autoMapFields(fieldNames: string[]): ApkgMapping   // 猜不到就退回位置對應,不回 null
mapApkgNotes(notes: ApkgNote[], mapping: ApkgMapping): ParsedRow[]
```
別名表(比對時忽略大小寫與前後空白):
- 單字:`Expression`, `Word`, `Front`, `Vocabulary`, `Vocab`, `Kanji`, `表面`, `単語`, `漢字`, `単語(漢字)`
- 讀音:`Reading`, `Kana`, `Furigana`, `Pronunciation`, `読み`, `讀音`, `よみ`, `振り仮名`, `ふりがな`
- 意思:`Meaning`, `Back`, `English`, `Translation`, `Definition`, `意味`, `意思`, `中文`, `翻譯`
- 重音:`Pitch`, `Accent`, `PitchAccent`, `アクセント`, `重音`

映射時每個欄位先過 `stripAnkiHtml`。若 `reading` 沒有對應欄位,但單字欄含 furigana(`漢字[かんじ]`),則 base 當單字、reading 當讀音 — 日文共享牌組常這樣存。重音欄的值仍照現有 `isValidAccent` 過濾。空的單字或意思照現有 `mapRows` 規則濾掉。

**`src/pages/ImportPage.tsx`** — 加上「CSV / Anki 牌組」分頁切換。兩條路徑各自產生 `ParsedRow[]`,之後共用同一段收尾:去重(`dedupeRows`)→ 自動標重音(`fillMissingAccents`)→ `createNotes` → 摘要。收尾邏輯抽成頁面內的 `commitImport(rows, deckId)`,避免兩份重複。

## 使用者流程

1. 切到「Anki 牌組」分頁 → 選 `.apkg` 檔
2. 檔案 > 60MB 直接擋下並提示(避免手機瀏覽器 OOM;解壓 + wasm heap 峰值約為原始 DB 的 2–3 倍)
3. 解析中顯示「解析中…」;失敗顯示錯誤原因(找不到 collection、SQLite 壞掉等)
4. 若解析出多個 notetype:下拉選單顯示「名稱(N 筆)」,預設選筆數最多者。**只匯入所選 notetype 的 notes**,其餘在摘要中報告為「已略過 N 筆(其他樣板)」
5. 欄位對應:三到四個下拉(單字/讀音/意思/重音),選項是該 notetype 的欄位名;自動猜對應,可手動改
6. 預覽前 5 筆
7. 目標牌組:沿用現有的「建立新牌組 / 選現有牌組」;建新牌組時名稱預設帶入 apkg 的主要牌組名
8. 匯入 → 摘要(匯入 N 筆、跳過重複 M 筆、略過其他樣板 K 筆、自動標重音結果)

## 相依套件

| 套件 | 用途 | 大小 |
|---|---|---|
| `fflate` | 解 zip | ~8KB |
| `fzstd` | 解 zstd(`collection.anki21b`) | ~8KB |
| `sql.js` | 讀 SQLite | JS ~100KB + wasm ~1.2MB |

sql.js 的 wasm 從 PWA precache 排除(`workbox.globIgnores` 加 `**/*.wasm`),改用 runtime cache(CacheFirst)。代價是第一次匯入 .apkg 需要連線,之後離線可用。其餘三個 JS 套件靠動態 `import()` 分割成獨立 chunk,不影響首屏。

## 錯誤處理

- 非 zip / 找不到任何 collection 檔 → 「這不像是 Anki 牌組檔(.apkg)」
- zstd 或 SQLite 解析失敗 → 顯示原始錯誤訊息,不吞掉
- 解析出 0 筆 note → 提示檔案裡沒有可匯入的 note
- 檔案過大 → 在讀取前就擋,訊息說明上限
- 匯入寫入失敗 → 沿用現有的 `errMsg` 顯示

## 測試

**單元(vitest,node 環境)**
- `test/ankiText.test.ts`:HTML 標籤/註解/style、區塊標籤轉空白、entity 與 NBSP、`[sound:]`、`<img>`、cloze 含提示、furigana 拆解、`word[sound:x.mp3]` 不可被當成 furigana
- `test/apkgMap.test.ts`:別名自動對應(含日文欄位名)、無讀音欄時從 furigana 抽讀音、空欄位過濾、重音驗證
- `test/apkg.test.ts`:測試中即時建構 fixture — 用 sql.js 造出 schema-11(`col.models`/`col.decks` JSON)與 schema-18(`notetypes`/`fields`/`decks` 表)兩種 DB,用 fflate `zipSync` 打包,schema-18 版另用 Node 的 `zstdCompressSync` 壓成 `collection.anki21b`。斷言:兩代格式都能讀出正確欄位名與 note、**同時存在假 `collection.anki2` 時不可讀到假 note**、牌組名的 `\x1f` 轉成 `::`

**手動**:用真實的 AnkiWeb 共享牌組 `.apkg` 在瀏覽器實際匯入一次,確認欄位自動對應與匯入筆數合理。

## 部署

沿用現有流程:`npm run build` → `wrangler deploy`。不需要 D1 migration(沒有新表)。
