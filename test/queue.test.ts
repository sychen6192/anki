import { describe, it, expect } from 'vitest'
import { buildQueue, countTodayNew, deckQueue, startOfToday, DAY_START_HOUR, SIBLING_GAP_MS } from '../src/lib/queue'
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

describe('startOfToday(換日時間)', () => {
  const at = (h: number, m = 0) => new Date(2026, 6, 21, h, m).getTime()

  it('凌晨 4 點前算前一天 —— 半夜複習不該重新發一份新卡額度', () => {
    const lateNight = startOfToday(at(1, 30))
    expect(new Date(lateNight).getDate()).toBe(20)
    expect(new Date(lateNight).getHours()).toBe(DAY_START_HOUR)
  })

  it('凌晨 4 點後算當天', () => {
    const morning = startOfToday(at(4, 1))
    expect(new Date(morning).getDate()).toBe(21)
    expect(new Date(morning).getHours()).toBe(DAY_START_HOUR)
  })

  it('同一個複習夜(23:00 與隔天 01:00)屬於同一天', () => {
    expect(startOfToday(new Date(2026, 6, 21, 23).getTime()))
      .toBe(startOfToday(new Date(2026, 6, 22, 1).getTime()))
  })

  it('跨過換日點就是不同天', () => {
    expect(startOfToday(at(3, 59))).not.toBe(startOfToday(at(4, 1)))
  })
})

describe('deckQueue', () => {
  const card = (over: Partial<CardRecord>): CardRecord => ({
    id: 'c', note_id: 'n', deck_id: 'd1', direction: 'forward',
    due: NOW, stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0,
    learning_steps: 0, reps: 0, lapses: 0, state: State.New, last_review: null,
    updated_at: 1, deleted: 0, ...over,
  })

  it('只算指定牌組的卡片,別的牌組不影響額度', () => {
    const cards = [
      card({ id: 'a', deck_id: 'd1' }),
      card({ id: 'b', deck_id: 'd2' }),
      card({ id: 'c', deck_id: 'd1' }),
    ]
    const { queue } = deckQueue('d1', 20, cards, [], NOW)
    expect(queue.map((c) => c.id)).toEqual(['a', 'c'])
  })

  it('今日新卡數只計入這副牌組自己的紀錄', () => {
    const cards = [card({ id: 'a', deck_id: 'd1' }), card({ id: 'other', deck_id: 'd2' })]
    const logs = [
      { card_id: 'other', state: State.New, reviewed_at: NOW } as ReviewLogRecord, // 別副的,不該扣額度
    ]
    expect(deckQueue('d1', 1, cards, logs, NOW).newRemaining).toBe(1)
    expect(deckQueue('d2', 1, cards, logs, NOW).newRemaining).toBe(0)
  })
})

describe('buildQueue:同一個字的正反兩面(sibling)不連著出現', () => {
  const fwd = (note: string, over: Partial<CardRecord> = {}) => card({ note_id: note, direction: 'forward', ...over })
  const rev = (note: string, over: Partial<CardRecord> = {}) => card({ note_id: note, direction: 'reverse', ...over })
  // 剛評過分的正向卡:進入學習中、尚未到期,已不在佇列裡
  const justAnswered = (note: string) => fwd(note, { state: State.Learning, due: NOW + 600_000 })

  it('剛看過的字,另一面排到新卡段最後 —— 匯入時正反兩張 updated_at 相同,原本會緊接著出現', () => {
    const fwdA = justAnswered('A')
    const revA = rev('A'), fwdB = fwd('B'), revB = rev('B')
    const logs = [log({ card_id: fwdA.id, state: State.New, reviewed_at: NOW - 30_000 })]
    const { queue } = buildQueue([fwdA, revA, fwdB, revB], logs, 20, NOW)
    expect(queue.map((c) => c.id)).toEqual([fwdB.id, revB.id, revA.id])
  })

  it('超過 SIBLING_GAP_MS 就照原順序', () => {
    const fwdA = justAnswered('A')
    const revA = rev('A'), fwdB = fwd('B'), revB = rev('B')
    const logs = [log({ card_id: fwdA.id, state: State.New, reviewed_at: NOW - SIBLING_GAP_MS - 1 })]
    const { queue } = buildQueue([fwdA, revA, fwdB, revB], logs, 20, NOW)
    expect(queue.map((c) => c.id)).toEqual([revA.id, fwdB.id, revB.id])
  })

  it('卡片自己的紀錄不算:學習步驟到期的卡照 due 順序回來,不會被推到後面', () => {
    const fwdA = fwd('A', { state: State.Learning, due: NOW - 300_000 })
    const x = card({ note_id: 'X', state: State.Review, due: NOW - 60_000 })
    const logs = [log({ card_id: fwdA.id, state: State.New, reviewed_at: NOW - 600_000 })]
    const { queue } = buildQueue([x, fwdA], logs, 20, NOW)
    expect(queue.map((c) => c.id)).toEqual([fwdA.id, x.id])
  })

  it('到期段也排開,但只在段內移動:仍在所有新卡之前', () => {
    const x = card({ note_id: 'X', state: State.Review, due: NOW - 7200_000 })
    const revA = rev('A', { state: State.Review, due: NOW - 3600_000 })
    const fwdA = fwd('A', { state: State.Learning, due: NOW - 30_000 })
    const n = card({ note_id: 'N', state: State.New })
    const logs = [log({ card_id: fwdA.id, state: State.Relearning, reviewed_at: NOW - 300_000 })]
    const { queue } = buildQueue([n, revA, fwdA, x], logs, 20, NOW)
    expect(queue.map((c) => c.id)).toEqual([x.id, fwdA.id, revA.id, n.id])
  })

  it('新卡額度先切再排開:今天學哪幾張不變,只換順序', () => {
    const fwdA = justAnswered('A')
    const revA = rev('A', { updated_at: NOW - 3 })
    const fwdB = fwd('B', { updated_at: NOW - 2 })
    const fwdC = fwd('C', { updated_at: NOW - 1 })
    const logs = [log({ card_id: fwdA.id, state: State.New, reviewed_at: NOW - 30_000 })]
    const { queue, newRemaining } = buildQueue([fwdA, revA, fwdB, fwdC], logs, 3, NOW)
    expect(newRemaining).toBe(2) // 額度 3,今天已學 fwdA
    expect(queue.map((c) => c.id)).toEqual([fwdB.id, revA.id]) // 若先排開再切,會變成 fwdB、fwdC
  })

  it('佇列只剩這兩張時仍會相鄰(沒有 bury,這是已知取捨)', () => {
    const fwdA = fwd('A', { state: State.Learning, due: NOW - 30_000 })
    const revA = rev('A')
    const logs = [log({ card_id: fwdA.id, state: State.New, reviewed_at: NOW - 60_000 })]
    const { queue } = buildQueue([revA, fwdA], logs, 20, NOW)
    expect(queue.map((c) => c.id)).toEqual([fwdA.id, revA.id])
  })
})
