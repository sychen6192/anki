import { State } from './fsrs'
import type { ReviewLogRecord } from '../../shared/types'

/** 統計用的日期分桶:一律以凌晨 4 點換日(與排程的 startOfToday 同一套規則)。 */

const FOUR_HOURS = 4 * 3600_000
export const DAY = 86400_000

/** 這個時間點屬於哪一天:回傳該天的起點(當地時間凌晨 4 點)。用 Date 算,不怕日光節約。 */
export function dayStart(ts: number): number {
  const d = new Date(ts - FOUR_HOURS)
  d.setHours(0, 0, 0, 0)
  return d.getTime() + FOUR_HOURS
}

/** 前一天的起點 */
export const prevDayStart = (start: number): number => dayStart(start - 1)

/** 連續複習天數。今天複習過就從今天起算;還沒的話從昨天往回數(今天不算斷)。 */
export function streakDays(timestamps: number[], todayStart: number): number {
  const days = new Set(timestamps.map(dayStart))
  let cursor = days.has(todayStart) ? todayStart : prevDayStart(todayStart)
  let n = 0
  while (days.has(cursor)) {
    n += 1
    cursor = prevDayStart(cursor)
  }
  return n
}

/** 最近 days 天(含今天)每天的筆數,由舊到新,附每天的起點時間戳。 */
export function lastNDays(
  timestamps: number[], todayStart: number, days: number,
): { start: number; count: number }[] {
  const counts = new Map<number, number>()
  for (const ts of timestamps) {
    const k = dayStart(ts)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const out: { start: number; count: number }[] = []
  let cursor = todayStart
  for (let i = 0; i < days; i += 1) {
    out.unshift({ start: cursor, count: counts.get(cursor) ?? 0 })
    cursor = prevDayStart(cursor)
  }
  return out
}

export interface Retention { passed: number; total: number }

/**
 * 真實保持率(Anki 的 true retention):只算「複習中」狀態卡片的複習,
 * 答對(困難/普通/簡單)÷ 全部。新卡與學習中/重學中的步驟不算 —— 那是同一天內的
 * 短期記憶,不是排程在考的東西。拿來對照目標保持率,才知道參數該不該調。
 */
export function trueRetention(logs: ReviewLogRecord[], since = -Infinity): Retention {
  let passed = 0
  let total = 0
  for (const l of logs) {
    if (l.state !== State.Review || l.reviewed_at < since) continue
    total += 1
    if (l.rating > 1) passed += 1
  }
  return { passed, total }
}
