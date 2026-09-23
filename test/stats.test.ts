import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { DAY, dayStart, lastNDays, prevDayStart, streakDays, trueRetention } from '../src/lib/stats'
import { State } from '../src/lib/fsrs'
import { startOfToday } from '../src/lib/queue'

// 固定一個「今天」:2026-07-20(一)凌晨 4 點
const T = new Date(2026, 6, 20, 4, 0, 0).getTime()
const at = (dayOffset: number, hour: number) =>
  new Date(2026, 6, 20 + dayOffset, hour, 0, 0).getTime()

describe('dayStart(凌晨 4 點換日)', () => {
  it('清晨 3:59 算前一天,4:00 算當天', () => {
    expect(dayStart(at(0, 3) + 59 * 60_000)).toBe(at(-1, 4))
    expect(dayStart(at(0, 4))).toBe(at(0, 4))
    expect(dayStart(at(0, 23))).toBe(at(0, 4))
  })
  it('prevDayStart 往回走一天', () => {
    expect(prevDayStart(T)).toBe(at(-1, 4))
  })
})

describe('streakDays', () => {
  it('今天複習過:從今天起算連續天數', () => {
    expect(streakDays([at(0, 10), at(-1, 10), at(-2, 10)], T)).toBe(3)
  })
  it('今天還沒複習:從昨天往回數,不算斷', () => {
    expect(streakDays([at(-1, 10), at(-2, 10)], T)).toBe(2)
  })
  it('中間斷一天就停', () => {
    expect(streakDays([at(0, 10), at(-2, 10)], T)).toBe(1)
  })
  it('半夜 2 點的複習算前一天,不會斷', () => {
    // 今天(20 號)2:00 其實是 19 號的深夜
    expect(streakDays([at(0, 2), at(-2, 10)], T)).toBe(2)
  })
  it('沒有紀錄 = 0', () => {
    expect(streakDays([], T)).toBe(0)
  })
})

describe('lastNDays', () => {
  it('由舊到新、含今天、缺的天補 0', () => {
    const r = lastNDays([at(0, 10), at(0, 12), at(-2, 10)], T, 3)
    expect(r.map((d) => d.count)).toEqual([1, 0, 2])
    expect(r[2].start).toBe(T)
    expect(r[0].start).toBe(T - 2 * DAY)
  })
})

describe('trueRetention', () => {
  const log = (state: number, rating: number, reviewed_at: number) => ({
    id: `${state}-${rating}-${reviewed_at}`, card_id: 'c', rating, state, due: 0,
    stability: 1, difficulty: 5, elapsed_days: 0, last_elapsed_days: 0, scheduled_days: 1, reviewed_at,
  })

  it('只算複習中(Review)狀態的紀錄,答對 = 評分 > 重來', () => {
    const logs = [
      log(State.Review, 3, 100), log(State.Review, 1, 100), log(State.Review, 2, 100), log(State.Review, 4, 100),
      log(State.New, 3, 100), log(State.Learning, 1, 100), log(State.Relearning, 3, 100),
    ]
    expect(trueRetention(logs)).toEqual({ passed: 3, total: 4 })
  })

  it('since 之前的不算', () => {
    const logs = [log(State.Review, 3, 50), log(State.Review, 1, 150)]
    expect(trueRetention(logs, 100)).toEqual({ passed: 0, total: 1 })
    expect(trueRetention(logs)).toEqual({ passed: 1, total: 2 })
  })

  it('沒有紀錄時 total 為 0,由畫面決定怎麼顯示', () => {
    expect(trueRetention([])).toEqual({ passed: 0, total: 0 })
  })
})

describe('日光節約那天(streak 與 startOfToday 同一套換日)', () => {
  const original = process.env.TZ
  beforeAll(() => { process.env.TZ = 'America/New_York' })
  afterAll(() => { process.env.TZ = original })

  it('3/8 撥快一小時:3/7、3/8 都有複習,連續 2 天(以前會算成 1 天)', () => {
    const today = startOfToday(new Date('2026-03-08T12:00:00').getTime())
    const stamps = [new Date('2026-03-07T20:00:00').getTime(), new Date('2026-03-08T09:00:00').getTime()]
    expect(streakDays(stamps, today)).toBe(2)
    expect(dayStart(stamps[1])).toBe(today)
  })
})
