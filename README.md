# 字卡 anki-pwa

以 FSRS 排程演算法為核心的單字閃卡 PWA。本機優先(IndexedDB),背景與 Cloudflare D1 同步,可離線使用。

## 功能

- 牌組 / 卡片 / 複習(FSRS 排程,含正向與反向卡)
- 說明頁(`/guide`):給新使用者的操作引導
- 內建範本牌組(N5 動詞/形容詞、數字與時間),匯入頁「範本」分頁一鍵匯入
- 複習中可復原評分、跳過、直接編輯這張卡
- 日文重音(ピッチアクセント):自動標註(kanjium 字典)、卡片與編輯器以高低線圖顯示
- CSV 匯入(自動欄位對應、預覽、跳過重複)與匯出
- 分享牌組:產生連結給朋友,朋友打開或在 App 裡貼上就能匯入(只含單字,不含進度)
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

**推到 `main` 就會自動部署**(`.github/workflows/ci.yml` 的 `deploy` job)。型別檢查、打包、單元測試與 Worker 測試都過了之後,依序:

1. `npm run build`:打包失敗就不碰資料庫
2. `wrangler d1 migrations apply anki-pwa --remote`:只套還沒套過的 migration,沒有新的就跳過
3. `wrangler deploy`:發布 Worker 與 `dist/` 靜態檔
4. `scripts/smoke-test.sh`:確認 `/api/health` 回 `{"ok":true}`,首頁帶著 COOP/COEP 標頭

PR 與其他分支只跑檢查、不部署。同時只會有一個部署在跑,後來的排隊。
要重新部署同一版(例如換了 token),到 Actions 頁面選 CI → Run workflow → main。

### 第一次設定

在 GitHub repo 的 Settings → Secrets and variables → Actions 加兩個 repository secret:

| 名稱 | 內容 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare 後台 → My Profile → API Tokens → Create Token,選「Edit Cloudflare Workers」範本,**再加上 Account → D1 → Edit**:範本本身不含 D1 權限,少了它套 migration 會被拒(code 7403) |
| `CLOUDFLARE_ACCOUNT_ID` | 本機 `npx wrangler whoami` 印出的 Account ID |

有裝 gh 的話也可以直接在 repo 目錄下設定,會提示你貼上值:

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

沒設的話,deploy job 會在第一步失敗並指回這一段。

### 部署失敗時

到 Actions 頁面點開失敗的那次 run,看是哪一步紅了:

- **確認 Cloudflare 憑證已設定**:secret 沒設,或 account ID 不是 32 字元的格式。
- **套用 D1 migration**,訊息有 `code: 7403`:API token 沒有 Account → D1 → Edit 權限,或 account ID 不是資料庫所在的帳號。本機的 `wrangler login` 本來就有 D1 權限,所以「本機跑得動、CI 被拒」幾乎都是這個。到 Cloudflare 編輯那個 token 加上權限、按 Update token 即可;token 的值不會變,secret 不用改。
- **部署 Worker 與靜態檔**,訊息有 `code: 10000`:token 沒有 Workers Scripts 的 Edit 權限。
- **煙霧測試**:部署已經上線但行為不對,訊息會說是 API 路由還是標頭的問題。

修好之後在那次 run 的頁面按 Re-run failed jobs,只會重跑部署,不用再推一次。

### migration 只能做加法

migration 在新版上線**之前**套用,那段時間是舊版程式碼跑在新 schema 上。所以 migration 只能加新表、加帶預設值的新欄位,不能刪欄位或改名。真的要刪,先上一版不再用它的程式碼,下一版再刪。

### 手動部署與自架

緊急時本機仍可 `npm run deploy`,順序和 CI 相同:打包、套 migration、部署。migration 和 CI 一樣不詢問直接套用,套用失敗就不會部署。部署完可以跑 `scripts/smoke-test.sh <網址>` 檢查。

若要部署到自己的 Cloudflare 帳號,先 `npx wrangler d1 create anki-pwa` 並把回傳的 `database_id` 填入 `wrangler.jsonc`(本 repo 已填入原作者的 id),再照上面設定兩個 secret,推到 main 就會套好資料庫結構並部署。

