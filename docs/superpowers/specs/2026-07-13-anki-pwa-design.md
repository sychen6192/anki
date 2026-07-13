# Anki-like PWA 設計文件

日期:2026-07-13
狀態:已與使用者確認

## 目標

做一個個人使用的間隔重複字卡 PWA,行為比照 Anki:離線可用、跨裝置同步、FSRS 排程。第一個實際用途是背日文單字(`vocab.csv`,870 筆,欄位為 `id,漢字,拼音,中文翻譯`)。

## 範圍

**第一版包含**:牌組管理、卡片新增/編輯/刪除、FSRS 複習流程(Again/Hard/Good/Easy)、反向卡選項、統計圖表、CSV 匯入/匯出、JSON 全庫備份、跨裝置同步。

**不包含**(未來可加):多使用者帳號、圖片/音訊媒體、克漏字(cloze)、自訂 note 模板、API 驗證(結構上預留一行 token 檢查即可上鎖)。

## 技術棧

| 層 | 選擇 |
|---|---|
| 前端 | React + Vite + TypeScript,vite-plugin-pwa |
| 本地資料 | IndexedDB(Dexie)— source of truth,離線完全可用 |
| 排程 | ts-fsrs(FSRS 官方 TS 實作,預設參數) |
| 圖表 | Recharts |
| CSV | PapaParse |
| 後端 | 同一個 Cloudflare Worker:Hono 提供 `/api/*`,Workers static assets 服務前端 |
| 雲端資料 | D1(SQLite) |
| 測試 | Vitest(前端與共用邏輯)、@cloudflare/vitest-pool-workers(API) |

單一 repo、單一 Worker 專案。前後端同源,所以 PWA 不需要設定伺服器位址。

## 資料模型

仿 Anki 的 note/card 分離。四張表,client(Dexie)與 server(D1)結構相同;client 另加 `dirty` 旗標,server 另加 `server_seq`(全域遞增,同步 cursor 用)。

- **decks**:`id`(uuid)、`name`、`new_per_day`(每日新卡上限,預設 20)、`updated_at`、`deleted`
- **notes**:`id`、`deck_id`、`expression`(單字/漢字)、`reading`(讀音,可空)、`meaning`(意思/翻譯)、`reversed`(是否產生反向卡)、`updated_at`、`deleted`
- **cards**:`id`、`note_id`、`direction`(`forward`/`reverse`)、ts-fsrs Card 全部欄位(`due`、`stability`、`difficulty`、`elapsed_days`、`scheduled_days`、`reps`、`lapses`、`state`、`last_review`)、`updated_at`、`deleted`
- **review_logs**:`id`、`card_id`、`rating`、ts-fsrs ReviewLog 欄位、`reviewed_at`。append-only,不會更新或刪除。

note 儲存內容;卡片由 note 產生 — 一般 note 產 1 張 forward 卡,勾「反向」多產 1 張 reverse 卡。刪 note 連帶墓碑其卡片。

## 卡片顯示(follow Anki)

- **forward 卡**:正面顯示「單字」;背面顯示 單字+讀音+意思 全部
- **reverse 卡**:正面顯示「意思」;背面同樣顯示全部
- 讀音為空時該行不顯示(所以非日文牌組也適用同一套模板)

## 複習流程

1. 當日佇列 = 到期卡(due ≤ 現在)+ 當日額度內的新卡。「今天已學的新卡數」= review_logs 中今日、且評分當下卡片狀態為 New 的紀錄數;額度 = `new_per_day` 減去該數
2. 顯示正面 → 空白鍵/點擊翻面 → `1/2/3/4` 或按鈕評 Again/Hard/Good/Easy
3. 四個按鈕上顯示 ts-fsrs 預測的下次間隔(如 Anki:`10分 / 1天 / 3天 / 7天`)
4. 評分後由 ts-fsrs 算出新狀態,寫回 card、新增 review_log,兩者標 dirty
5. 牌組列表顯示三色計數:新卡 / 學習中 / 到期複習(如 Anki)

## 同步(逐筆 LWW)

- 本地任何寫入都標 `dirty`;同步 = 先 push 後 pull
- **Push** `POST /api/sync`:送出所有 dirty 記錄。server 逐筆比較 `updated_at`,較新者寫入並取得新 `server_seq`;較舊者忽略。review_logs 無條件 insert(append-only、id 去重)
- **Pull** `GET /api/sync?since=<seq>`:回傳 `server_seq > since` 的所有記錄與最新 seq。client 逐筆比較 `updated_at` 合併,清掉已推送的 dirty,存新 cursor
- 刪除一律用墓碑(`deleted=1`)傳播,不做物理刪除
- 觸發時機:app 啟動、複習 session 結束、`online` 事件、手動按鈕。離線時靜默跳過
- **不做驗證**(使用者已確認接受風險:知道網址者可讀寫資料)。程式結構預留單行 token 檢查

衝突語意:同一筆記錄兩台裝置都改過時,`updated_at` 較新者整筆獲勝。對單人使用這已足夠;review_logs 不受影響(append-only)。

## CSV 匯入/匯出

**匯入**:選牌組 → 上傳/貼上 CSV → 表頭自動對應(`漢字`→單字、`拼音`/`読み`/`讀音`→讀音、`中文翻譯`/`意思`/`翻譯`→意思、`front`/`back` 亦支援;`id` 欄忽略)→ 也可手動調整對應 → 預覽 → 匯入。以「單字+讀音」對現有資料與檔案內部去重,結束後顯示摘要(成功 N 筆、跳過重複 M 筆及其清單)。

**匯出**:單一牌組 → `單字,讀音,意思` 之 CSV。另有全庫 JSON 備份(四張表完整內容)與還原。

**vocab.csv 已知資料問題**(匯入前修正檔案本身):

1. 第 68 行 `0701,玄関` → id 應為 `0071`(與第 679 行 `0701,具合` 撞號;匯入雖忽略 id 欄,仍建議修正)
2. 第 49 行讀音 `しん派をかける` → `しんぱいをかける`(誤植漢字)
3. `開く(ひらく)` 兩筆(第 149、454 行)語意不同但鍵相同,匯入時第二筆會被去重跳過 — 摘要中會列出,使用者可事後手動把兩個意思合併進同一筆

## 統計頁

三張圖,全部由本地 review_logs / cards 計算(不依賴同步):

1. 過去 30 天每日複習量(長條圖)
2. 未來 30 天到期預測(長條圖)
3. 卡片狀態分布:新卡 / 學習中 / 複習中(圓餅或橫條)

## 頁面結構

- `/` 牌組列表(含三色計數、開始複習入口)
- `/deck/:id` 牌組內卡片瀏覽/搜尋/編輯,牌組設定(名稱、每日新卡上限)
- `/review/:deckId` 複習介面
- `/import` CSV 匯入
- `/stats` 統計
- `/settings` 同步狀態/手動同步、JSON 備份與還原

介面語言:繁體中文。

## PWA

vite-plugin-pwa 產生 manifest 與 service worker(precache app shell,離線可完整使用)。app 名稱暫定「字卡」(可改)。

## 測試策略

- 單元:FSRS 排程包裝(評分→狀態轉移與 due 計算)、LWW 合併(新勝舊、墓碑傳播、cursor 前進)、CSV 表頭對應與去重、每日佇列組成(新卡額度計算)
- API:vitest-pool-workers 測 push/pull 往返、冪等重送
- 手動:兩個瀏覽器 profile 模擬雙裝置同步

## 部署

`wrangler deploy` 至 workers.dev(或日後綁自訂網域)。D1 schema 用 wrangler migrations 管理。
