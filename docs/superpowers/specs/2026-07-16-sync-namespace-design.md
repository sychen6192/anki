# 同步金鑰(sync namespace)設計

日期:2026-07-16
狀態:待使用者核准
前置:2026-07-13-anki-pwa-design.md(同步核心)

## 背景與目標

目前所有裝置同步到**同一個** D1、無帳號、無 user_id;把網址給朋友 = 共用同一份資料、複習紀錄互相覆蓋。使用者選擇「輕量折衷:同步金鑰」而非完整登入。

目標:同一個部署上,**不同金鑰 = 不同的獨立資料空間**。朋友設自己的金鑰即擁有與擁有者完全分開的複習紀錄。使用者(擁有者)決定:把現有 869 筆搬到一組私密金鑰(見「資料搬移」)。

**明確非目標**:真正的帳號/登入驗證、跨空間分享、每列權限。此功能是輕量分區,不是安全邊界(見「安全」)。

## 資料模型 — namespace 只在伺服器端

- D1 四張同步表(decks / notes / cards / review_logs)各加一欄 `namespace TEXT NOT NULL DEFAULT ''`。
- **這欄只存在於伺服器**。客戶端本地(Dexie/IndexedDB)結構完全不變,不新增欄位、不儲存 namespace。
- 空字串 `''` = 預設空間(未設金鑰,或舊 client)。
- migration `0003_namespace.sql`:對四張表 `ALTER TABLE ... ADD COLUMN namespace TEXT NOT NULL DEFAULT ''`,並各建複合索引 `(namespace, server_seq)` 以加速 pull 過濾(既有的單欄 `idx_*_seq` 保留或由複合索引取代)。
- `accent_dict` **不分區**(共用參考資料),不動。

## 同步協定變更

客戶端在每次同步請求帶 HTTP header **`x-sync-space: <金鑰>`**(金鑰為任意字串;空或未帶 = `''`)。伺服器為權威方,依 header 決定 namespace:

- **Push(`POST /api/sync`)**:讀 header 得 `space`;把 body 中每一列的 namespace **一律設為 `space`**(忽略 client 送來的任何 namespace 值)。`TABLE_COLS` 四張表各加 `'namespace'`;`buildRowStatements` 照舊(namespace 由 handler 注入列物件)。review_logs 仍 `INSERT OR IGNORE`(以 id 冪等;一筆 log 只屬於一個 namespace)。LWW upsert 語意在**同一 namespace 內**維持不變。
- **Pull(`GET /api/sync?since=`)**:每張表查詢改為 `WHERE namespace = ? AND server_seq > ?`(綁 `space` 與 `since`)。回傳的列**同時剝除 `server_seq` 與 `namespace`**(client 不需要)。頂層 `seq` 仍回全域 `meta.seq`。
- 全域 `server_seq` 計數器維持共用、單調遞增;跨 namespace 的 seq 交錯只會在各自 client 的游標留下無害的 gap(既有設計已容忍 gap)。

## 客戶端變更(`src/lib/sync.ts` + 設定頁)

- 金鑰存於 Dexie `meta`,key = `sync_space`(字串,預設 `''`)。
- `syncNow` 在 push 的 `fetch` POST 與 pull 的 `fetch` GET 都帶上 `x-sync-space: <sync_space 值>`。
- **換金鑰**:寫入新的 `sync_space` 後,刪除 `sync_cursor`(游標歸零),使下次 pull 從 0 依新 namespace 全量重拉。
- **清空本機資料**:提供一個動作,清空 decks/notes/cards/review_logs 與 `sync_cursor`(保留 `sync_space`),之後重新同步即取得該金鑰空間的資料。用於「在有舊資料的裝置上切換空間」時避免污染。

## 設定頁 UI(`src/pages/SettingsPage.tsx`)

新增「同步金鑰」區塊:

