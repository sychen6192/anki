// 內建範本牌組:讓新使用者不用自己準備單字表就能開始。
// 只含 單字/讀音/意思 —— 重音走既有匯入流程自動查 kanjium 字典(離線則留空,
// 之後可在牌組頁「自動標註重音」補上)。
//
// 範本一律是本 App 自己整理的單字表,不放教材或別人分享的牌組:那些的收錄與編排、翻譯都有著作權,
// 打包進 App 散布出去就是重製(App 要上架,這是會被檢舉下架的那一種)。
// csv 本體放在 ./starter,用動態 import 拉:匯入頁本身會被預先 prefetch,單字表留到真的要匯入才下載。
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
    id: 'n5-verbs',
    name: 'N5 動詞 50',
    description: '吃、喝、去、來 —— 最常用的動詞，辭書形。',
    count: 50,
    preview: '食べる、飲む、行く…',
    loadCsv: () => import('./starter').then((m) => m.N5_VERBS_CSV),
  },
  {
    id: 'n5-adjectives',
    name: 'N5 形容詞 45',
    description: '大小、冷熱、顏色、心情，基本形容詞。',
    count: 45,
    preview: '大きい、小さい、新しい…',
    loadCsv: () => import('./starter').then((m) => m.N5_ADJECTIVES_CSV),
  },
  {
    id: 'numbers-time',
    name: '數字與時間 40',
    description: '數字、星期、今天明天。',
    count: 40,
    preview: '一、二、三…',
    loadCsv: () => import('./starter').then((m) => m.NUMBERS_TIME_CSV),
  },
]
