/** 讀得到剪貼簿的瀏覽器才放「貼上」鈕(輸入同步金鑰的兩個地方共用) */
export function canReadClipboard(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'
}

/** 剪貼簿裡的字(修剪過)。沒給權限、讀不到就回空字串:使用者照樣可以手動貼 */
export async function readClipboardText(): Promise<string> {
  try {
    return (await navigator.clipboard.readText()).trim()
  } catch {
    return ''
  }
}
