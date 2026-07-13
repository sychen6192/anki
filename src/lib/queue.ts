import { State } from './fsrs'
import type { CardRecord, ReviewLogRecord } from '../../shared/types'

export interface QueueResult {
  queue: CardRecord[]
  nextLearningDue: number | null
  newRemaining: number
}

export function startOfToday(now = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function countTodayNew(logs: ReviewLogRecord[], now = Date.now()): number {
  const start = startOfToday(now)
  return logs.filter((l) => l.reviewed_at >= start && l.state === State.New).length
}

export function buildQueue(
  cards: CardRecord[], logs: ReviewLogRecord[], newPerDay: number, now = Date.now(),
): QueueResult {
  const active = cards.filter((c) => !c.deleted)
  const due = active
    .filter((c) => c.state !== State.New && c.due <= now)
    .sort((a, b) => a.due - b.due)
  const newRemaining = Math.max(0, newPerDay - countTodayNew(logs, now))
  const news = active
    .filter((c) => c.state === State.New)
    .sort((a, b) => a.updated_at - b.updated_at) // 建立時間即初始 updated_at;近似 Anki 的建立順序
    .slice(0, newRemaining)
  const futureLearning = active.filter(
    (c) => (c.state === State.Learning || c.state === State.Relearning) && c.due > now,
  )
  return {
    queue: [...due, ...news],
    nextLearningDue: futureLearning.length ? Math.min(...futureLearning.map((c) => c.due)) : null,
    newRemaining,
  }
}
