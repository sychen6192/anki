import { describe, it, expect } from 'vitest'
import {
  parseCsv, autoMapHeaders, mapRows, noteKey, dedupeRows, exportCsv, findDuplicateNote, decodeCsvBytes, encodingNote,
} from '../src/lib/csv'
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
    expect(autoMapHeaders(['id', '漢字', '拼音', '中文翻譯'])).toEqual({ expression: 1, reading: 2, meaning: 3, accent: null })
  })
  it('認得 front/back 表頭(無讀音無重音)', () => {
    expect(autoMapHeaders(['front', 'back'])).toEqual({ expression: 0, reading: null, meaning: 1, accent: null })
  })
  it('認得重音欄', () => {
    expect(autoMapHeaders(['漢字', '讀音', '意思', '重音'])).toEqual({ expression: 0, reading: 1, meaning: 2, accent: 3 })
  })
  it('認不得時回傳 null(首列是資料而非表頭)', () => {
    expect(autoMapHeaders(['0001', 'たった今', 'たったいま', '剛才'])).toBeNull()
  })
  // Anki 匯出與日文教材最常見的表頭;apkg 匯入認得,CSV 卻不認得 —— 兩邊要一致
  it('認得日文表頭 単語/読み/意味/アクセント', () => {
    expect(autoMapHeaders(['単語', '読み', '意味', 'アクセント'])).toEqual({ expression: 0, reading: 1, meaning: 2, accent: 3 })
  })
  it('認得語彙/訳 這類 apkg 常見表頭', () => {
    expect(autoMapHeaders(['語彙', 'よみ', '訳'])).toEqual({ expression: 0, reading: 1, meaning: 2, accent: null })
  })
})

describe('mapRows', () => {
  it('依 mapping 取值、修剪空白、丟掉缺單字或缺意思的列', () => {
    const rows = [
      ['1', ' 犬 ', 'いぬ', ' 狗 '],
      ['2', '', 'x', 'y'],
      ['3', 'z', 'w', ''],
    ]
    expect(mapRows(rows, { expression: 1, reading: 2, meaning: 3, accent: null })).toEqual([
      { expression: '犬', reading: 'いぬ', meaning: '狗', accent: '' },
    ])
  })
  it('mapping.reading 為 null 時讀音為空字串', () => {
    expect(mapRows([['a', 'b']], { expression: 0, reading: null, meaning: 1, accent: null })).toEqual([
      { expression: 'a', reading: '', meaning: 'b', accent: '' },
    ])
  })
  it('重音欄的全形數字與頓號先統一成 0,2', () => {
    expect(mapRows([['犬', 'いぬ', '狗', '０、２']], { expression: 0, reading: 1, meaning: 2, accent: 3 }))
      .toEqual([{ expression: '犬', reading: 'いぬ', meaning: '狗', accent: '0,2' }])
  })
  it('讀取重音欄;不合法值清成空字串', () => {
    const rows = [['犬', 'いぬ', '狗', '1'], ['猫', 'ねこ', '貓', 'bad']]
    expect(mapRows(rows, { expression: 0, reading: 1, meaning: 2, accent: 3 })).toEqual([
      { expression: '犬', reading: 'いぬ', meaning: '狗', accent: '1' },
      { expression: '猫', reading: 'ねこ', meaning: '貓', accent: '' },
    ])
  })
})

describe('dedupeRows', () => {
  it('同字不同讀音不算重複(空く/すく vs 空く/あく)', () => {
    const rows = [
      { expression: '空く', reading: 'すく', meaning: '空、不擁擠', accent: '' },
      { expression: '空く', reading: 'あく', meaning: '空出、空著', accent: '' },
    ]
    const { toImport, skipped } = dedupeRows(rows, new Set())
    expect(toImport).toHaveLength(2)
    expect(skipped).toHaveLength(0)
  })
  it('檔案內重複與既有資料重複都會被跳過', () => {
    const rows = [
      { expression: '開く', reading: 'ひらく', meaning: '打開', accent: '' },
      { expression: '開く', reading: 'ひらく', meaning: '開辦', accent: '' },
      { expression: '犬', reading: 'いぬ', meaning: '狗', accent: '' },
    ]
    const existing = new Set([noteKey('犬', 'いぬ')])
    const { toImport, skipped } = dedupeRows(rows, existing)
    expect(toImport).toEqual([rows[0]])
    expect(skipped).toEqual([rows[1], rows[2]])
  })
})

