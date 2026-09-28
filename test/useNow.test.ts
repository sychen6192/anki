import { describe, expect, it } from 'vitest'
import { nextLearningDue } from '../src/lib/useNow'
import { sortDecks } from '../src/lib/deckOrder'
import { State } from '../src/lib/fsrs'
import type { CardRecord } from '../shared/types'

const card = (over: Partial<CardRecord>): CardRecord => ({
  id: Math.random().toString(36), note_id: 'n', deck_id: 'd', direction: 'forward', state: State.Learning,
  due: 0, stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0,
  last_review: null, updated_at: 0, deleted: 0, suspended: 0, ...over,
} as CardRecord)

describe('nextLearningDue', () => {
  it('挑之後最早到期的學習中卡;已到期、新卡、複習卡、先不學、刪除的都不算', () => {
    const now = 1_000
    const cards = [
      card({ due: 5_000 }), card({ due: 3_000, state: State.Relearning }),
      card({ due: 500 }),                                   // 已經到期(首頁已經算進去了)
      card({ due: 2_000, state: State.New }), card({ due: 2_000, state: State.Review }),
      card({ due: 2_000, suspended: 1 }), card({ due: 2_000, deleted: 1 }),
    ]
    expect(nextLearningDue(cards, now)).toBe(3_000)
    expect(nextLearningDue([], now)).toBeNull()
    expect(nextLearningDue(undefined, now)).toBeNull()
  })
})

describe('sortDecks', () => {
  it('依名稱排,數字照數值(第 2 課在第 10 課前面)', () => {
    const names = sortDecks([{ name: '第 10 課' }, { name: '大家的日本語' }, { name: 'N3 單字' }, { name: '第 2 課' }]).map((d) => d.name)
    expect(names.indexOf('第 2 課')).toBeLessThan(names.indexOf('第 10 課'))
    // 同一組名字不管原本怎麼排,結果都一樣(不再跟著隨機 id 走)
    expect(sortDecks([{ name: 'N3 單字' }, { name: '第 2 課' }, { name: '大家的日本語' }, { name: '第 10 課' }]).map((d) => d.name))
      .toEqual(names)
  })
})
