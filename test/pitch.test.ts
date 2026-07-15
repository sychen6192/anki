import { describe, it, expect } from 'vitest'
import { splitMorae, pitchPattern } from '../src/lib/pitch'

describe('splitMorae', () => {
  it('小假名(拗音)併入前一拍', () => {
    expect(splitMorae('きょう')).toEqual(['きょ', 'う'])       // 2 拍
    expect(splitMorae('しゅう')).toEqual(['しゅ', 'う'])
  })
  it('促音 っ、撥音 ん、長音 ー 各自成拍', () => {
    expect(splitMorae('がっこう')).toEqual(['が', 'っ', 'こ', 'う']) // 4 拍
    expect(splitMorae('しんぶん')).toEqual(['し', 'ん', 'ぶ', 'ん']) // 4 拍
    expect(splitMorae('ケーキ')).toEqual(['ケ', 'ー', 'キ'])         // 3 拍(片假名長音)
  })
  it('一般假名逐字一拍', () => {
    expect(splitMorae('たべる')).toEqual(['た', 'べ', 'る'])
  })
  it('空字串回空陣列', () => {
    expect(splitMorae('')).toEqual([])
  })
})

describe('pitchPattern', () => {
  it('平板 [0]:第一拍低、其餘高、無降調', () => {
    expect(pitchPattern(3, 0)).toEqual({ high: [false, true, true], dropAfter: null })
  })
  it('頭高 [1]:第一拍高、其後降', () => {
    expect(pitchPattern(3, 1)).toEqual({ high: [true, false, false], dropAfter: 1 })
  })
  it('中高 [2](たべる):第2拍高、第2拍後降', () => {
    expect(pitchPattern(3, 2)).toEqual({ high: [false, true, false], dropAfter: 2 })
  })
  it('尾高 [3](3拍字):第2、3拍高、末拍後降(降在助詞)', () => {
    expect(pitchPattern(3, 3)).toEqual({ high: [false, true, true], dropAfter: 3 })
  })
  it('單拍字 [0] 與 [1]', () => {
    expect(pitchPattern(1, 0)).toEqual({ high: [false], dropAfter: null })
    expect(pitchPattern(1, 1)).toEqual({ high: [true], dropAfter: 1 })
  })
  it('非法輸入回 null:accent 超過拍數、負數、拍數為 0', () => {
    expect(pitchPattern(2, 3)).toBeNull()
    expect(pitchPattern(3, -1)).toBeNull()
    expect(pitchPattern(0, 0)).toBeNull()
  })
})
