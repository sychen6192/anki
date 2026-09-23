import { describe, it, expect } from 'vitest'
import { reviewKeyAction, type KeyLike } from '../src/lib/reviewKeys'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods })
const front = { editing: false, showBack: false }
const back = { editing: false, showBack: true }

describe('reviewKeyAction', () => {
  it('正面:空白鍵翻面、E 編輯、S 跳過、U 復原;數字還不能評分', () => {
    expect(reviewKeyAction(key(' '), front)).toEqual({ type: 'show' })
    expect(reviewKeyAction(key('e'), front)).toEqual({ type: 'edit' })
    expect(reviewKeyAction(key('s'), front)).toEqual({ type: 'skip' })
    expect(reviewKeyAction(key('u'), front)).toEqual({ type: 'undo' })
    expect(reviewKeyAction(key('3'), front)).toBeNull()
  })

  it('K = 已經會了,正面背面都能按;帶修飾鍵或編輯中不接', () => {
    expect(reviewKeyAction(key('k'), front)).toEqual({ type: 'known' })
    expect(reviewKeyAction(key('k'), back)).toEqual({ type: 'known' })
    expect(reviewKeyAction(key('k', { metaKey: true }), front)).toBeNull()
    expect(reviewKeyAction(key('k'), { editing: true, showBack: false })).toBeNull()
  })

  it('空白鍵 / Enter:正面翻面,背面等於「普通」;Esc 離開複習', () => {
    expect(reviewKeyAction(key('Enter'), front)).toEqual({ type: 'show' })
    expect(reviewKeyAction(key(' '), back)).toEqual({ type: 'rate', rating: 3 })
    expect(reviewKeyAction(key('Enter'), back)).toEqual({ type: 'rate', rating: 3 })
    expect(reviewKeyAction(key('Escape'), front)).toEqual({ type: 'exit' })
    expect(reviewKeyAction(key('Escape'), back)).toEqual({ type: 'exit' })
  })

  it('翻面後 1~4 評分', () => {
    for (const k of ['1', '2', '3', '4'] as const) {
      expect(reviewKeyAction(key(k), back)).toEqual({ type: 'rate', rating: Number(k) })
    }
  })

  it('帶 Cmd/Ctrl/Alt 的是瀏覽器快捷鍵,不接 —— Cmd+S 不是跳過、Ctrl+U 不是復原、Cmd+1 不是評分', () => {
    expect(reviewKeyAction(key('s', { metaKey: true }), front)).toBeNull()
    expect(reviewKeyAction(key('u', { ctrlKey: true }), front)).toBeNull()
    expect(reviewKeyAction(key('1', { metaKey: true }), back)).toBeNull()
    expect(reviewKeyAction(key('e', { altKey: true }), front)).toBeNull()
    expect(reviewKeyAction(key(' ', { ctrlKey: true }), front)).toBeNull()
  })

  it('編輯中只認 Esc,其他鍵留給輸入框', () => {
    const editing = { editing: true, showBack: true }
    expect(reviewKeyAction(key('Escape'), editing)).toEqual({ type: 'cancel-edit' })
    expect(reviewKeyAction(key('s'), editing)).toBeNull()
    expect(reviewKeyAction(key('3'), editing)).toBeNull()
    expect(reviewKeyAction(key(' '), editing)).toBeNull()
  })

  it('其他鍵交還瀏覽器(Shift+S 產生的是大寫 S,不算)', () => {
    expect(reviewKeyAction(key('Tab'), front)).toBeNull()
    expect(reviewKeyAction(key('S'), front)).toBeNull()
  })
})