## 複習

| 操作 | 鍵盤 |
|---|---|
| 顯示答案 | 空白鍵(或點卡片) |
| 評分 重來/困難/普通/簡單 | `1` `2` `3` `4` |
| 編輯這張卡 | `e`(`Esc` 取消) |
| 跳過這張卡 | `s` |
| 復原上一張 | `u` |
| 已經會了 | `k` |

帶 Cmd / Ctrl / Alt 的組合鍵一律交還瀏覽器:Cmd+S、Ctrl+U、Cmd+1 不會被當成跳過、復原、評分。

- **復原**:評分後左上出現「復原上一張」,會還原卡片的排程並刪掉那筆複習紀錄,
  且直接帶你回到那張卡。注意複習紀錄在伺服器端是 append-only,若該筆已同步出去,
  雲端那列會留著(只影響「今日新卡數」統計,不影響排程)。
- **跳過**只在這次複習中生效,離開複習畫面就重來 —— 它是「現在不想看」,
  不是 Anki 的 bury,不會寫進排程。
- **同一個字的正反兩面不會連著出現**:剛評完其中一面,另一面會排到這段佇列的最後
  (20 分鐘內看過就算)。同樣不是 bury、不會延到明天;佇列只剩這兩張時仍會相鄰。
- 評分按鈕上的間隔就是評分後實際排進去的間隔(fuzz 的種子取自卡片,不取自時間)。
- **全部一起複習**:牌組頁上方的按鈕(兩副以上、且有到期卡才出現)把所有牌組合成一次,網址是 `/review/all`。
  到期卡跨牌組依到期時間排,新卡各牌組照自己的每日上限依序接上,「再學 N 張新卡」則是跨牌組共 N 張。
  卡片上方會標示這張卡的牌組。
- **已經會了 / 暫停**:整個字的正反兩張卡一起退出佇列,不評分、不寫複習紀錄,但會寫進資料庫並同步。
  兩者只差標籤與意圖:「已經會了」是不用學,「暫停」是先不看。統計的狀態分布與到期預測不算它們。
  剛按完可以「復原」;之後在牌組頁用「批次選取」勾多筆一起標記或恢復,狀態篩選可以只看已會或暫停的字。
  範本牌組裡早就會的字,用這個一次清掉,每日新卡才真的是新的。
- **換日時間是凌晨 4 點**(與 Anki 相同):半夜還在複習時算前一天的額度,
  不會一過午夜就重新發一份新卡配額。
- 學習中的卡片若在 10 分鐘內到期,完成畫面會顯示倒數並自動接回複習。
- 複習畫面頂端有本次進度條;剩餘張數即時顯示。

## FSRS 參數與目標保持率

設定頁「FSRS 排程」:

