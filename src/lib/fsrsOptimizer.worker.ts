// 在 worker 裡跑 fsrs-browser:wasm 約 340KB,不進 precache,第一次最佳化才下載。
// 不要從主執行緒 import 這個套件 —— 它的 glue 一載入就要 SharedArrayBuffer。
import init, { Fsrs, Progress, initThreadPool } from 'fsrs-browser'
import wasmUrl from 'fsrs-browser/fsrs_browser_bg.wasm?url'

export interface OptimizeRequest { ratings: Uint32Array; deltaTs: Uint32Array; lengths: Uint32Array }
export type OptimizeMessage =
  /** wasm 的記憶體是 SharedArrayBuffer,主執行緒拿 pointer 直接讀 [已處理, 總數] */
  | { type: 'progress'; buffer: ArrayBufferLike; pointer: number }
  | { type: 'done'; w: number[] }
  | { type: 'error'; message: string }

// tsconfig 用的是 DOM lib,self 被當成 Window;這裡只需要 postMessage 一個參數的版本
const post = (msg: OptimizeMessage) => (self as unknown as { postMessage(m: unknown): void }).postMessage(msg)

self.addEventListener('message', async (e: MessageEvent<OptimizeRequest>) => {
  const { ratings, deltaTs, lengths } = e.data
  try {
    const wasm = await init({ module_or_path: wasmUrl })
    // rayon 的執行緒池一定要先建(沒有就 panic);手機通常只給 1~2 條
    const threads = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
    await initThreadPool(threads)
    const progress = Progress.new()
    post({ type: 'progress', buffer: wasm.memory.buffer, pointer: progress.pointer() })
    // 從預設參數出發;enable_short_term=true 與 ts-fsrs 的預設一致(學習步驟算短期記憶)
    // relearning steps = 1(ts-fsrs 預設 ['10m']),影響 w17/w18 的上限
    const model = new Fsrs()
    const w = model.computeParameters(ratings, deltaTs, lengths, progress, true, undefined, 1, undefined)
    post({ type: 'done', w: Array.from(w) })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
})