describe('exportCsv', () => {
  it('輸出 單字,讀音,意思,重音 表頭並跳過墓碑', () => {
    const notes = [
      { id: '1', deck_id: 'd', expression: '犬', reading: 'いぬ', meaning: '狗', accent: '2', reversed: 0, updated_at: 0, deleted: 0 },
      { id: '2', deck_id: 'd', expression: '猫', reading: 'ねこ', meaning: '貓', accent: '', reversed: 0, updated_at: 0, deleted: 1 },
    ] satisfies NoteRecord[]
    const csv = exportCsv(notes)
    // 開頭有 BOM(給 Excel 認 UTF-8),自己的匯入照樣讀得懂
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv.split('\n')[0]).toBe('\uFEFF單字,讀音,意思,重音')
    expect(parseCsv(csv)[0]).toEqual(['單字', '讀音', '意思', '重音'])
    expect(csv).toContain('犬,いぬ,狗,2')
    expect(csv).not.toContain('猫')
  })
})

describe('decodeCsvBytes', () => {
  it('UTF-8 照讀;Excel 存的 Big5 自動認出來', () => {
    const utf8 = new TextEncoder().encode('單字,意思\n犬,狗\n')
    expect(decodeCsvBytes(utf8)).toEqual({ text: '單字,意思\n犬,狗\n', encoding: 'utf-8' })
    // 「單字,意思」的 Big5:B3E6 A672 2C B74E AB E4
    const big5 = new Uint8Array([0xb3, 0xe6, 0xa6, 0x72, 0x2c, 0xb7, 0x4e, 0xab, 0xe4])
    expect(decodeCsvBytes(big5)).toEqual({ text: '單字,意思', encoding: 'big5' })
  })

  it('開頭有 BOM 的 UTF-16(Excel 的「Unicode 文字」)照 BOM 解,表頭認得出來', () => {
    const text = '單字\t意思\n犬\t狗\n'
    const le = new Uint8Array(2 + text.length * 2)
    le.set([0xff, 0xfe])
    const be = new Uint8Array(2 + text.length * 2)
    be.set([0xfe, 0xff])
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      le[2 + i * 2] = c & 0xff; le[3 + i * 2] = c >> 8
      be[2 + i * 2] = c >> 8; be[3 + i * 2] = c & 0xff
    }
    expect(decodeCsvBytes(le)).toEqual({ text, encoding: 'utf-16le' })
    expect(decodeCsvBytes(be)).toEqual({ text, encoding: 'utf-16be' })
    expect(autoMapHeaders(parseCsv(decodeCsvBytes(le).text)[0])).not.toBeNull()
  })

  it('哪一種都解不開就照實說,不假裝是 UTF-8', () => {
    const junk = new Uint8Array([0xc3, 0x28, 0xa0, 0xa1, 0xff, 0x80, 0x81])
    expect(decodeCsvBytes(junk).encoding).toBe('unknown')
    expect(encodingNote('unknown')).toMatch(/亂碼/)
    expect(encodingNote('utf-8')).toBe('')
    expect(encodingNote('utf-16le')).toMatch(/UTF-16/)
  })
})

describe('parseCsv:Excel 留下的空白列', () => {
  it('只有逗號或空白的列不算一列', () => {
    expect(parseCsv('單字,意思\n犬,狗\n,,\n  \n , \n猫,貓\n,,\n')).toEqual([['單字', '意思'], ['犬', '狗'], ['猫', '貓']])
  })
})

describe('findDuplicateNote', () => {
  const n = (id: string, expression: string, reading: string, deleted: 0 | 1 = 0) => ({ id, expression, reading, deleted })
  const notes = [n('a', '試験', 'しけん'), n('b', '犬', ''), n('c', '猫', 'ねこ', 1)]

  it('單字+讀音相同(修剪空白後)就是重複', () => {
    expect(findDuplicateNote(notes, ' 試験 ', 'しけん ')?.id).toBe('a')
    expect(findDuplicateNote(notes, '犬', '')?.id).toBe('b')
  })

  it('excludeId 只排除自己:同一個字還有另一筆時照樣找得到', () => {
    expect(findDuplicateNote(notes, '試験', 'しけん', 'b')?.id).toBe('a')
    const twins = [n('a', '試験', 'しけん'), n('x', '試験', 'しけん')]
    expect(findDuplicateNote(twins, '試験', 'しけん', 'a')?.id).toBe('x')
  })

  it('讀音不同、已刪除的、或是自己,都不算', () => {
    expect(findDuplicateNote(notes, '試験', 'しけんかん')).toBeUndefined()
    expect(findDuplicateNote(notes, '猫', 'ねこ')).toBeUndefined()
    expect(findDuplicateNote(notes, '試験', 'しけん', 'a')).toBeUndefined()
  })
})
