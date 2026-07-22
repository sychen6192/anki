import { describe, it, expect } from 'vitest'
import { DAY, dayStart, lastNDays, prevDayStart, streakDays } from '../src/lib/stats'

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
