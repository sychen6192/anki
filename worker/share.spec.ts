import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import app from './index'

const rows = [
  { expression: '勉強', reading: 'べんきょう', meaning: '讀書', accent: '0' },
  { expression: '猫', reading: 'ねこ', meaning: '貓', accent: '' },
]

async function create(body: unknown): Promise<Response> {
  return app.request('/api/share', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }, env)
}

describe('/api/share', () => {
  it('建立分享 → 用 code 取回同樣的內容', async () => {
    const res = await create({ name: '日檢單字', rows })
    expect(res.status).toBe(200)
    const { code } = await res.json<{ code: string }>()
    expect(code).toMatch(/^[a-z2-9]{8}$/)

    const got = await app.request(`/api/share/${code}`, {}, env)
    expect(got.status).toBe(200)
    expect(await got.json()).toEqual({ name: '日檢單字', rows })
  })

  it('不存在的 code 回 404', async () => {
    const got = await app.request('/api/share/nosuchcode', {}, env)
    expect(got.status).toBe(404)
  })

  it('缺 name、rows 為空、或列缺單字/意思 → 400', async () => {
    expect((await create({ rows })).status).toBe(400)
    expect((await create({ name: 'x', rows: [] })).status).toBe(400)
    expect((await create({ name: 'x', rows: [{ expression: '', meaning: 'y' }] })).status).toBe(400)
    expect((await create({ name: 'x', rows: [{ expression: 'x' }] })).status).toBe(400)
  })

  it('接受 gzip 壓縮的 body(x-body-gzip: 1)', async () => {
    const json = JSON.stringify({ name: '壓縮測試', rows })
    const gz = await new Response(
      new Blob([json]).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer()
    const res = await app.request('/api/share', {
      method: 'POST', body: gz,
      headers: { 'content-type': 'application/json', 'x-body-gzip': '1' },
    }, env)
    expect(res.status).toBe(200)
    const { code } = await res.json<{ code: string }>()
    const got = await (await app.request(`/api/share/${code}`, {}, env)).json()
    expect(got).toEqual({ name: '壓縮測試', rows })
  })

  it('缺 reading/accent 的列補空字串存入', async () => {
    const res = await create({ name: 'n', rows: [{ expression: '猫', meaning: '貓' }] })
    expect(res.status).toBe(200)
    const { code } = await res.json<{ code: string }>()
    const got = await (await app.request(`/api/share/${code}`, {}, env)).json()
    expect(got).toEqual({ name: 'n', rows: [{ expression: '猫', reading: '', meaning: '貓', accent: '' }] })
  })
})
