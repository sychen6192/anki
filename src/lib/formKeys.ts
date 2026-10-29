import type { KeyboardEvent, RefObject } from 'react'

/**
 * 表單裡按 return 跳到下一欄,不是送出(單字 → 讀音 → 意思):打完一欄順手按 return,
 * 不會帶著打到一半的字就存檔關掉。日文輸入法選字時的 Enter 不算(isComposing;Safari 只給 keyCode 229)
 */
export const nextOnEnter = (next: RefObject<HTMLInputElement | null>) => (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return
  e.preventDefault()
  next.current?.focus()
}
