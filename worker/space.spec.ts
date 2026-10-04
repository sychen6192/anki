import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import app, { rateLimitKey } from './index'

const empty = { decks: [], notes: [], cards: [], review_logs: [], settings: [] }
const K = 'kkkk-kkkk-kkkk'
const OTHER = 'pppp-pppp-pppp'

const deck = (over: Record<string, unknown> = {}) => ({
  id: 'd1', name: '日文', new_per_day: 20, updated_at: 1000, deleted: 0, ...over,
})
const note = (over: Record<string, unknown> = {}) => ({
  id: 'n1', deck_id: 'd1', expression: '犬', reading: 'いぬ', meaning: '狗', accent: '', reversed: 0,
  updated_at: 1000, deleted: 0, ...over,
})
const log = (over: Record<string, unknown> = {}) => ({
  id: 'l1', card_id: 'c1', rating: 3, state: 0, due: 1, stability: 1, difficulty: 5,
  elapsed_days: 0, last_elapsed_days: 0, scheduled_days: 1, reviewed_at: 999, ...over,
})

const req = (path: string, space: string | null, init: RequestInit = {}, ip?: string) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (space !== null) headers['x-sync-space'] = space
  if (ip !== undefined) headers['cf-connecting-ip'] = ip
  return app.request(path, { ...init, headers }, env)
}
const push = (space: string, body: unknown) => req('/api/sync', space, { method: 'POST', body: JSON.stringify(body) })
const pull = (space: string) => req('/api/sync?since=0', space)
const summary = (space: string) => req('/api/sync/summary', space)
const del = (space: string) => req('/api/sync', space, { method: 'DELETE' })

