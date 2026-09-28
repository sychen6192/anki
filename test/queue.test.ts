import { describe, it, expect } from 'vitest'
import {
  buildMultiDeckQueue, buildQueue, countTodayNew, deckQueue, newOverLimit, startOfToday, DAY_START_HOUR, SIBLING_GAP_MS,
} from '../src/lib/queue'
import { newCardFields, State } from '../src/lib/fsrs'
import type { CardRecord, ReviewLogRecord } from '../shared/types'

const NOW = new Date('2026-07-13T12:00:00').getTime() // 本地時間正午

let seq = 0
function card(overrides: Partial<CardRecord>): CardRecord {
  return {
    id: `c${seq++}`, note_id: 'n', deck_id: 'd', direction: 'forward',
    ...newCardFields(NOW), suspended: 0, updated_at: NOW, deleted: 0, ...overrides,
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

  it('暫停 / 已經會了的卡:不算到期、不佔新卡額度、不觸發自動接回', () => {
    const due = card({ state: State.Review, due: NOW - 1000, suspended: 1 })
    const known = card({ state: State.New, suspended: 2 })
    const fresh = card({ state: State.New })
    const learning = card({ state: State.Learning, due: NOW + 60_000, suspended: 1 })
    const { queue, newRemaining, nextLearningDue } = buildQueue([due, known, fresh, learning], [], 1, NOW)
    expect(queue.map((c) => c.id)).toEqual([fresh.id])
    expect(newRemaining).toBe(1)
    expect(nextLearningDue).toBeNull()
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
    suspended: 0, updated_at: 1, deleted: 0, ...over,
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

describe('buildMultiDeckQueue:跨牌組一次複習', () => {
  const decks = [{ id: 'A', new_per_day: 1 }, { id: 'B', new_per_day: 2 }]
  const ids = (q: CardRecord[]) => q.map((c) => c.id)

  it('到期卡跨牌組依 due 排;新卡各牌組照自己的額度、依牌組順序接起來', () => {
    const dueB = card({ deck_id: 'B', state: State.Review, due: NOW - 3000 })
    const dueA = card({ deck_id: 'A', state: State.Review, due: NOW - 1000 })
    const a1 = card({ deck_id: 'A', state: State.New, updated_at: 1 })
    const a2 = card({ deck_id: 'A', state: State.New, updated_at: 2 })
    const b1 = card({ deck_id: 'B', state: State.New, updated_at: 1 })
    const b2 = card({ deck_id: 'B', state: State.New, updated_at: 2 })
    const b3 = card({ deck_id: 'B', state: State.New, updated_at: 3 })
    const { queue, newRemaining } = buildMultiDeckQueue(decks, [a2, b3, dueA, b1, a1, dueB, b2], [], NOW)
    expect(ids(queue)).toEqual(ids([dueB, dueA, a1, b1, b2]))
    expect(newRemaining).toBe(3)
  })

  it('今日新卡只扣自己那副牌組的額度', () => {
    const a1 = card({ deck_id: 'A', state: State.New })
    const aDone = card({ deck_id: 'A', state: State.Learning, due: NOW + 600_000 })
    const b1 = card({ deck_id: 'B', state: State.New })
    const logs = [log({ card_id: aDone.id, state: State.New, reviewed_at: NOW - 60_000 })]
    const { queue, newRemaining } = buildMultiDeckQueue(decks, [a1, aDone, b1], logs, NOW)
    expect(ids(queue)).toEqual([b1.id])
    expect(newRemaining).toBe(2) // A 剩 0,B 剩 2
  })

  it('不在名單裡的牌組(例如已刪除的)整個不算,連它的紀錄也不影響額度', () => {
    const z = card({ deck_id: 'Z', state: State.Review, due: NOW - 1000 })
    const zDone = card({ deck_id: 'Z', state: State.Learning, due: NOW + 600_000 })
    const a1 = card({ deck_id: 'A', state: State.New })
    const logs = [log({ card_id: zDone.id, state: State.New, reviewed_at: NOW - 60_000 })]
    const { queue } = buildMultiDeckQueue(decks, [z, zDone, a1], logs, NOW)
    expect(ids(queue)).toEqual([a1.id])
  })

  it('加碼是跨牌組共 N 張:依牌組順序先補前面的,補完再往下一副', () => {
    const a = [1, 2, 3].map((i) => card({ deck_id: 'A', state: State.New, updated_at: i }))
    const b = [1, 2, 3, 4].map((i) => card({ deck_id: 'B', state: State.New, updated_at: i }))
    const { queue } = buildMultiDeckQueue(decks, [...a, ...b], [], NOW, 3)
    // A:額度 1 + 加碼 2(它只剩 2 張可加);B:額度 2 + 加碼 1
    expect(ids(queue)).toEqual(ids([a[0], a[1], a[2], b[0], b[1], b[2]]))
  })

  it('加碼學掉的新卡要扣掉:「再學 3 張」學完 3 張就沒了,不會每重算一次又給 3 張', () => {
    const d3 = [{ id: 'A', new_per_day: 3 }, { id: 'B', new_per_day: 3 }]
    const a = Array.from({ length: 15 }, (_, i) => card({ deck_id: 'A', state: State.New, updated_at: i }))
    const b = Array.from({ length: 15 }, (_, i) => card({ deck_id: 'B', state: State.New, updated_at: i }))
    // 今天各學了 3 張(額度用完),又加碼學了 A 的 2 張
    const learned = [...a.slice(0, 5), ...b.slice(0, 3)]
    const logs = learned.map((c) => log({ card_id: c.id, state: State.New, reviewed_at: NOW - 60_000 }))
    // 學過的卡還在(進入學習中,10 分鐘後才到期),只是不再是新卡
    const learning = learned.map((c) => ({ ...c, state: State.Learning, due: NOW + 600_000 }))
    const rest = [...learning, ...a.slice(5), ...b.slice(3)]
    const { queue } = buildMultiDeckQueue(d3, rest, logs, NOW, 3)
    expect(queue.length).toBe(1) // 加碼 3 張,已經學掉 2 張,只剩 1 張
  })

  it('剛看過的字,另一面排到整個到期段最後 —— 不會因為跨牌組重排 due 又黏回去', () => {
    const fwdA = card({ deck_id: 'A', note_id: 'nA', state: State.Learning, due: NOW - 30_000 })
    const revA = card({ deck_id: 'A', note_id: 'nA', direction: 'reverse', state: State.Review, due: NOW - 3600_000 })
    const dueB = card({ deck_id: 'B', note_id: 'nB', state: State.Review, due: NOW - 7200_000 })
    const logs = [log({ card_id: fwdA.id, state: State.Relearning, reviewed_at: NOW - 300_000 })]
    const { queue } = buildMultiDeckQueue(decks, [revA, fwdA, dueB], logs, NOW)
    expect(ids(queue)).toEqual(ids([dueB, fwdA, revA]))
  })

  it('nextLearningDue 取所有牌組最早的;暫停的不算', () => {
    const lA = card({ deck_id: 'A', state: State.Learning, due: NOW + 600_000 })
    const lB = card({ deck_id: 'B', state: State.Relearning, due: NOW + 300_000 })
    const paused = card({ deck_id: 'B', state: State.Learning, due: NOW + 60_000, suspended: 1 })
    expect(buildMultiDeckQueue(decks, [lA, lB, paused], [], NOW).nextLearningDue).toBe(NOW + 300_000)
  })

  it('沒有牌組:空佇列', () => {
    const { queue, newRemaining, nextLearningDue } = buildMultiDeckQueue([], [card({ state: State.New })], [], NOW)
    expect(queue).toEqual([])
    expect(newRemaining).toBe(0)
    expect(nextLearningDue).toBeNull()
  })
})

describe('newOverLimit:同一天第二次「再學一點」', () => {
  // 每天 2 張、8 張新卡:學了 2 張 + 加碼 2 張 = 今天 4 張新卡
  const setup = (deckId: string) => {
    const fresh = Array.from({ length: 8 }, (_, i) => card({ id: `${deckId}-n${i}`, deck_id: deckId, updated_at: NOW + i }))
    const learned = fresh.slice(0, 4).map((c) => ({ ...c, state: State.Learning, due: NOW + 3600_000 }))
    const cards = [...learned, ...fresh.slice(4)]
    const logs = learned.map((c) => log({ card_id: c.id, state: State.New, reviewed_at: NOW - 60_000 }))
    return { cards, logs }
  }

  it('算出今天超出上限學了幾張;跨牌組各副分開算', () => {
    const a = setup('A')
    const b = setup('B')
    expect(newOverLimit([{ id: 'A', new_per_day: 2 }], a.cards, a.logs, NOW)).toBe(2)
    expect(newOverLimit([{ id: 'A', new_per_day: 5 }], a.cards, a.logs, NOW)).toBe(0)
    expect(newOverLimit([{ id: 'A', new_per_day: 2 }, { id: 'B', new_per_day: 3 }],
      [...a.cards, ...b.cards], [...a.logs, ...b.logs], NOW)).toBe(3)
  })

  it('加碼從超出的量往上加:單副與全部牌組都拿得到新的一輪', () => {
    const { cards, logs } = setup('A')
    const unit = 2
    // 以前:加碼只算這次的 2 張,被今天已經加碼學掉的 2 張抵掉 → 0 張
    expect(deckQueue('A', 2 + unit, cards, logs, NOW).queue.filter((c) => c.state === State.New)).toHaveLength(0)
    const bonus = newOverLimit([{ id: 'A', new_per_day: 2 }], cards, logs, NOW) + unit
    expect(deckQueue('A', 2 + bonus, cards, logs, NOW).queue.filter((c) => c.state === State.New)).toHaveLength(2)
    const multi = buildMultiDeckQueue([{ id: 'A', new_per_day: 2 }], cards, logs, NOW, bonus)
    expect(multi.queue.filter((c) => c.state === State.New)).toHaveLength(2)
  })
})
