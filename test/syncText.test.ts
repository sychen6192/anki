import { describe, expect, it } from 'vitest'
import { humanizeSyncError, syncMessage } from '../src/lib/syncText'
import { normalizeSyncKey } from '../src/lib/space'

describe('humanizeSyncError', () => {
  it('網路錯誤、5xx、其他代碼都講人話,並說資料還在', () => {
    expect(humanizeSyncError('Load failed')).toMatch(/^連不上伺服器/)
    expect(humanizeSyncError('Failed to fetch')).toMatch(/^連不上伺服器/)
    expect(humanizeSyncError('push failed: 503')).toMatch(/^伺服器暫時有問題/)
    expect(humanizeSyncError('pull failed: 403')).toContain('代碼 403')
    expect(humanizeSyncError('pull failed: 404')).toContain('代碼 404')
    for (const e of ['Load failed', 'push failed: 500', 'pull failed: 404', '怪錯誤']) {
      expect(humanizeSyncError(e)).toContain('資料都還在這台')
    }
  })
  it('syncMessage:成功用給定文字,離線與純本機各有說法', () => {
    expect(syncMessage({ ok: true }, '好了')).toBe('好了')
    expect(syncMessage({ ok: false, skipped: true, reason: 'offline' }, '')).toMatch(/離線/)
    expect(syncMessage({ ok: false, skipped: true, reason: 'local-only' }, '')).toMatch(/只存在這台/)
    expect(syncMessage({ ok: false, error: 'push failed: 500' }, '')).toMatch(/^伺服器暫時有問題/)
  })
})

describe('normalizeSyncKey', () => {
  it('大寫、空白、全形、少了連字號都轉成標準格式', () => {
    for (const raw of ['BVJ6-AM4P-AD9Q', 'bvj6 am4p ad9q', ' ｂｖｊ６－ａｍ４ｐ－ａｄ９ｑ ', 'bvj6am4pad9q', 'bvj6ーam4pーad9q']) {
      expect(normalizeSyncKey(raw)).toEqual({ key: 'bvj6-am4p-ad9q', standard: true })
    }
  })
  it('不像產生出來的金鑰原樣保留(舊版自訂金鑰大小寫有差),標成非標準', () => {
    expect(normalizeSyncKey(' MySpace ')).toEqual({ key: 'MySpace', standard: false })
    // 含產生器不用的 0/1/o/l/i:多半是抄錯,原樣保留讓畫面提醒
    expect(normalizeSyncKey('bvj0-am4p-ad9q').standard).toBe(false)
    expect(normalizeSyncKey('').key).toBe('')
  })
})
