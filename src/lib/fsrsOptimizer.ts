import { State } from './fsrs'
import { DAY, dayStart } from './stats'
import { isValidW } from './fsrsSettings'
import type { ReviewLogRecord } from '../../shared/types'
import type { OptimizeMessage, OptimizeRequest } from './fsrsOptimizer.worker'

/** 少於這個數量不給跑:fsrs-rs 對太小的資料集只會回預設或只調初始穩定度 */
export const MIN_REVIEWS_TO_OPTIMIZE = 400
/** FSRS 官方建議累積到這個量以上,參數才穩 */
export const RECOMMENDED_REVIEWS = 1000
/** fsrs-rs 的 max_seq_len:超過的樣本它自己會丟掉,這裡先不送 */
const MAX_SEQ_LEN = 256

export interface TrainingSet {
  ratings: Uint32Array
  deltaTs: Uint32Array
  lengths: Uint32Array
  /** 有貢獻樣本的卡片數、這些卡片用到的紀錄數、樣本數 */
  cards: number
  reviews: number
  items: number
}

/** 這筆紀錄是不是「學習中」那一段(Anki revlog 的 Learning 類型):新卡第一次評分與其後的學習步驟 */
const isLearnKind = (l: ReviewLogRecord) => l.state === State.New || l.state === State.Learning

/**
 * 對照 fsrs-browser 內建的 Anki 轉換(anki.rs:remove_revlog_before_last_first_learn):
 * 只取「最後一段」學習中紀錄之後的歷史 —— 一張卡若被重設再學,舊的記憶軌跡不算。
 * 完全沒有學習中紀錄的卡片(歷史不完整)整張略過。回傳起始索引,-1 = 略過。
 */
export function lastFirstLearnIndex(sorted: ReviewLogRecord[]): number {
  let start = -1
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (isLearnKind(sorted[i])) start = i
    else if (start !== -1) break
  }
  return start
}

const dayIndex = (ts: number) => Math.round(dayStart(ts) / DAY)
const clampRating = (r: number) => Math.min(4, Math.max(1, Math.round(r)))

/**
 * 把複習紀錄整理成 fsrs-rs 要的樣本(與 anki.rs 的 convert_to_fsrs_items 同一套規則):
 * - 依卡片分組、依時間排序,delta_t 是「換日索引」的差(凌晨 4 點換日,同一天 = 0)
 * - 每個樣本是一張卡「到某次複習為止」的整段歷史(前綴序列),
 *   只有最後一筆 delta_t > 0 的才算樣本 —— 同一天內的複習是短期記憶,不拿來當預測目標,
 *   但會留在歷史裡讓模型學短期穩定度
 * 三個陣列是攤平的:lengths[i] 說第 i 個樣本佔幾筆。
 */
export function buildTrainingSet(logs: ReviewLogRecord[]): TrainingSet {
  const byCard = new Map<string, ReviewLogRecord[]>()
  for (const l of logs) {
    const list = byCard.get(l.card_id)
    if (list) list.push(l)
    else byCard.set(l.card_id, [l])
  }

  const ratings: number[] = []
  const deltaTs: number[] = []
  const lengths: number[] = []
  let cards = 0
  let reviews = 0
  for (const seq of byCard.values()) {
    seq.sort((a, b) => a.reviewed_at - b.reviewed_at)
    const start = lastFirstLearnIndex(seq)
    if (start === -1) continue
    const entries = seq.slice(start)
    const days = entries.map((l) => dayIndex(l.reviewed_at))
    const rs = entries.map((l) => clampRating(l.rating))
    const dts = days.map((d, i) => (i === 0 ? 0 : Math.max(0, d - days[i - 1])))
    let contributed = false
    for (let i = 1; i < entries.length && i < MAX_SEQ_LEN; i++) {
      if (dts[i] === 0) continue
      for (let k = 0; k <= i; k++) {
        ratings.push(rs[k])
        deltaTs.push(dts[k])
      }
      lengths.push(i + 1)
      contributed = true
    }
    if (contributed) {
      cards += 1
      reviews += entries.length
    }
  }
  return {
    ratings: Uint32Array.from(ratings),
    deltaTs: Uint32Array.from(deltaTs),
    lengths: Uint32Array.from(lengths),
    cards, reviews, items: lengths.length,
  }
}

/**
 * 在 Web Worker 裡跑 fsrs-browser(fsrs-rs 的 wasm)算參數。
 * 它用多執行緒 wasm,頁面必須是 cross-origin isolated(public/_headers 負責送 COOP/COEP),
 * 否則 SharedArrayBuffer 不存在、wasm 連載都載不起來 —— 先檢查,錯誤訊息才講得清楚。
 * 進度直接從 wasm 的共享記憶體讀:computeParameters 會卡住 worker 那條執行緒,它自己報不了進度。
 */
export function optimizeParameters(
  set: TrainingSet, onProgress?: (done: number, total: number) => void,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) {
      reject(new Error('這個頁面沒有跨來源隔離(可能是更新前的舊版快取),請完全關閉再重新開啟 App'))
      return
    }
    const worker = new Worker(new URL('./fsrsOptimizer.worker.ts', import.meta.url), { type: 'module' })
    let poll: ReturnType<typeof setInterval> | undefined
    const finish = () => {
      clearInterval(poll)
      worker.terminate()
    }
    worker.onmessage = (e: MessageEvent<OptimizeMessage>) => {
      const m = e.data
      if (m.type === 'progress') {
        const counters = new Uint32Array(m.buffer, m.pointer, 2)
        poll = setInterval(() => onProgress?.(counters[0], counters[1]), 250)
      } else if (m.type === 'done') {
        finish()
        const w: unknown = m.w
        if (isValidW(w)) resolve(w)
        else reject(new Error(`optimizer 回傳的參數不合法(${Array.isArray(w) ? w.length : '?'} 個)`))
      } else {
        finish()
        reject(new Error(m.message))
      }
    }
    worker.onerror = (e) => {
      finish()
      reject(new Error(e.message || 'optimizer worker 意外中止'))
    }
    const req: OptimizeRequest = { ratings: set.ratings, deltaTs: set.deltaTs, lengths: set.lengths }
    worker.postMessage(req, [set.ratings.buffer, set.deltaTs.buffer, set.lengths.buffer])
  })
}
