import type { RatingValue } from './fsrs'

export type ReviewKeyAction =
  | { type: 'show' } | { type: 'edit' } | { type: 'skip' } | { type: 'undo' }
  | { type: 'known' } | { type: 'exit' }
  | { type: 'rate'; rating: RatingValue }

/** 只取 KeyboardEvent 裡用得到的欄位,測試不必造整個事件 */
export interface KeyLike { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }

/**
 * 按鍵發生在哪:'text' = 輸入框(字母要留給它);'control' = 用鍵盤(Tab)移過去的按鈕或連結,
 * Enter/空白鍵要交給它自己 —— 不然 Tab 到「重來」按 Enter 會被記成「普通」。
 * 用滑鼠點過而留著焦點的按鈕不算(呼叫端用 :focus-visible 分辨),快捷鍵照常。
 */
export type KeyTarget = 'text' | 'control' | null

export interface ReviewKeyContext {
  editing: boolean
  showBack: boolean
  /** 完成畫面:只剩 Esc 離開,其餘鍵給畫面上的按鈕 */
  done?: boolean
  target?: KeyTarget
}

/**
 * 複習頁的快捷鍵表。回 null = 不是我們的鍵,交還給瀏覽器。
 * 帶 Cmd/Ctrl/Alt 的一律不接:那是瀏覽器或系統的快捷鍵 —— Cmd+S 存檔、Ctrl+U 看原始碼、
 * Cmd+1 切分頁,以前會被當成跳過、復原、評「重來」。
 */
export function reviewKeyAction(e: KeyLike, ctx: ReviewKeyContext): ReviewKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  // 編輯中鍵盤全部留給編輯面板:Esc 也由面板自己處理(有改過會先問要不要捨棄)
  if (ctx.editing) return null
  if (ctx.target === 'text') return null
  if (ctx.done) return e.key === 'Escape' ? { type: 'exit' } : null
  if ((e.key === ' ' || e.key === 'Enter') && ctx.target === 'control') return null
  switch (e.key) {
    // 空白鍵 / Enter:正面翻面;背面等於「普通」(跟 Anki 一樣,一路按空白鍵就能複習)
    case ' ': case 'Enter': return ctx.showBack ? { type: 'rate', rating: 3 } : { type: 'show' }
    case 'Escape': return { type: 'exit' }
    case 'e': return { type: 'edit' }
    case 's': return { type: 'skip' }
    case 'u': return { type: 'undo' }
    case 'k': return { type: 'known' } // 已經會了:正面就能按,不必翻面
    case '1': case '2': case '3': case '4':
      return ctx.showBack ? { type: 'rate', rating: Number(e.key) as RatingValue } : null
    default: return null
  }
}
