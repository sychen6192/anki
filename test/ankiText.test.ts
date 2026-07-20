import { describe, it, expect } from 'vitest'
import { stripAnkiHtml, splitFurigana } from '../src/lib/ankiText'

describe('stripAnkiHtml', () => {
  it('去掉一般標籤但保留文字', () => {
    expect(stripAnkiHtml('<b>勉強</b>する')).toBe('勉強する')
  })

  it('去掉註解、style 與 script 區塊', () => {
    expect(stripAnkiHtml('<!-- c -->A<style>.x{color:red}</style>B<script>x()</script>C')).toBe('ABC')
  })

  it('區塊標籤換成空白,避免相鄰內容黏在一起', () => {
    expect(stripAnkiHtml('<div>上</div><div>下</div>')).toBe('上 下')
    expect(stripAnkiHtml('一<br>二')).toBe('一 二')
  })

  it('解 HTML entity(具名與數值)並把 NBSP 正規化成空白', () => {
    expect(stripAnkiHtml('a&nbsp;b')).toBe('a b')
    expect(stripAnkiHtml('a&#160;b')).toBe('a b')
    expect(stripAnkiHtml('a&#xa0;b')).toBe('a b')
    expect(stripAnkiHtml('&amp;&lt;&gt;')).toBe('&<>')
  })

  it('不認得的 entity 原樣保留', () => {
    expect(stripAnkiHtml('&zzz;')).toBe('&zzz;')
  })

  it('拿掉 [sound:] 標籤', () => {
    expect(stripAnkiHtml('食べる[sound:tabe.mp3]')).toBe('食べる')
  })

  it('拿掉 img 標籤', () => {
    expect(stripAnkiHtml('答案<img src="a.jpg">')).toBe('答案')
  })

  it('cloze 只留答案文字', () => {
    expect(stripAnkiHtml('{{c1::東京}}は日本の首都')).toBe('東京は日本の首都')
  })

  it('cloze 的提示被丟掉,支援多編號', () => {
    expect(stripAnkiHtml('{{c1,2::東京::地名}}')).toBe('東京')
  })

  it('壓縮多餘空白並去頭尾', () => {
    expect(stripAnkiHtml('  a   \n b  ')).toBe('a b')
  })

  it('空字串安全', () => {
    expect(stripAnkiHtml('')).toBe('')
  })
})

describe('splitFurigana', () => {
  it('沒有 furigana 時 reading 為空', () => {
    expect(splitFurigana('食べる')).toEqual({ base: '食べる', reading: '' })
  })

  it('拆出基底與讀音', () => {
    expect(splitFurigana('食[た]べる')).toEqual({ base: '食べる', reading: 'たべる' })
  })

  it('多段 furigana 的前導空白會被吃掉(Anki 行為)', () => {
    expect(splitFurigana('私[わたし]は 学生[がくせい]です'))
      .toEqual({ base: '私は学生です', reading: 'わたしはがくせいです' })
  })

  it('[sound:] 不算 furigana', () => {
    expect(splitFurigana('食べる[sound:x.mp3]'))
      .toEqual({ base: '食べる[sound:x.mp3]', reading: '' })
  })

  it('重複呼叫結果一致(regex lastIndex 不殘留)', () => {
    const once = splitFurigana('食[た]べる')
    expect(splitFurigana('食[た]べる')).toEqual(once)
  })
})
