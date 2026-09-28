import { useEffect, useState } from 'react'
import { startOfToday } from './queue'
import { State } from './fsrs'
import type { CardRecord } from '../../shared/types'

/** 下一個換日時間(凌晨 4 點);用日期加一天而不是加 24 小時,遇到夏令時間也對 */
function nextDayStart(now: number): number {
  const d = new Date(startOfToday(now))
  d.setDate(d.getDate() + 1)
  return d.getTime()
}

/**
 * 畫面用的「現在」。首頁的到期數、「今天」的範圍都是 render 當下算的,
 * 而資料庫沒寫入時畫面不會重畫 —— 主畫面的 App 從背景叫回來、分頁開著過夜,
 * 就會一直停在昨天的「今天完成了」。所以這幾個時間點主動重算一次:
 * 回到前景、跨過換日時間,以及 wakeAt(例如下一張學習中的卡到期的時候)。
 */
export function useNow(wakeAt?: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const refresh = () => setNow(Date.now())
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])
  useEffect(() => {
    const targets = [nextDayStart(now), wakeAt].filter((t): t is number => typeof t === 'number' && t > now)
    const at = Math.min(...targets)
    // 晚一點點再叫醒,確定已經過了那個時間點
    const id = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()) + 500)
    return () => clearTimeout(id)
  }, [now, wakeAt])
  return now
}

/** 下一張學習中的卡什麼時候到期(給 useNow 當 wakeAt);沒有就是 null */
export function nextLearningDue(cards: readonly CardRecord[] | undefined, now: number): number | null {
  let next: number | null = null
  for (const c of cards ?? []) {
    if (c.deleted || c.suspended) continue
    if (c.state !== State.Learning && c.state !== State.Relearning) continue
    if (c.due > now && (next === null || c.due < next)) next = c.due
  }
  return next
}
