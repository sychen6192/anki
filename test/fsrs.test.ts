import { afterEach, describe, it, expect } from 'vitest'
import { default_w } from 'ts-fsrs'
import { answersLeft, applyFsrsSettings, newCardFields, rate, previewIntervals, formatInterval, State } from '../src/lib/fsrs'
import type { CardRecord } from '../shared/types'

const NOW = new Date('2026-07-13T12:00:00Z').getTime()

function makeCard(overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: 'c1', note_id: 'n1', deck_id: 'd1', direction: 'forward',
    ...newCardFields(NOW), suspended: 0, updated_at: NOW, deleted: 0, ...overrides,
  }
}

describe('newCardFields', () => {
  it('產生 New 狀態、due=now 的初始欄位', () => {
    const f = newCardFields(NOW)
    expect(f.state).toBe(State.New)
    expect(f.reps).toBe(0)
    expect(f.due).toBe(NOW)
    expect(f.last_review).toBeNull()
  })
})

describe('rate', () => {
  it('新卡評 Good:reps+1、due 推進、log 記下評分當下狀態', () => {
    const { fields, log } = rate(makeCard(), 3, NOW)
    expect(fields.reps).toBe(1)
    expect(fields.due).toBeGreaterThan(NOW)
    expect(log.rating).toBe(3)
    expect(log.state).toBe(State.New) // log.state = 評分前的狀態
    expect(log.reviewed_at).toBe(NOW)
  })

  it('新卡評 Easy:直接進 Review、間隔至少 1 天', () => {
    const { fields } = rate(makeCard(), 4, NOW)
    expect(fields.state).toBe(State.Review)
    expect(fields.due - NOW).toBeGreaterThanOrEqual(24 * 3600 * 1000)
  })

  it('Again 的間隔 ≤ Easy 的間隔', () => {
    const again = rate(makeCard(), 1, NOW).fields.due
    const easy = rate(makeCard(), 4, NOW).fields.due
    expect(again).toBeLessThanOrEqual(easy)
  })
})

describe('previewIntervals', () => {
  it('回傳 1~4 各一個非空字串', () => {
    const p = previewIntervals(makeCard(), NOW)
    for (const r of [1, 2, 3, 4] as const) {
      expect(p[r]).toBeTruthy()
      expect(typeof p[r]).toBe('string')
    }
  })
})

describe('formatInterval', () => {
  it.each([
    [30 * 1000, '1 分鐘'],          // 不足 1 分鐘進位為 1 分鐘
    [5 * 60 * 1000, '5 分鐘'],
    [3 * 3600 * 1000, '3 小時'],
    [3 * 24 * 3600 * 1000, '3 天'],
    [45 * 24 * 3600 * 1000, '1.5 個月'],
    [400 * 24 * 3600 * 1000, '1.1 年'],
  ])('%i ms → %s', (ms, expected) => {
    expect(formatInterval(ms)).toBe(expected)
  })
})

describe('fuzz 種子:按鈕上的預覽 = 實際套用的間隔', () => {
  // 複習中的卡,下次間隔遠超過 2.5 天,fuzz 才會介入
  const reviewCard = (id = 'c1') => makeCard({
    id, state: State.Review, reps: 3, stability: 30, difficulty: 5,
    elapsed_days: 10, scheduled_days: 30,
    last_review: NOW - 10 * 86400_000, due: NOW - 86400_000,
  })

  it('render 與點擊隔了一段時間,四個按鈕顯示的間隔仍等於評分後排進去的間隔', () => {
    const card = reviewCard()
    const preview = previewIntervals(card, NOW)
    for (const r of [1, 2, 3, 4] as const) {
      const { fields, log } = rate(card, r, NOW + 90_000)
      expect(formatInterval(fields.due - log.reviewed_at)).toBe(preview[r])
    }
  })

  it('同一張卡同一天算幾次,間隔都一樣(以前每毫秒都可能不同)', () => {
    const card = reviewCard()
    const a = rate(card, 3, NOW).fields.due - NOW
    const b = rate(card, 3, NOW + 5 * 60_000).fields.due - (NOW + 5 * 60_000)
    expect(a).toBe(b)
  })

  it('fuzz 仍在:欄位相同但 id 不同的卡片,到期日會錯開', () => {
    const dues = new Set(Array.from({ length: 30 }, (_, i) => rate(reviewCard(`c${i}`), 3, NOW).fields.due))
    expect(dues.size).toBeGreaterThan(1)
  })
})

describe('applyFsrsSettings', () => {
  const reviewCard = () => makeCard({
    state: State.Review, reps: 3, stability: 30, difficulty: 5, elapsed_days: 10, scheduled_days: 30,
    last_review: NOW - 10 * 86400_000, due: NOW - 86400_000,
  })
  afterEach(() => applyFsrsSettings({ w: null, desired_retention: 0.9 }))

  it('目標保持率越低,同一張卡評 Good 的間隔越長', () => {
    applyFsrsSettings({ w: null, desired_retention: 0.8 })
    const relaxed = rate(reviewCard(), 3, NOW).fields.due
    applyFsrsSettings({ w: null, desired_retention: 0.95 })
    const strict = rate(reviewCard(), 3, NOW).fields.due
    expect(relaxed).toBeGreaterThan(strict)
  })

  it('自訂參數會被用上:把 Easy 的初始穩定度(w3)調成三倍,新卡評 Easy 的間隔變長', () => {
    const base = rate(makeCard(), 4, NOW).fields.due
    const w = [...default_w]
    w[3] *= 3
    applyFsrsSettings({ w, desired_retention: 0.9 })
    expect(rate(makeCard(), 4, NOW).fields.due).toBeGreaterThan(base)
  })
})

describe('answersLeft:照「普通」答完今天還要答幾次(複習畫面的進度條)', () => {
  const step = (c: CardRecord, rating: 1 | 2 | 3 | 4, at: number): CardRecord => ({ ...c, ...rate(c, rating, at).fields })

  it('新卡 2 次(1 分、10 分兩步);每按一次「普通」少一次,畢業後是到期的複習卡的 1 次', () => {
    let c = makeCard()
    expect(answersLeft(c)).toBe(2)
    c = step(c, 3, NOW)
    expect(c.state).toBe(State.Learning)
    expect(answersLeft(c)).toBe(1)
    c = step(c, 3, c.due)
    expect(c.state).toBe(State.Review)
    expect(answersLeft(c)).toBe(1)
  })

  it('「困難」停在同一步、「重來」回到第一步:剩下的次數不會變少', () => {
    const fresh = makeCard()
    const hard = step(fresh, 2, NOW)
    expect(hard.state).toBe(State.Learning)
    expect(answersLeft(hard)).toBe(2)
    const second = step(fresh, 3, NOW)
    expect(answersLeft(step(second, 1, second.due))).toBe(2)
  })

  it('到期的複習卡答錯進重學:還要再答 1 次(重學一步 10 分)', () => {
    const graduated = step(step(makeCard(), 3, NOW), 3, NOW + 10 * 60_000)
    const lapsed = step(graduated, 1, graduated.due)
    expect(lapsed.state).toBe(State.Relearning)
    expect(answersLeft(lapsed)).toBe(1)
    expect(step(lapsed, 3, lapsed.due).state).toBe(State.Review)
  })
})
