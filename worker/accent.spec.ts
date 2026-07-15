import { env } from 'cloudflare:test'
import { beforeEach, describe, it, expect } from 'vitest'
import app from './index'

async function seed(rows: [string, string, string][]) {
  for (const [expression, reading, pitch] of rows) {
    await env.DB.prepare('INSERT INTO accent_dict (expression, reading, pitch) VALUES (?, ?, ?)')
      .bind(expression, reading, pitch).run()
  }
}

async function lookup(items: unknown): Promise<Response> {
  return app.request('/api/accent/lookup', {
    method: 'POST', body: JSON.stringify({ items }),
    headers: { 'content-type': 'application/json' },
  }, env)
}

beforeEach(async () => {
  await seed([
    ['食べる', 'たべる', '2'],
    ['箸', 'はし', '1'],
    ['橋', 'はし', '2'],        // 同読み不同 pitch → 読み反查應「不猜」
    ['駅', 'えき', '1'],        // 唯一 えき
    ['簡単', 'かんたん', '3'],   // な形容詞去尾後的本體
  ])
})

describe('/api/accent/lookup', () => {
  it('精確命中(漢字+読み)', async () => {
    const res = await lookup([{ expression: '食べる', reading: 'たべる' }])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: ['2'] })
  })

  it('読み反查:唯一解採用,多解不猜(回 null)', async () => {
    const res = await lookup([
      { expression: '駅前', reading: 'えき' },   // 漢字不同但読み唯一 → '1'
      { expression: '端', reading: 'はし' },     // はし 有兩種 pitch → null
    ])
    expect(await res.json()).toEqual({ results: ['1', null] })
  })

  it('な形容詞:去尾「な」後精確命中', async () => {
    const res = await lookup([{ expression: '簡単な', reading: 'かんたんな' }])
    expect(await res.json()).toEqual({ results: ['3'] })
  })

  it('查無回 null', async () => {
    const res = await lookup([{ expression: 'ぜんぜんない', reading: 'ぜんぜんない' }])
    expect(await res.json()).toEqual({ results: [null] })
  })

  it('片假名 reading 正規化為平假名後仍命中', async () => {
    const res = await lookup([{ expression: '食べる', reading: 'タベル' }])
    expect(await res.json()).toEqual({ results: ['2'] })
  })

  it('items 非陣列 / 空 / 超過 200 / 元素缺欄位 → 400', async () => {
    expect((await lookup('nope')).status).toBe(400)
    expect((await lookup([])).status).toBe(400)
    expect((await lookup(Array.from({ length: 201 }, () => ({ expression: 'a', reading: 'b' })))).status).toBe(400)
    expect((await lookup([{ expression: 'a' }])).status).toBe(400)
  })
})
