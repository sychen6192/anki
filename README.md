# 字卡 anki-pwa

以 FSRS 排程演算法為核心的單字閃卡 PWA。本機優先(IndexedDB),背景與 Cloudflare D1 同步,可離線使用。

## 功能

- 牌組 / 卡片 / 複習(FSRS 排程,含正向與反向卡)
- CSV 匯入(自動欄位對應、預覽、跳過重複)與匯出
- 完整資料 JSON 備份與還原
- 背景同步(push/pull、Last-Write-Wins 合併)
- 統計頁(複習量、到期預測、卡片狀態)
- PWA(可安裝、離線快取)

## 本地開發

```bash
npm install
npx wrangler d1 migrations apply anki-pwa --local   # 建立本機 D1(SQLite)結構
npm run dev          # 前端開發伺服器(Vite)
npm run dev:worker    # Cloudflare Worker 開發伺服器(另開一個終端機)
```

`npm run dev` 啟動的前端會直接操作瀏覽器 IndexedDB;`npm run dev:worker` 則是本機的 Worker + D1,供同步 API(`/api/sync`、`/api/health`)測試使用。

## 測試

```bash
npm test          # 前端/共用邏輯單元測試(vitest)
npm run test:worker  # Worker 端測試(vitest,獨立 config)
npm run build      # 型別檢查 + 打包,部署前務必跑過
```

## 部署

```bash
npm run deploy
```

等同於 `npm run build && wrangler deploy`,會將 `dist/` 靜態檔與 Worker 一併發布到 Cloudflare。首次部署前需要:

1. `npx wrangler d1 create anki-pwa`,把回傳的 `database_id` 填入 `wrangler.jsonc` 的 `d1_databases[0].database_id`(取代 `"placeholder"`)
2. `npx wrangler d1 migrations apply anki-pwa --remote`,套用資料庫結構

部署完成後 wrangler 會印出 `https://anki-pwa.<account>.workers.dev`,可用 `curl <URL>/api/health` 確認回傳 `{"ok":true}`。

## CSV 格式說明

匯入頁支援任意欄位順序的 CSV,上傳後可手動或自動對應「單字 / 讀音 / 意思」三個欄位。範例(`vocab.csv`):

```csv
id,漢字,拼音,中文翻譯
0001,たった今,たったいま,剛才
0002,今にも,いまにも,馬上、眼看就要
```

- 預設「第一列是表頭」勾選時,第一列不會被當成資料匯入
- 同一牌組內「單字+讀音」相同視為重複,會自動跳過並列出被跳過的項目
- 匯出時(牌組詳情頁「匯出 CSV」)欄位為單字、讀音、意思三欄

## 啟用 SYNC_TOKEN 上鎖

預設 `/api/*` 沒有驗證,任何人知道 workers.dev 網址都能讀寫資料。要上鎖:

1. `npx wrangler secret put SYNC_TOKEN`,輸入一組隨機密鑰
2. 打開 `worker/index.ts`,取消以下這行的註解(並在 `Env` type 加上 `SYNC_TOKEN: string`):

   ```ts
   // app.use('/api/*', async (c, next) => { if (c.req.header('x-sync-token') !== c.env.SYNC_TOKEN) return c.text('unauthorized', 401); await next() })
   ```

3. 前端 `syncNow`(`src/lib/sync.ts`)呼叫 `fetch` 時,在 headers 加上 `x-sync-token: <同一組密鑰>`
4. 重新 `npm run deploy`

## 已知限制

- 同步 push 大量資料(例如一次匯入近千筆單字後首次同步)原本會因為單一 Worker 呼叫的 D1 子請求數超過 Cloudflare 平台上限而回傳 500。已修正:前端 push 分塊(每批最多 200 筆,依 decks→notes→cards→review_logs 順序填充,一批送完才清該批的 dirty 旗標)+ 後端改用 `D1Database.batch()` 把每列的 seq 分配與 upsert 合併成單次 API 呼叫(每批 100 個 statement/50 列)。實測 869 筆單字全量同步已可一次到位。
