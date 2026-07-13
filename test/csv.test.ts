import { describe, it, expect } from 'vitest'
import { parseCsv, autoMapHeaders, mapRows, noteKey, dedupeRows, exportCsv } from '../src/lib/csv'
import type { NoteRecord } from '../shared/types'

const VOCAB_SAMPLE = `id,漢字,拼音,中文翻譯
0001,たった今,たったいま,剛才
0473,空く,すく,空、不擁擠
0779,空く,あく,空出、空著
0002,引用,いんよう,"引用,引述"`

describe('parseCsv', () => {
  it('解析含引號逗號的列並略過空行', () => {
    const rows = parseCsv(VOCAB_SAMPLE)
    expect(rows).toHaveLength(5)
    expect(rows[4][3]).toBe('引用,引述')
  })
})

describe('autoMapHeaders', () => {
  it('認得 vocab.csv 表頭並忽略 id 欄', () => {
    expect(autoMapHeaders(['id', '漢字', '拼音', '中文翻譯'])).toEqual({ expression: 1, reading: 2, meaning: 3 })
  })
  it('認得 front/back 表頭(無讀音)', () => {
    expect(autoMapHeaders(['front', 'back'])).toEqual({ expression: 0, reading: null, meaning: 1 })
  })
  it('認不得時回傳 null(首列是資料而非表頭)', () => {
    expect(autoMapHeaders(['0001', 'たった今', 'たったいま', '剛才'])).toBeNull()
  })
})

describe('mapRows', () => {
  it('依 mapping 取值、修剪空白、丟掉缺單字或缺意思的列', () => {
    const rows = [
      ['1', ' 犬 ', 'いぬ', ' 狗 '],
      ['2', '', 'x', 'y'],
      ['3', 'z', 'w', ''],
    ]
    expect(mapRows(rows, { expression: 1, reading: 2, meaning: 3 })).toEqual([
      { expression: '犬', reading: 'いぬ', meaning: '狗' },
    ])
  })
  it('mapping.reading 為 null 時讀音為空字串', () => {
    expect(mapRows([['a', 'b']], { expression: 0, reading: null, meaning: 1 })).toEqual([
      { expression: 'a', reading: '', meaning: 'b' },
    ])
  })
})

describe('dedupeRows', () => {
  it('同字不同讀音不算重複(空く/すく vs 空く/あく)', () => {
    const rows = [
      { expression: '空く', reading: 'すく', meaning: '空、不擁擠' },
      { expression: '空く', reading: 'あく', meaning: '空出、空著' },
    ]
    const { toImport, skipped } = dedupeRows(rows, new Set())
    expect(toImport).toHaveLength(2)
    expect(skipped).toHaveLength(0)
  })
  it('檔案內重複與既有資料重複都會被跳過', () => {
    const rows = [
      { expression: '開く', reading: 'ひらく', meaning: '打開' },
      { expression: '開く', reading: 'ひらく', meaning: '開辦' },
      { expression: '犬', reading: 'いぬ', meaning: '狗' },
    ]
    const existing = new Set([noteKey('犬', 'いぬ')])
    const { toImport, skipped } = dedupeRows(rows, existing)
    expect(toImport).toEqual([rows[0]])
    expect(skipped).toEqual([rows[1], rows[2]])
  })
})

describe('exportCsv', () => {
  it('輸出 單字,讀音,意思 表頭並跳過墓碑', () => {
    const notes = [
      { id: '1', deck_id: 'd', expression: '犬', reading: 'いぬ', meaning: '狗', reversed: 0, updated_at: 0, deleted: 0 },
      { id: '2', deck_id: 'd', expression: '猫', reading: 'ねこ', meaning: '貓', reversed: 0, updated_at: 0, deleted: 1 },
    ] satisfies NoteRecord[]
    const csv = exportCsv(notes)
    expect(csv.split('\n')[0]).toBe('單字,讀音,意思')
    expect(csv).toContain('犬')
    expect(csv).not.toContain('猫')
  })
})
