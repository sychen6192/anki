import { describe, it, expect } from 'vitest'
import { buildQueue, countTodayNew, startOfToday } from '../src/lib/queue'
import { newCardFields, State } from '../src/lib/fsrs'
import type { CardRecord, ReviewLogRecord } from '../shared/types'

const NOW = new Date('2026-07-13T12:00:00').getTime() // 本地時間正午

let seq = 0
function card(overrides: Partial<CardRecord>): CardRecord {
  return {
    id: `c${seq++}`, note_id: 'n', deck_id: 'd', direction: 'forward',
    ...newCardFields(NOW), updated_at: NOW, deleted: 0, ...overrides,
  }
}

function log(overrides: Partial<ReviewLogRecord>): ReviewLogRecord {
  return {
    id: `l${seq++}`, card_id: 'c', rating: 3, state: State.New, due: NOW,
    stability: 1, difficulty: 5, elapsed_days: 0, last_elapsed_days: 0,
    scheduled_days: 1, reviewed_at: NOW, ...overrides,
  }
}

describe('countTodayNew', () => {
  it('只計今天、且評分前狀態為 New 的紀錄', () => {
    const logs = [
      log({ state: State.New, reviewed_at: NOW - 3600_000 }),          // 今天的新卡 → 算
      log({ state: State.Review, reviewed_at: NOW - 3600_000 }),       // 今天的複習 → 不算
      log({ state: State.New, reviewed_at: startOfToday(NOW) - 1 }),   // 昨天的新卡 → 不算
    ]
    expect(countTodayNew(logs, NOW)).toBe(1)
  })
})

describe('buildQueue', () => {
  it('到期卡在前(依 due 排序),新卡在後(受額度限制)', () => {
    const dueA = card({ state: State.Review, due: NOW - 2000 })
    const dueB = card({ state: State.Review, due: NOW - 1000 })
    const n1 = card({ state: State.New })
    const n2 = card({ state: State.New })
    const n3 = card({ state: State.New })
    const { queue, newRemaining } = buildQueue([n1, dueB, n2, dueA, n3], [], 2, NOW)
    expect(queue.slice(0, 2).map((c) => c.id)).toEqual([dueA.id, dueB.id])
    expect(queue).toHaveLength(4) // 2 到期 + 2 新卡(額度 2)
    expect(newRemaining).toBe(2)
  })

  it('今天已學過的新卡數會扣掉額度', () => {
    const n1 = card({ state: State.New })
    const logs = [log({ state: State.New, reviewed_at: NOW - 60_000 })]
    const { queue, newRemaining } = buildQueue([n1], logs, 1, NOW)
    expect(newRemaining).toBe(0)
    expect(queue).toHaveLength(0)
  })

  it('未到期與墓碑卡不進佇列', () => {
    const future = card({ state: State.Review, due: NOW + 86400_000 })
    const dead = card({ state: State.Review, due: NOW - 1000, deleted: 1 })
    const { queue } = buildQueue([future, dead], [], 20, NOW)
    expect(queue).toHaveLength(0)
  })

  it('nextLearningDue = 未到期學習中卡的最早 due', () => {
    const l1 = card({ state: State.Learning, due: NOW + 600_000 })
    const l2 = card({ state: State.Relearning, due: NOW + 300_000 })
    const { nextLearningDue } = buildQueue([l1, l2], [], 20, NOW)
    expect(nextLearningDue).toBe(NOW + 300_000)
  })

  it('沒有未到期學習卡時 nextLearningDue 為 null', () => {
    expect(buildQueue([], [], 20, NOW).nextLearningDue).toBeNull()
  })
})
