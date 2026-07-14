# 日文重音(ピッチアクセント)功能設計

日期:2026-07-14
狀態:待使用者核准
前置:2026-07-13-anki-pwa-design.md(既有系統設計)

## 背景與目標

使用者的 870 個日文單字卡(單字/読み/意思)要加上重音標註。需求確認:

- **資料來源**:自動標註 — kanjium 開源重音字典(124,137 筆),查不到留空、可手動修改。
- **顯示方式**:線圖+數字 — 読み上畫高低音線(如 Yomichan/OJAD),後帶 `[數字]`。
- **架構**:字典上雲(D1)+ 查詢 API — App 內隨時可自動查,匯入新字時自動填。
- 實測覆蓋率:870 字中精確命中 716,加読み反查與去「な」再查約 88–92%;片語(心配をかける等)字典不收,留空。

## 資料模型

### notes 新欄位 `accent`

- `NoteRecord.accent: string` — 重音數字字串:`"0"`、`"2"`、多重音 `"0,3"`;空字串 `''` = 未標註。
- 合法格式:`/^\d+(,\d+)*$/` 或 `''`。UI 輸入時驗證;不驗證數字 ≤ 拍數(顯示元件自行防禦)。
- **D1**:migration `0002_accent.sql`:`ALTER TABLE notes ADD COLUMN accent TEXT NOT NULL DEFAULT ''`。
- **Dexie**:version 2,stores 定義不變(accent 不建索引),`upgrade` 把既有 notes 補 `accent: ''`。
- **同步**:worker `TABLE_COLS` 的 notes 加 `accent`,隨既有 LWW 逐筆同步。**向下相容**:server 對 push 中缺 `accent` 的 note 補 `''`(舊 client 更新筆記會把 accent 洗成空 — 單人使用、裝置很快更新,接受此邊角)。
- 備份匯出/匯入自然帶上新欄位(現有程式按物件全欄位處理,無需改動;匯入舊備份缺 accent 時補 `''`)。

### D1 新表 `accent_dict`

```sql
CREATE TABLE accent_dict (
  expression TEXT NOT NULL,
  reading    TEXT NOT NULL,   -- 統一為平假名
  pitch      TEXT NOT NULL,   -- 如 '0' 或 '0,3'
  PRIMARY KEY (expression, reading)
);
CREATE INDEX idx_accent_dict_reading ON accent_dict(reading);
```

- 不參與同步、無 tombstone、無 updated_at — 純唯讀參考資料。
- 表結構放 migration 0002;**資料灌入**由腳本完成(見下)。

## 字典建置腳本 `scripts/build-accent-dict.mjs`

1. 下載 kanjium `accents.txt`(GitHub raw;格式 `expression\treading\tpitch`,reading 可空 = expression 即假名)。
2. 轉換:読み 片假名→平假名(reading 空則用 expression 轉);pitch 不符 `/^\d+(,\d+)*$/` 的列剔除(實測 186 筆);同 (expression, reading) 重複時取第一筆。
3. 產出 `scripts/accent-dict.sql`(gitignore;multi-row INSERT,`DELETE FROM accent_dict;` 開頭保證可重跑)。
4. 灌入:`wrangler d1 execute DB --local --file=scripts/accent-dict.sql` 與 `--remote`。步驟寫進 README,含 kanjium 出處與致謝。

## 查詢 API

`POST /api/accent/lookup`(公開唯讀,與既有 API 一致無驗證)

- Request:`{ items: [{ expression: string, reading: string }] }`,**上限 200 筆**,超過回 400;空陣列回 400。
- Response:`{ results: (string | null)[] }` — 與 items 同序,查不到為 `null`。
- 查詢順序(每項):
  1. **精確**:`expression + reading`(読み先轉平假名)命中 → 取 pitch。
  2. **読み反查**:`SELECT DISTINCT pitch WHERE reading = ?` 恰得一種 pitch 才採用(多解 = 不猜)。
  3. **去「な」**:expression 與 reading 皆以「な」結尾時,去尾後重跑 1→2(な形容詞如 簡単な→簡単)。
- **Subrequest 限制**:所有 SELECT 走 `db.batch()`,沿用既有 `STATEMENTS_PER_BATCH=100` 分批;三段各為 misses 批次執行(≤200 items → 最多 6 批)。禁止逐項單發查詢。

