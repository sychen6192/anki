import type { KeyboardEvent, RefObject } from 'react'

/**
 * 這一下是不是日文輸入法在選字(Enter 確定、Esc 取消選字),不是給網頁的鍵。
 * Safari 用 Enter 確定選字時 keydown 的 isComposing 已經是 false,只剩 keyCode 229 看得出來
 */
export const isImeKey = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229

/**
 * 表單裡按 return 跳到下一欄,不是送出(單字 → 讀音 → 意思):打完一欄順手按 return,
 * 不會帶著打到一半的字就存檔關掉。選字時的 Enter 不算(isImeKey)
 */
export const nextOnEnter = (next: RefObject<HTMLInputElement | null>) => (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key !== 'Enter' || isImeKey(e)) return
  e.preventDefault()
  next.current?.focus()
}
