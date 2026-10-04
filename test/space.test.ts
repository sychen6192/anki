import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { db } from '../src/db/db'
import { generateSyncKey, normalizeSyncKey, setSyncSpace } from '../src/lib/space'
import { isStandardSyncKey, SYNC_KEY_ALPHABET } from '../shared/syncKey'

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

  it('產生的都是伺服器認得的標準格式', () => {
    for (let i = 0; i < 50; i++) expect(isStandardSyncKey(generateSyncKey())).toBe(true)
  })
})

describe('isStandardSyncKey(伺服器只讓這種格式開新空間)', () => {
  it('字母表 31 個字,不含易混淆的 i/l/o/0/1', () => {
    expect(SYNC_KEY_ALPHABET).toHaveLength(31)
    expect(SYNC_KEY_ALPHABET).not.toMatch(/[ilo01]/)
  })

  it('只認 xxxx-xxxx-xxxx 小寫、字母表內的字', () => {
    expect(isStandardSyncKey('abcd-efgh-jkmn')).toBe(true)
    expect(isStandardSyncKey('test-test-test')).toBe(true)
    for (const bad of ['', 'test', '1234', 'ABCD-EFGH-JKMN', 'abcd-efgh-jkmno', 'abcdefghjkmn', 'abcd-efgh-jkm1', 'abcd-efgh-jkmi', ' abcd-efgh-jkmn']) {
      expect(isStandardSyncKey(bad), bad).toBe(false)
    }
  })

  it('手打的標準金鑰正規化之後就是標準格式', () => {
    expect(isStandardSyncKey(normalizeSyncKey('ABCD EFGH JKMN').key)).toBe(true)
    expect(isStandardSyncKey(normalizeSyncKey('ａｂｃｄーｅｆｇｈーｊｋｍｎ').key)).toBe(true)
    expect(isStandardSyncKey(normalizeSyncKey('my-old-key').key)).toBe(false)
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
