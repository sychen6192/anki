import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { db } from '../src/db/db'
import { generateSyncKey, setSyncSpace } from '../src/lib/space'

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

describe('setSyncSpace 首次選擇', () => {
  it('全新安裝時 meta 沒有 sync_space;選了空白金鑰後 meta 記下「已選擇」', async () => {
    await db.delete()
    await db.open()
    expect(await db.meta.get('sync_space')).toBeUndefined()
    await setSyncSpace('')
    const row = await db.meta.get('sync_space')
    expect(row?.value).toBe('') // 空白也算選過:之後同步不再被首次啟動閘門擋下
  })
})
