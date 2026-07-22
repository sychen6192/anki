import { describe, it, expect } from 'vitest'
import { generateSyncKey } from '../src/lib/space'

describe('generateSyncKey', () => {
  it('格式為 xxxx-xxxx-xxxx,不含易混淆字元(i/l/o/0/1)', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSyncKey()).toMatch(/^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/)
    }
  })

  it('每次產生的不一樣', () => {
    const keys = new Set(Array.from({ length: 20 }, () => generateSyncKey()))
    expect(keys.size).toBe(20)
  })
})
