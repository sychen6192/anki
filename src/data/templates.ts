// 內建範本牌組:讓新使用者不用自己準備單字表就能開始。
// 只含 單字/讀音/意思 —— 重音走既有匯入流程自動查 kanjium 字典(離線則留空,
// 之後可在牌組頁「自動標註重音」補上)。
//
// csv 本體放在 ./mnn(約 115 KB),用動態 import 拉:匯入頁本身會被預先 prefetch,
// 把單字表留在這裡會讓每個人一開 app 就多下載一份自己可能永遠不會匯入的資料。
// 資料改動時記得跑 test/templates.test.ts(筆數、預覽、讀音、無重複都有驗)。

export interface DeckTemplate {
  id: string
  name: string
  description: string
  /** 預期筆數(不含表頭);測試會驗證與 csv 實際筆數一致 */
  count: number
  /** 卡片上的前幾個字,讓人一眼看出內容;與 csv 前三列同步(測試會驗) */
  preview: string
  loadCsv: () => Promise<string>
}

export const DECK_TEMPLATES: DeckTemplate[] = [
  {
    id: 'mnn-shokyu-1',
    name: '大家的日本語 初級 I',
    description: '第 1～25 課的單字，依課次排序。從自我介紹、數字時間一路到動詞變化。',
    count: 1408,
    preview: '私、あなた、あの人（あの方）…',
    loadCsv: () => import('./mnn').then((m) => m.MNN_1_CSV),
  },
  {
    id: 'mnn-shokyu-2',
    name: '大家的日本語 初級 II',
    description: '第 26～50 課的單字，依課次排序。含敬語、擬聲擬態語與各類生活場景用字。',
    count: 1440,
    preview: '見ます（診ます）、探します（捜します）、「時間に」遅れます…',
    loadCsv: () => import('./mnn').then((m) => m.MNN_2_CSV),
  },
]