## 自動標註入口(三處)

寫入一律走 repo(`updateNote`),dirty→同步,與既有寫入紀律一致。

1. **CSV 匯入頁**:解析、去重後,對 accent 為空的列分批(200/批)呼叫 lookup API 自動填;CSV 自帶「重音」欄的列以檔案為準不查。預覽顯示「自動標註 N 筆 / 查無 M 筆」。**離線或 API 失敗:照常匯入(accent 留空),顯示「離線,未自動標註」— 匯入不因標註失敗而中斷。**
2. **筆記編輯器**:重音輸入欄(格式驗證)+「自動查詢」按鈕(查目前 單字+読み,寫入輸入欄不直接存檔)+ 線圖即時預覽。
3. **牌組頁「自動標註重音」按鈕**:掃描該牌組所有 `accent === ''` 且未刪除的筆記,分批查詢後 `updateNote` 回填;busy 狀態防重入,完成顯示「標註 N 筆 / 查無 M 筆」。這是現有 869 字的回填路徑,之後新增單字隨時可再按。

## 顯示元件 `<PitchAccent reading accent>`

`src/components/PitchAccent.tsx` + `src/lib/pitch.ts`(純函式,可單元測試)。

### 拍(mora)切分 `splitMorae(reading): string[]`

- 小假名 `ゃゅょぁぃぅぇぉゎ`(含片假名對應)併入前一拍;`っ`/`ッ`、`ん`/`ン`、`ー` 各自成拍;其餘每字一拍。

### 高低 pattern `pitchPattern(moraCount, accent): { high: boolean[], dropAfter: number | null }`

M = 拍數、N = 重音數字:

- `N = 0`(平板):第 1 拍低、其餘高、無降調記號。
- `N = 1`(頭高):第 1 拍高、後降(`dropAfter = 1`)、其餘低。
- `2 ≤ N ≤ M`(中高/尾高):第 1 拍低、第 2..N 拍高、`dropAfter = N`、其後低。
- `N > M` 或 accent 格式不合法:回 `null`,元件只顯示數字不畫線(防禦壞資料)。
- 單拍字自然落入上述規則,無特例。

### 渲染

- 每拍一個 `<span>`:高拍 `border-top` 畫線;`dropAfter` 那拍加右側下折(`┐`,border-right)。
- 多重音 `"0,3"`:線圖畫第一個,數字全列 `[0,3]`。
- 顯示位置:**複習卡答案面**読み處(正反向卡的答案面都含読み)、編輯器預覽。**正面永不顯示**(不洩題)。accent 為空 → 與現狀相同,純文字読み。

## CSV 匯入/匯出

- 匯入表頭別名新增:`重音` / `アクセント` / `accent` / `pitch`(選填欄);值不合格式的列照匯入但 accent 清空並計入警告摘要。
- 匯出「重音」欄(欄序:單字,讀音,意思,重音)。

## 順手修資料

`vocab.csv` 第 275 行 `0297,到着,到着,到達、抵達` 読み改 `とうちゃく`;雲端該筆 note 於實機驗證時透過 App 編輯修正(走正常同步)。

## 測試

- **單元(Vitest)**:`splitMorae`(拗音/促音/長音/撥音/片假名)、`pitchPattern`(平板/頭高/中高/尾高/單拍/N>M/多重音/非法字串)、CSV 重音欄別名與驗證。
- **Worker(vitest-pool-workers)**:lookup 三段式(精確/読み唯一/去な/多解不猜/查無)、200 上限 400、空陣列 400、缺欄位 400。
- **整合**:匯入自動標註(mock fetch)、離線匯入不中斷、牌組回填 busy 防重入。
- **實機(Playwright)**:869 字回填後抽卡驗證線圖與數字、編輯器自動查詢、匯入流程。

## 非目標

- 片語重音拆解(心配をかける 等留空手動)。
- 詞性別重音、お接頭語推導、前端離線字典。
- 驗證機制變更(API 維持公開,沿用既有 SYNC_TOKEN 預留)。
- 正面顯示重音、統計頁變更。

## 資料來源與授權

kanjium(https://github.com/mifunetoshiro/kanjium)accents.txt,README 註明出處與致謝;個人使用。
