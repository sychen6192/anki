import { describe, it, expect } from 'vitest'
import { newCardFields, rate, previewIntervals, formatInterval, State } from '../src/lib/fsrs'
import type { CardRecord } from '../shared/types'

const NOW = new Date('2026-07-13T12:00:00Z').getTime()

function makeCard(overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: 'c1', note_id: 'n1', deck_id: 'd1', direction: 'forward',
    ...newCardFields(NOW), updated_at: NOW, deleted: 0, ...overrides,
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
    [30 * 1000, '1分'],          // 不足 1 分鐘進位為 1分
    [5 * 60 * 1000, '5分'],
    [3 * 3600 * 1000, '3小時'],
    [3 * 24 * 3600 * 1000, '3天'],
    [45 * 24 * 3600 * 1000, '1.5月'],
    [400 * 24 * 3600 * 1000, '1.1年'],
  ])('%i ms → %s', (ms, expected) => {
    expect(formatInterval(ms)).toBe(expected)
  })
})
