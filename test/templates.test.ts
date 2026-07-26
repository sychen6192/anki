import { describe, it, expect } from 'vitest'
import { DECK_TEMPLATES } from '../src/data/templates'
import { autoMapHeaders, mapRows, noteKey, parseCsv } from '../src/lib/csv'

// 範本是要「一鍵匯入」給新手的,資料品質直接砸在第一印象上:
// 筆數對、表頭認得、讀音沒殘留漢字、沒有重複、每筆都有意思。
//
// csv 是動態 import 進來的,先在收集階段全部載完再展開 describe。
const loaded = await Promise.all(
  DECK_TEMPLATES.map(async (t) => ({ t, csv: await t.loadCsv() })),
)

// 讀音容許平假名/片假名與課本本身就有的符號(～、「」、（）、數字、JR 這類外語縮寫),
// 但不能有漢字 —— 那代表來源的 furigana 沒標到,匯入後查不到重音也唸不出來。
const KANJI = /[㐀-䶿一-鿿]/u

describe('內建範本牌組', () => {
  it('至少有兩份範本,id 與名稱不重複', () => {
    expect(DECK_TEMPLATES.length).toBeGreaterThanOrEqual(2)
    expect(new Set(DECK_TEMPLATES.map((t) => t.id)).size).toBe(DECK_TEMPLATES.length)
    expect(new Set(DECK_TEMPLATES.map((t) => t.name)).size).toBe(DECK_TEMPLATES.length)
  })

  for (const { t, csv } of loaded) {
    describe(t.name, () => {
      const rows = parseCsv(csv)
      const mapping = autoMapHeaders(rows[0])

      it('表頭可自動對應(單字/讀音/意思)', () => {
        expect(mapping).not.toBeNull()
        expect(mapping!.reading).not.toBeNull()
      })

      const parsed = mapRows(rows.slice(1), mapping!)

      it(`筆數與宣告一致(${t.count} 筆)`, () => {
        expect(parsed.length).toBe(t.count)
      })

      // 沒引號的 csv 只要有半形逗號就會多切一欄,整列往後錯位
      it('每列剛好三欄,沒有半形逗號', () => {
        for (const [i, row] of rows.entries()) {
          expect(row, `第 ${i + 1} 列:${row.join('|')}`).toHaveLength(3)
        }
      })

      it('讀音是假名,沒有殘留漢字', () => {
        for (const r of parsed) {
          expect(r.reading, `${r.expression} 缺讀音`).not.toBe('')
          expect(KANJI.test(r.reading), `${r.expression} 的讀音「${r.reading}」含漢字`).toBe(false)
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

      // preview 手寫在 metadata 裡(才不用為了畫一張卡就把整包 csv 拉下來),容易跟資料走鐘
      it('preview 與 csv 前三筆一致', () => {
        expect(t.preview).toBe(parsed.slice(0, 3).map((r) => r.expression).join('、') + '…')
      })
    })
  }
})