- **目標保持率**(預設 90%):排程會把間隔調到「到期時大約記得這個比例」。調高複習更頻繁、忘得少;調低複習量少、忘得多。
- **用我的複習紀錄最佳化參數**:在瀏覽器裡跑 [fsrs-rs](https://github.com/open-spaced-repetition/fsrs-rs) 的 optimizer(`fsrs-browser` 的 wasm),用自己的複習紀錄算出一組 FSRS-6 參數。至少 400 筆紀錄才能跑,1000 筆以上比較穩;會佔滿 CPU 幾秒到一分鐘。樣本的整理規則對照 Anki:每張卡到某次複習為止的整段歷史是一個樣本,同一天內的複習只留在歷史裡不當目標。
- 參數與目標保持率存在 `settings` 表,跟牌組一樣走 LWW 同步,所以手機與電腦排出來的間隔一致;備份 JSON 也帶著。
- 統計頁的**真實保持率**:複習中的卡片到期時答對的比例(7 天 / 30 天 / 全部),拿來對照目標。明顯低於目標就最佳化參數;明顯高於目標可以把目標調低。

optimizer 用多執行緒 wasm,需要 SharedArrayBuffer,所以 `public/_headers` 對所有路徑送出
`Cross-Origin-Opener-Policy: same-origin` 與 `Cross-Origin-Embedder-Policy: require-corp`。
這個 app 沒有任何跨來源資源,所以沒有副作用;日後若要載入外部字型或圖片,那些資源得帶 CORP/CORS 標頭。
wasm 約 340KB,不進 precache,第一次最佳化時才下載,之後離線也能跑。

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

## 分享牌組

牌組頁按「分享牌組」會把單字(不含複習進度)上傳,產生 `/import?share=<碼>` 的連結,半年後自動清掉。

- **傳出去**:桌機產生後直接複製;手機產生後再按「分享…」開系統分享面板。手機分兩步是因為 iPhone 要求分享面板與寫剪貼簿都由點擊直接觸發,先等上傳就會被擋。每一步都有「複製連結」可以退回。
- **收到連結**:打開是專用的匯入頁,只有分享卡片;匯入後結果直接顯示在卡片上,按鈕收起來,不會重複匯入。匯入到同名牌組,沒有就新建,已經有的字會跳過。
- **iPhone、Mac Safari 與 App 內建瀏覽器**:主畫面(或 Mac Dock)上的 App 與 Safari 的資料是分開存的;LINE 等 App 的內建瀏覽器更是自己一份。在瀏覽器裡匯入,App 裡看不到。在這些環境打開連結時頁面會提醒,並提供「複製連結」,帶到 App 的「匯入」頁「分享連結」分頁貼上;內建瀏覽器則建議改貼到平常用的地方,不要在那裡匯入。
- 牌組頁新增卡片、或編輯時改了單字或讀音,如果牌組裡已經有同樣的單字與讀音,會先問要不要繼續,判準與匯入去重相同。

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

同一個部署上,不同「同步金鑰」= 不同的獨立資料空間。設定頁「同步金鑰」填入一組字串即進入該空間。把 App 分給朋友時,請他設一組**自己的、不好猜的**金鑰(設定頁有「產生一組」按鈕),他的複習紀錄就與你完全分開。

- **金鑰空白 = 純本機模式**:`syncNow()` 直接跳過,一個 request 都不發,資料只留在該裝置的 IndexedDB。沒設金鑰的人不會佔用雲端空間,也不會跟其他人共寫同一份資料。本機的 `dirty` 旗標照樣累積,之後補上金鑰就會一次推上去。
- **首次安裝**(本機無資料、沒選過金鑰)會先在牌組頁請你選:產生金鑰(推薦)/輸入既有金鑰/先不同步。牌組列表與設定頁在金鑰空白時會提示「只存在這台裝置」。
- 同步時機:啟動、回到前景(60 秒內去重)、每 15 分鐘、複習結束、匯入或編輯後(延遲 3 秒合併)、手動。背景同步失敗會在導覽列「設定」掛紅點、牌組頁出現「上次同步失敗」橫幅,成功後自動消失。

- 金鑰存在各裝置本機(不同步);同一個人的多台裝置要填**相同**金鑰才會同步到一起。
- 換金鑰時會自動先「清空本機資料」(只清本機,雲端不受影響)再以新金鑰重新同步,以確保各空間隔離。把金鑰清成空白同樣會清本機並停止同步,雲端那份不會被刪,填回同一組金鑰即可取回。
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
4. 推到 main 讓 CI 部署(或本機 `npm run deploy`)

## 已知限制

- 同步 push 大量資料(例如一次匯入近千筆單字後首次同步)原本會因為單一 Worker 呼叫的 D1 子請求數超過 Cloudflare 平台上限而回傳 500。已修正:前端 push 分塊(每批最多 200 筆,依 decks→notes→cards→review_logs 順序填充,一批送完才清該批的 dirty 旗標)+ 後端改用 `D1Database.batch()` 把每列的 seq 分配與 upsert 合併成單次 API 呼叫(每批 100 個 statement/50 列)。實測 869 筆單字全量同步已可一次到位。
