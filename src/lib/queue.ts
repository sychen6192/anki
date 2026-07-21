import { State } from './fsrs'
import type { CardRecord, ReviewLogRecord } from '../../shared/types'

export interface QueueResult {
  queue: CardRecord[]
  nextLearningDue: number | null
  newRemaining: number
}

/**
 * 跟 Anki 一樣,一天從凌晨 4 點開始換日。半夜 1 點還在複習時應該算「昨天」的額度,
 * 而不是一過午夜就重新發一份新卡配額。
 */
export const DAY_START_HOUR = 4

export function startOfToday(now = Date.now()): number {
  const d = new Date(now)
  if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1)
  d.setHours(DAY_START_HOUR, 0, 0, 0)
  return d.getTime()
}

export function countTodayNew(logs: ReviewLogRecord[], now = Date.now()): number {
  const start = startOfToday(now)
  return logs.filter((l) => l.reviewed_at >= start && l.state === State.New).length
}

/**
 * 從既有的卡片與今日紀錄挑出某副牌組的佇列。
 * DeckList(一次算全部牌組)與 Review(只算一副)共用同一段篩選,
 * 免得兩邊各寫一次、日後改了 buildQueue 的語意只改到一邊。
 */
export function deckQueue(
  deckId: string, newPerDay: number,
  allCards: CardRecord[], todayLogs: ReviewLogRecord[], now = Date.now(),
): QueueResult {
  const cards = allCards.filter((c) => c.deck_id === deckId)
  const ids = new Set(cards.map((c) => c.id))
  return buildQueue(cards, todayLogs.filter((l) => ids.has(l.card_id)), newPerDay, now)
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
