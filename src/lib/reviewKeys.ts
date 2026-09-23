import type { RatingValue } from './fsrs'

export type ReviewKeyAction =
  | { type: 'show' } | { type: 'edit' } | { type: 'skip' } | { type: 'undo' } | { type: 'cancel-edit' }
  | { type: 'known' } | { type: 'exit' }
  | { type: 'rate'; rating: RatingValue }

/** 只取 KeyboardEvent 裡用得到的欄位,測試不必造整個事件 */
export interface KeyLike { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }

/**
 * 複習頁的快捷鍵表。回 null = 不是我們的鍵,交還給瀏覽器。
 * 帶 Cmd/Ctrl/Alt 的一律不接:那是瀏覽器或系統的快捷鍵 —— Cmd+S 存檔、Ctrl+U 看原始碼、
 * Cmd+1 切分頁,以前會被當成跳過、復原、評「重來」。
 */
export function reviewKeyAction(
  e: KeyLike, ctx: { editing: boolean; showBack: boolean },
): ReviewKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  // 編輯中鍵盤要留給輸入框,只保留 Esc 取消
  if (ctx.editing) return e.key === 'Escape' ? { type: 'cancel-edit' } : null
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
