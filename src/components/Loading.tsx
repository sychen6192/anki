import { useEffect, useState } from 'react'

/**
 * 載入指示器。前 150ms 什麼都不畫 —— 資料通常在那之前就到了,
 * 立刻畫轉圈只會變成一閃而過的雜訊;真的等比較久時才需要告訴使用者「還在跑」。
 */
export function Loading({ label = '載入中' }: { label?: string }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setShow(true), 150)
    return () => clearTimeout(id)
  }, [])
  if (!show) return null
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  )
}