- 顯示目前金鑰;一個輸入欄 + 「儲存金鑰」按鈕(寫 `sync_space`、重置游標、觸發一次同步)。
- 「清空本機資料」按鈕(confirm 後執行上述清空)。
- 說明文字(zh-TW):金鑰形同該空間的密碼、經公開 API 傳送、不是登入驗證;每人請用**不同且不好猜**的金鑰;**在有資料的裝置上換金鑰前先清空本機**,避免舊資料混進新空間。

## 擁有者資料搬移(一次性)

- 使用者設一組私密金鑰 `K`。部署後,在後端跑一次(remote 與 local 各一次):
  ```sql
  UPDATE decks        SET namespace='K' WHERE namespace='';
  UPDATE notes        SET namespace='K' WHERE namespace='';
  UPDATE cards        SET namespace='K' WHERE namespace='';
  UPDATE review_logs  SET namespace='K' WHERE namespace='';
  ```
  把現有 869 筆(牌組/卡片/複習紀錄)移入 `K`。之後 `''` 變空。
- **rollout 順序**(避免資料空窗):① 部署新程式(namespace 欄存在,擁有者 client 仍送空 header → 看到 `''` 的既有資料,無變化)→ ② 使用者選定 `K` → ③ 跑上述 UPDATE(remote)→ ④ 使用者在每台自己的裝置設定填入 `K`(client 改送 `K` header、重拉)→ ⑤ 保險起見再跑一次 `UPDATE ... WHERE namespace=''` 清掉期間可能被未同步 dirty 列回寫到 `''` 的殘留。此步驟由執行者(controller)於實作最後一併完成並驗證。

## 向下相容與邊角

- 舊 client / 未帶 header → namespace `''`。搬移後 `''` 為空,舊 client 會看到空空間(擁有者會更新 client 並設金鑰,不受影響)。
- **切換金鑰但本機仍有他空間資料**:是「換帳號」語意。未先清空就同步會把本機 dirty 列 push 進新空間造成混雜(review_logs 尤其是 append-only,會跟著標到新空間)。緩解:UI 提供「清空本機資料」並在說明中指引;常見流程(擁有者設一次、朋友在乾淨裝置設一次)不受影響。
- review_logs 搬移只透過後端 UPDATE(push 的 `INSERT OR IGNORE` 不會改既有列的 namespace),故擁有者資料搬移一律走「後端 UPDATE」而非 client 重推。

## 安全(誠實面)

- 這是輕量分區,**不是帳號系統**:知道某金鑰的人即可存取該空間(金鑰經公開 API 明文傳送)。
- 要更硬的隔離:上 `SYNC_TOKEN`(擋整個 `/api/*`,既有預留)或做真正登入 —— 與本功能正交,日後可加,不在此範圍。

## 測試

- **Worker(vitest-pool-workers)**:
  - namespace 隔離:帶 `x-sync-space: A` push 的列,`x-sync-space: B` pull 看不到;反之亦然;無 header(`''`)自成一區。
  - 同一 namespace 內 LWW 仍正確(較新蓋較舊、同/舊時間戳忽略)。
  - review_logs 冪等仍以 id 成立(同 namespace 重送留一筆)。
  - pull 回傳列不含 `namespace` 與 `server_seq`。
- **前端(vitest + fake-indexeddb)**:`syncNow` 帶正確 header(以 mock fetch 斷言 header 值);換金鑰重置游標;清空本機資料的行為。
- **實機(Playwright)**:擁有者設金鑰後仍見 869 筆;第二個「空間」(不同金鑰、清空本機)為獨立空的空間;跨空間互不可見。

## 檔案影響一覽

- 新增:`migrations/0003_namespace.sql`;worker 測試補 namespace 案例(`worker/sync.spec.ts` 或新檔)。
- 修改:`worker/index.ts`(TABLE_COLS + header 讀取 + push 注入 namespace + pull 過濾/剝除)、`src/lib/sync.ts`(header + 換金鑰重置游標)、`src/pages/SettingsPage.tsx`(金鑰 UI + 清空本機)、`src/db/repo.ts` 或新 `src/lib/space.ts`(金鑰讀寫 + 清空本機的 helper)、`README.md`(金鑰用法 + 搬移步驟 + 安全說明)。
