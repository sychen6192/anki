import { describe, it, expect } from 'vitest'
import { autoMapFields, mapApkgNotes } from '../src/lib/apkgMap'
import type { ApkgNote } from '../src/lib/apkg'

const note = (...fields: string[]): ApkgNote => ({ notetypeId: '1', fields })

describe('autoMapFields', () => {
  it('對應常見英文欄位名', () => {
    expect(autoMapFields(['Expression', 'Reading', 'Meaning']))
      .toEqual({ expression: 0, reading: 1, meaning: 2, accent: null })
  })

  it('對應日文欄位名', () => {
    expect(autoMapFields(['意味', '単語', '読み']))
      .toEqual({ expression: 1, reading: 2, meaning: 0, accent: null })
  })

  it('忽略大小寫、空白與底線', () => {
    expect(autoMapFields(['WORD', 'pitch_accent', 'English']))
      .toEqual({ expression: 0, reading: null, meaning: 2, accent: 1 })
  })

  it('複合欄位名以部分比對命中', () => {
    expect(autoMapFields(['Vocabulary-Kanji', 'Vocabulary-Furigana', 'Meaning (Chinese)']))
      .toEqual({ expression: 0, reading: 1, meaning: 2, accent: null })
  })

  it('猜不到時退回位置對應:三欄以上', () => {
    expect(autoMapFields(['A', 'B', 'C']))
      .toEqual({ expression: 0, reading: 1, meaning: 2, accent: null })
  })

  it('猜不到時退回位置對應:兩欄', () => {
    expect(autoMapFields(['A', 'B']))
      .toEqual({ expression: 0, reading: null, meaning: 1, accent: null })
  })

  it('只猜到單字時不硬塞讀音欄', () => {
    expect(autoMapFields(['Front', 'X', 'Y']))
      .toEqual({ expression: 0, reading: null, meaning: 2, accent: null })
  })
})

describe('mapApkgNotes', () => {
  const mapping = { expression: 0, reading: 1, meaning: 2, accent: null }

  it('清掉欄位裡的 HTML 與 sound 標籤', () => {
    expect(mapApkgNotes([note('<b>食べる</b>[sound:a.mp3]', 'たべる', '吃<br>食用')], mapping))
      .toEqual([{ expression: '食べる', reading: 'たべる', meaning: '吃 食用', accent: '' }])
  })

  it('沒有讀音欄時從單字欄的 furigana 拆出讀音', () => {
    const rows = mapApkgNotes([note('食[た]べる', '吃')], { expression: 0, reading: null, meaning: 1, accent: null })
    expect(rows).toEqual([{ expression: '食べる', reading: 'たべる', meaning: '吃', accent: '' }])
  })

  it('讀音欄存在但該筆為空時,一樣用 furigana 補', () => {
    expect(mapApkgNotes([note('飲[の]む', '', '喝')], mapping))
      .toEqual([{ expression: '飲む', reading: 'のむ', meaning: '喝', accent: '' }])
  })

  it('單字欄沒有 furigana 時原樣保留', () => {
    expect(mapApkgNotes([note('ひらがな', '', '平假名')], mapping))
      .toEqual([{ expression: 'ひらがな', reading: '', meaning: '平假名', accent: '' }])
  })

  it('只收合法的重音值', () => {
    const m = { expression: 0, reading: 1, meaning: 2, accent: 3 }
    expect(mapApkgNotes([note('端', 'はし', '邊緣', '0'), note('橋', 'はし', '橋', 'high')], m)
      .map((r) => r.accent)).toEqual(['0', ''])
  })

  it('缺少的欄位索引不會爆,視為空字串', () => {
    expect(mapApkgNotes([note('単語')], mapping)).toEqual([])
  })

  it('單字或意思為空的列會被濾掉', () => {
    expect(mapApkgNotes([note('', 'よみ', '意思'), note('単語', 'よみ', ''), note('本', 'ほん', '書')], mapping))
      .toHaveLength(1)
  })
})
