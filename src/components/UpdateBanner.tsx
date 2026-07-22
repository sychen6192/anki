import { useEffect, useState } from 'react'
import { subscribeUpdate } from '../lib/sw'

/**
 * 有新版可用時,從底部滑出一條提示。按「更新」才會 skipWaiting 並重載;
 * 按「稍後」先收起來,下次重開或再有更新時會再出現。不打斷正在進行的複習。
 */
export function UpdateBanner() {
  const [apply, setApply] = useState<(() => void) | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => subscribeUpdate((next) => {
    setApply(() => next)
    setDismissed(false)
  }), [])

  if (apply === null || dismissed) return null
  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span>有新版本可用</span>
      <div className="update-banner-actions">
        <button className="btn" onClick={apply}>更新</button>
        <button className="link" onClick={() => setDismissed(true)}>稍後</button>
      </div>
    </div>
  )
}
