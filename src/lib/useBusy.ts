import { useCallback, useRef, useState } from 'react'

/**
 * 防連點。回傳 `[busy, run]`:
 * - `busy` 是 state,直接綁到按鈕的 `disabled`,使用者看得出動作正在進行
 * - `run` 期間再次呼叫會被忽略(用 ref 判斷,不受 re-render 時序影響)
 *
 * 只用 ref 擋重入的話按鈕不會 disable,使用者會以為自己的點擊沒被接受;
 * 只用 state 擋則會有 setState 尚未生效前的空窗 —— iOS 上的雙擊真的會鑽進去。
 */
export function useBusy(): [boolean, (fn: () => Promise<unknown> | unknown) => Promise<void>] {
  const [busy, setBusy] = useState(false)
  const running = useRef(false)

  const run = useCallback(async (fn: () => Promise<unknown> | unknown) => {
    if (running.current) return
    running.current = true
    setBusy(true)
    try {
      await fn()
    } finally {
      running.current = false
      setBusy(false)
    }
  }, [])

  return [busy, run]
}