const countRows = async (space: string) => {
  let n = 0
  for (const t of ['decks', 'notes', 'cards', 'review_logs', 'settings']) {
    n += (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE namespace = ?`).bind(space).first<{ n: number }>())!.n
  }
  return n
}

describe('刪除雲端資料(DELETE /api/sync)', () => {
  it('五張表裡這個空間的列全部刪掉,別的空間原封不動', async () => {
    expect((await push(K, {
      ...empty, decks: [deck()], notes: [note()], review_logs: [log()],
      settings: [{ id: 'fsrs', value: '{}', updated_at: 1000, deleted: 0 }],
    })).status).toBe(200)
    expect((await push(OTHER, { ...empty, decks: [deck({ id: 'other' })] })).status).toBe(200)
    expect(await countRows(K)).toBe(4)
    const res = await del(K)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await countRows(K)).toBe(0)
    expect(await countRows(OTHER)).toBe(1)
  })

  it('刪過的金鑰:推、拉、查都回 410;再刪一次照樣成功', async () => {
    await push(K, { ...empty, decks: [deck()] })
    await del(K)
    for (const res of [await push(K, { ...empty, decks: [deck({ id: 'again' })] }), await pull(K), await summary(K)]) {
      expect(res.status).toBe(410)
      expect(await res.json()).toEqual({ error: 'space deleted' })
    }
    expect(await countRows(K)).toBe(0) // 被擋下的推送沒有寫進去
    expect((await del(K)).status).toBe(200)
  })

  it('只記金鑰的雜湊,不存金鑰本身', async () => {
    await push(K, { ...empty, decks: [deck()] })
    await del(K)
    const rows = (await env.DB.prepare('SELECT space_hash FROM deleted_spaces').all<{ space_hash: string }>()).results
    expect(rows).toHaveLength(1)
    expect(rows[0].space_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0].space_hash).not.toContain(K)
  })

  it('刪除之後才寫進來的列(另一台剛好推到一半):下一個請求收到 410 時順手清掉', async () => {
    await push(K, { ...empty, decks: [deck()] })
    await del(K)
    await env.DB.prepare(`INSERT INTO decks (id, name, new_per_day, updated_at, deleted, namespace, server_seq)
      VALUES ('late', '晚到的', 20, 1, 0, ?, 1)`).bind(K).run()
    expect(await countRows(K)).toBe(1)
    expect((await pull(K)).status).toBe(410)
    expect(await countRows(K)).toBe(0)
  })

  it('雲端沒東西的舊版自訂金鑰:沒有可刪的,回成功、不記', async () => {
    expect((await del('mykey')).status).toBe(200)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM deleted_spaces').first<{ n: number }>())!.n).toBe(0)
  })
})

describe('API 回應不快取', () => {
  it('一律 Cache-Control: no-store —— 同一個網址依金鑰是不同空間,410 又是瀏覽器預設可以快取的狀態碼', async () => {
    await push(K, { ...empty, decks: [deck()] })
    await del(K)
    for (const res of [await summary(K), await pull(K), await summary(OTHER), await pull(OTHER), await summary('test'),
      await app.request('/api/health', {}, env)]) {
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })
})

describe('只讓產生器格式的金鑰開新空間', () => {
  it('不是 xxxx-xxxx-xxxx、空間又沒東西:推、拉、查都回 400 invalid space,什麼都沒寫', async () => {
    for (const key of ['test', '1234', 'ABCD-EFGH-JKMN', 'abcd-efgh-jkm1']) {
      for (const res of [await push(key, { ...empty, decks: [deck()] }), await pull(key), await summary(key)]) {
        expect(res.status, key).toBe(400)
        expect(await res.json()).toEqual({ error: 'invalid space' })
      }
      expect(await countRows(key)).toBe(0)
    }
  })

  it('舊版自訂金鑰、雲端已經有資料的:照舊能推能拉', async () => {
    await env.DB.prepare(`INSERT INTO decks (id, name, new_per_day, updated_at, deleted, namespace, server_seq)
      VALUES ('old', '舊的', 20, 1, 0, 'JapanN3Z4xjv', 1)`).run()
    expect((await summary('JapanN3Z4xjv')).status).toBe(200)
    expect((await push('JapanN3Z4xjv', { ...empty, notes: [note({ deck_id: 'old' })] })).status).toBe(200)
    const out = await (await pull('JapanN3Z4xjv')).json() as { decks: unknown[]; notes: unknown[] }
    expect(out.decks).toHaveLength(1)
    expect(out.notes).toHaveLength(1)
    // 也能刪(之後一樣 410)
    expect((await del('JapanN3Z4xjv')).status).toBe(200)
    expect((await pull('JapanN3Z4xjv')).status).toBe(410)
  })

  it('產生器格式的新空間:空的也能查、能推', async () => {
    expect(await (await summary('zzzz-2222-xxxx')).json()).toEqual({ decks: 0, ids: [] })
    expect((await push('zzzz-2222-xxxx', { ...empty, decks: [deck()] })).status).toBe(200)
  })
})

/**
 * 本機的限流器以固定時間窗計數(每 60 秒整清零):測試剛好跨過清零的那一刻,第 21 次就會變成新窗的第 1 次。
 * 離清零不到 5 秒就先等到下一窗開始。
 */
async function freshWindow(periodSec: number): Promise<void> {
  const left = periodSec * 1000 - (Date.now() % (periodSec * 1000))
  if (left < 5000) await new Promise((r) => setTimeout(r, left + 50))
}

describe('限流', { timeout: 20_000 }, () => {
  it('同一個 IP 查空間超過 20 次/分鐘:429 帶 Retry-After;別的 IP、沒有 IP(本機)不受影響', async () => {
    const ip = '203.0.113.7'
    await freshWindow(60)
    for (let i = 0; i < 20; i++) expect((await req('/api/sync/summary', K, {}, ip)).status).toBe(200)
    const limited = await req('/api/sync/summary', K, {}, ip)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(await limited.json()).toEqual({ error: 'too many requests' })
    expect((await req('/api/sync/summary', K, {}, '203.0.113.8')).status).toBe(200)
    expect((await summary(K)).status).toBe(200)
  })

  it('同一段 IPv6 /64 共用額度', async () => {
    await freshWindow(60)
    for (let i = 0; i < 20; i++) {
      expect((await req('/api/sync/summary', K, {}, `2001:db8:1:2::${(i + 1).toString(16)}`)).status).toBe(200)
    }
    expect((await req('/api/sync/summary', K, {}, '2001:db8:1:2:ffff::1')).status).toBe(429)
    expect((await req('/api/sync/summary', K, {}, '2001:db8:1:3::1')).status).toBe(200)
  })

  it('建立分享:同一個 IP 一分鐘 10 次', async () => {
    const ip = '198.51.100.20'
    const share = () => app.request('/api/share', {
      method: 'POST', body: JSON.stringify({ name: '分享', rows: [{ expression: '犬', reading: 'いぬ', meaning: '狗' }] }),
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    }, env)
    await freshWindow(60)
    for (let i = 0; i < 10; i++) expect((await share()).status).toBe(200)
    expect((await share()).status).toBe(429)
  })

  it('rateLimitKey:IPv4 整個位址;IPv6 取前 64 位元(各種寫法同一段算同一個)', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7')
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(rateLimitKey('2001:0DB8:0000:0000:1:2:3:4')).toBe('2001:db8:0:0::/64')
    expect(rateLimitKey('2001:db8:aa:bb:cc::')).toBe('2001:db8:aa:bb::/64')
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64')
    expect(rateLimitKey('::ffff:198.51.100.1')).toBe('198.51.100.1')
  })
})
