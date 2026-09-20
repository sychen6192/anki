import 'fake-indexeddb/auto'
import { beforeEach, describe, it, expect } from 'vitest'
import { db } from '../src/db/db'
import {
  DEFAULT_FSRS_SETTINGS, getFsrsSettings, isValidW, parseFsrsSettings, saveFsrsSettings,
} from '../src/lib/fsrsSettings'

beforeEach(async () => {
  await db.delete()
  await db.open()
})

const W21 = Array.from({ length: 21 }, (_, i) => i + 0.5)

describe('parseFsrsSettings', () => {
  it('沒有設定列、壞 JSON、不是物件:一律回預設', () => {
    expect(parseFsrsSettings(undefined)).toEqual(DEFAULT_FSRS_SETTINGS)
    expect(parseFsrsSettings('{not json')).toEqual(DEFAULT_FSRS_SETTINGS)
    expect(parseFsrsSettings('null')).toEqual(DEFAULT_FSRS_SETTINGS)
    expect(parseFsrsSettings('[1,2]')).toEqual(DEFAULT_FSRS_SETTINGS)
  })

  it('合法欄位照收', () => {
    const s = parseFsrsSettings(JSON.stringify({ w: W21, desired_retention: 0.85, optimized_at: 123, optimized_reviews: 4567 }))
    expect(s).toEqual({ w: W21, desired_retention: 0.85, optimized_at: 123, optimized_reviews: 4567 })
  })

  it('壞掉的欄位各自退回預設,不連累其他欄位', () => {
    const s = parseFsrsSettings(JSON.stringify({
      w: [1, 2, 3], desired_retention: 'high', optimized_at: 'yesterday', optimized_reviews: null,
    }))
    expect(s.w).toBeNull() // 長度不對
    expect(s.desired_retention).toBe(0.9)
    expect(s.optimized_at).toBeNull()
    expect(s.optimized_reviews).toBe(0)
    expect(parseFsrsSettings(JSON.stringify({ w: [...W21.slice(0, 20), NaN] })).w).toBeNull()
    expect(parseFsrsSettings(JSON.stringify({ w: [...W21.slice(0, 20), 'x'] })).w).toBeNull()
  })

  it('目標保持率夾在 0.7–0.97 之間', () => {
    expect(parseFsrsSettings(JSON.stringify({ desired_retention: 0.2 })).desired_retention).toBe(0.7)
    expect(parseFsrsSettings(JSON.stringify({ desired_retention: 1.5 })).desired_retention).toBe(0.97)
  })

  it('isValidW 認得 17/19/21 個參數', () => {
    expect(isValidW(W21)).toBe(true)
    expect(isValidW(W21.slice(0, 19))).toBe(true)
    expect(isValidW(W21.slice(0, 17))).toBe(true)
    expect(isValidW(W21.slice(0, 18))).toBe(false)
    expect(isValidW('nope')).toBe(false)
  })
})

describe('get/saveFsrsSettings', () => {
  it('沒存過回預設;存過拿得回來且標 dirty', async () => {
    expect(await getFsrsSettings()).toEqual(DEFAULT_FSRS_SETTINGS)
    await saveFsrsSettings({ w: W21, desired_retention: 0.88, optimized_at: 5, optimized_reviews: 900 })
    const row = (await db.settings.get('fsrs'))!
    expect(row.dirty).toBe(1)
    expect(row.deleted).toBe(0)
    expect(await getFsrsSettings()).toEqual({ w: W21, desired_retention: 0.88, optimized_at: 5, optimized_reviews: 900 })
  })

  it('墓碑列視同沒設定', async () => {
    await db.settings.put({ id: 'fsrs', value: JSON.stringify({ desired_retention: 0.8 }), updated_at: 1, deleted: 1, dirty: 0 })
    expect((await getFsrsSettings()).desired_retention).toBe(0.9)
  })
})
