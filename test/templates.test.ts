import { describe, it, expect } from 'vitest'
import { DECK_TEMPLATES } from '../src/data/templates'
import { autoMapHeaders, mapRows, noteKey, parseCsv } from '../src/lib/csv'

// 範本是要「一鍵匯入」給新手的,資料品質直接砸在第一印象上:
// 筆數對、表頭認得、讀音全平假名、沒有重複、每筆都有意思。
describe('內建範本牌組', () => {
  it('至少有三份範本,id 與名稱不重複', () => {
    expect(DECK_TEMPLATES.length).toBeGreaterThanOrEqual(3)
    expect(new Set(DECK_TEMPLATES.map((t) => t.id)).size).toBe(DECK_TEMPLATES.length)
    expect(new Set(DECK_TEMPLATES.map((t) => t.name)).size).toBe(DECK_TEMPLATES.length)
  })

  for (const t of DECK_TEMPLATES) {
    describe(t.name, () => {
      const rows = parseCsv(t.csv)
      const mapping = autoMapHeaders(rows[0])

      it('表頭可自動對應(單字/讀音/意思)', () => {
        expect(mapping).not.toBeNull()
        expect(mapping!.reading).not.toBeNull()
      })

      const parsed = mapRows(rows.slice(1), mapping!)

      it(`筆數與宣告一致(${t.count} 筆)`, () => {
        expect(parsed.length).toBe(t.count)
      })

      it('讀音全為平假名', () => {
        for (const r of parsed) {
          expect(r.reading, `${r.expression} 的讀音「${r.reading}」`).toMatch(/^[ぁ-ゖー]+$/u)
        }
      })

      it('每筆都有意思,且「單字+讀音」不重複', () => {
        const keys = new Set<string>()
        for (const r of parsed) {
          expect(r.meaning).not.toBe('')
          const k = noteKey(r.expression, r.reading)
          expect(keys.has(k), `重複:${r.expression}(${r.reading})`).toBe(false)
          keys.add(k)
        }
      })
    })
  }
})
