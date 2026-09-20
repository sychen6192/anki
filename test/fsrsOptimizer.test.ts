import { describe, it, expect } from 'vitest'
import { buildTrainingSet, lastFirstLearnIndex } from '../src/lib/fsrsOptimizer'
import { State } from '../src/lib/fsrs'
import type { ReviewLogRecord } from '../shared/types'

// 本地時間 2026-07-01 12:00 當「第 0 天」中午
const D0 = new Date(2026, 6, 1, 12).getTime()
const DAY = 86400_000
let seq = 0
const log = (card: string, state: number, rating: number, at: number): ReviewLogRecord => ({
  id: `l${seq++}`, card_id: card, rating, state, due: 0, stability: 1, difficulty: 5,
  elapsed_days: 0, last_elapsed_days: 0, scheduled_days: 1, reviewed_at: at,
})

describe('lastFirstLearnIndex', () => {
  it('正常的卡:從第一筆(新卡)開始', () => {
    const s = [log('a', State.New, 3, D0), log('a', State.Learning, 3, D0 + 600_000), log('a', State.Review, 3, D0 + 3 * DAY)]
    expect(lastFirstLearnIndex(s)).toBe(0)
  })

  it('中途重新從新卡學起:只取最後那一段', () => {
    const s = [
      log('a', State.Review, 3, D0), log('a', State.Review, 1, D0 + 5 * DAY),
      log('a', State.New, 3, D0 + 20 * DAY), log('a', State.Review, 3, D0 + 22 * DAY),
    ]
    expect(lastFirstLearnIndex(s)).toBe(2)
  })

  it('重學中(Relearning)不算學習段,不會截斷歷史', () => {
    const s = [log('a', State.New, 3, D0), log('a', State.Review, 1, D0 + 5 * DAY), log('a', State.Relearning, 3, D0 + 5 * DAY + 1000)]
    expect(lastFirstLearnIndex(s)).toBe(0)
  })

  it('完全沒有學習中紀錄:-1(整張略過)', () => {
    expect(lastFirstLearnIndex([log('a', State.Review, 3, D0), log('a', State.Review, 3, D0 + DAY)])).toBe(-1)
    expect(lastFirstLearnIndex([])).toBe(-1)
  })
})

describe('buildTrainingSet', () => {
  it('前綴樣本:同一天的複習留在歷史但不當樣本,delta_t 是換日索引差', () => {
    const logs = [
      log('a', State.New, 3, D0),                      // 第 0 天
      log('a', State.Learning, 3, D0 + 600_000),       // 第 0 天,10 分鐘後(delta 0)
      log('a', State.Review, 3, D0 + 3 * DAY),         // 第 3 天
      log('a', State.Review, 1, D0 + 10 * DAY),        // 第 10 天,忘了
      log('a', State.Relearning, 3, D0 + 10 * DAY + 600_000), // 第 10 天(delta 0)
    ]
    const set = buildTrainingSet(logs)
    expect(Array.from(set.lengths)).toEqual([3, 4])
    expect(Array.from(set.ratings)).toEqual([3, 3, 3, 3, 3, 3, 1])
    expect(Array.from(set.deltaTs)).toEqual([0, 0, 3, 0, 0, 3, 7])
    expect(set).toMatchObject({ cards: 1, reviews: 5, items: 2 })
  })

  it('紀錄亂序也照時間排;多張卡的樣本接在一起', () => {
    const logs = [
      log('b', State.Review, 4, D0 + 2 * DAY), log('b', State.New, 3, D0),
      log('a', State.Review, 3, D0 + DAY), log('a', State.New, 3, D0),
    ]
    const set = buildTrainingSet(logs)
    expect(Array.from(set.lengths)).toEqual([2, 2])
    expect(set.items).toBe(2)
    expect(set.cards).toBe(2)
    const dts = Array.from(set.deltaTs)
    expect(dts.sort()).toEqual([0, 0, 1, 2])
  })

  it('換日以凌晨 4 點為準:03:00 與 05:00 隔一天,23:00 與隔天 01:00 同一天', () => {
    const at = (day: number, h: number) => new Date(2026, 6, 1 + day, h).getTime()
    const a = buildTrainingSet([log('a', State.New, 3, at(0, 3)), log('a', State.Review, 3, at(0, 5))])
    expect(Array.from(a.deltaTs)).toEqual([0, 1])
    const b = buildTrainingSet([log('b', State.New, 3, at(0, 23)), log('b', State.Review, 3, at(1, 1))])
    expect(b.items).toBe(0) // 同一天 → 沒有樣本
  })

  it('只有一筆紀錄、或全部同一天的卡,不產生樣本', () => {
    const set = buildTrainingSet([
      log('a', State.New, 3, D0),
      log('b', State.New, 3, D0), log('b', State.Learning, 3, D0 + 60_000),
    ])
    expect(set.items).toBe(0)
    expect(set.cards).toBe(0)
    expect(set.reviews).toBe(0)
  })

  it('沒有學習中紀錄的卡整張略過;評分夾在 1~4', () => {
    const set = buildTrainingSet([
      log('x', State.Review, 3, D0), log('x', State.Review, 3, D0 + DAY),
      log('a', State.New, 9, D0), log('a', State.Review, 0, D0 + DAY),
    ])
    expect(set.cards).toBe(1)
    expect(Array.from(set.ratings)).toEqual([4, 1])
  })
})
