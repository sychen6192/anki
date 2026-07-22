# 字卡 anki-pwa

以 FSRS 排程演算法為核心的單字閃卡 PWA。本機優先(IndexedDB),背景與 Cloudflare D1 同步,可離線使用。

## 功能

- 牌組 / 卡片 / 複習(FSRS 排程,含正向與反向卡)
- 說明頁(`/guide`):給新使用者的操作引導
- 內建範本牌組(N5 動詞/形容詞、數字與時間),匯入頁「範本」分頁一鍵匯入
- 複習中可復原評分、跳過、直接編輯這張卡
- 日文重音(ピッチアクセント):自動標註(kanjium 字典)、卡片與編輯器以高低線圖顯示
- CSV 匯入(自動欄位對應、預覽、跳過重複)與匯出
- Anki 牌組匯入(`.apkg`,只取文字內容,卡片從新卡開始排程)
- 完整資料 JSON 備份與還原
- 背景同步(push/pull、Last-Write-Wins 合併)
- 同步金鑰:同一部署上以金鑰切分獨立資料空間,可分給不同人各自使用
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

等同於 `npm run build && wrangler deploy`,會將 `dist/` 靜態檔與 Worker 一併發布到 Cloudflare。

若要部署到自己的 Cloudflare 帳號,先 `npx wrangler d1 create anki-pwa` 並把回傳的 `database_id` 填入 `wrangler.jsonc`(本 repo 已填入原作者的 id),接著 `npx wrangler d1 migrations apply anki-pwa --remote` 套用資料庫結構。

部署完成後 wrangler 會印出 `https://anki-pwa.<account>.workers.dev`,可用 `curl <URL>/api/health` 確認回傳 `{"ok":true}`。

## 複習

| 操作 | 鍵盤 |
|---|---|
| 顯示答案 | 空白鍵(或點卡片) |
| 評分 重來/困難/普通/簡單 | `1` `2` `3` `4` |
| 編輯這張卡 | `e`(`Esc` 取消) |
| 跳過這張卡 | `s` |

- **復原**:評分後左上出現「復原上一張」,會還原卡片的排程並刪掉那筆複習紀錄,
  且直接帶你回到那張卡。注意複習紀錄在伺服器端是 append-only,若該筆已同步出去,
  雲端那列會留著(只影響「今日新卡數」統計,不影響排程)。
- **跳過**只在這次複習中生效,離開複習畫面就重來 —— 它是「現在不想看」,
  不是 Anki 的 bury,不會寫進排程。
- **換日時間是凌晨 4 點**(與 Anki 相同):半夜還在複習時算前一天的額度,
  不會一過午夜就重新發一份新卡配額。
- 學習中的卡片若在 10 分鐘內到期,完成畫面會顯示倒數並自動接回複習。
- 複習畫面頂端有本次進度條;剩餘張數即時顯示。

## 更新提示

部署新版後,已開著的頁面**不會**自動重載打斷你 —— 底部會滑出「有新版本可用」,
按「更新」才會切換並重載,按「稍後」先收起(下次重開或再有更新時會再出現)。
沒有動作的話,下次完全關閉再打開 App 就會自動用到新版。

## 匯入 Anki 牌組(.apkg)

匯入頁的「Anki 牌組」分頁可直接讀 Anki / AnkiWeb 的 `.apkg`(新版 zstd 格式與舊版都支援)。

- 只匯入 note 的文字;排程進度、媒體檔與 tags 不會匯入,卡片一律從新卡開始由 FSRS 排程
- 檔案內若有多個樣板(note type),選一個匯入,其餘在摘要中回報為「略過其他樣板」
- 欄位依名稱自動對應(`Expression`/`単語`、`Reading`/`読み`、`Meaning`/`意味`、`Pitch`/`アクセント` 等),可手動改
- 欄位內容會清掉 HTML、`[sound:]`、cloze 標記;沒有讀音欄時會從 `漢字[かんじ]` 這種 furigana 寫法拆出讀音
- 牌組名稱預設帶入 apkg 內卡片最多的牌組(子牌組會併成同一個牌組)
- 讀 SQLite 用的 sql.js wasm 約 1.2MB,不進 precache,第一次匯入時才下載(需連線),之後離線也能用
- 檔案大小上限 60MB

## CSV 格式說明

匯入頁支援任意欄位順序的 CSV,上傳後可手動或自動對應「單字 / 讀音 / 意思」三個欄位。範例(`vocab.csv`):

```csv
id,漢字,拼音,中文翻譯
0001,たった今,たったいま,剛才
0002,今にも,いまにも,馬上、眼看就要
```

- 預設「第一列是表頭」勾選時,第一列不會被當成資料匯入
- 同一牌組內「單字+讀音」相同視為重複,會自動跳過並列出被跳過的項目
- 匯出時(牌組詳情頁「匯出 CSV」)欄位為單字、讀音、意思、重音四欄

## 日文重音字典

重音由開源字典 [kanjium](https://github.com/mifunetoshiro/kanjium)(mifunetoshiro/kanjium)提供,存於 D1 表 `accent_dict`。建置與載入:

```bash
curl -sL -o scripts/accents.txt https://raw.githubusercontent.com/mifunetoshiro/kanjium/master/data/source_files/raw/accents.txt
node scripts/build-accent-dict.mjs                              # 產出 scripts/accent-dict.sql(約 12 萬筆)
npx wrangler d1 migrations apply anki-pwa --remote              # 套用 0002(notes.accent 欄 + accent_dict 表)
npx wrangler d1 execute anki-pwa --remote --file=scripts/accent-dict.sql
```

- 匯入 CSV 時,對沒帶「重音」欄的列會自動查字典填入(離線則留空)
- 牌組詳情頁「自動標註重音」可一鍵回填整副牌組的空白重音
- 編輯器可手動輸入重音(格式:數字,多重音用逗號,如 `0` 或 `0,3`)或按「自動查詢」
- 匯入表頭支援「重音 / アクセント / accent / pitch」欄;匯出含「重音」欄

## 同步金鑰(多人分開使用)

同一個部署上,不同「同步金鑰」= 不同的獨立資料空間。設定頁「同步金鑰」填入一組字串即進入該空間;空白 = 預設空間。把 App 分給朋友時,請他設一組**自己的、不好猜的**金鑰(設定頁有「產生一組」按鈕),他的複習紀錄就與你完全分開。金鑰空白時,牌組列表與設定頁會提示設定金鑰。

- 金鑰存在各裝置本機(不同步);同一個人的多台裝置要填**相同**金鑰才會同步到一起。
- 換金鑰時會自動先「清空本機資料」(只清本機,雲端不受影響)再以新金鑰重新同步,以確保各空間隔離。
- 隔離範圍靠客戶端保證:清空後本機無舊 id,不會把舊空間的 id 推進新空間;伺服器則以 `x-sync-space` header 過濾。
- 安全性:金鑰形同該空間的密碼、經公開 API 傳送,**不是登入驗證** —— 知道金鑰的人即可存取該空間。要更硬的隔離請改上 `SYNC_TOKEN`(見下)或自行加入登入。

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
