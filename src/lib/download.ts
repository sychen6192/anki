import { isTouchDevice } from './share'

/**
 * 把文字存成檔案。iPhone 主畫面 App 裡 <a download> 常常沒反應:觸控裝置上能用系統分享面板
 * 就用它(「儲存到檔案」、AirDrop、傳給別的 App);不行或被擋(點擊後等太久)才退回一般下載。
 * 回傳怎麼交出去的:分享面板 / 沒存(自己關掉面板、面板已經開著)/ 一般下載 /
 * 分享面板叫不出來、退回一般下載(主畫面 App 裡可能什麼都沒發生,不能當成存好了)。
 */
export async function download(
  filename: string, text: string, type = 'text/csv',
): Promise<'shared' | 'cancelled' | 'downloaded' | 'fallback'> {
  let fellBack = false
  if (isTouchDevice() && typeof navigator.canShare === 'function' && typeof File === 'function') {
    const file = new File([text], filename, { type })
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename })
        return 'shared'
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled' // 自己關掉面板
        // 連按兩下:前一個面板還開著,這一下不算(結果看前一個)
        if (e instanceof DOMException && e.name === 'InvalidStateError') return 'cancelled'
        fellBack = true // NotAllowedError 等:退回一般下載
      }
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  // 沒放進頁面的連結,有些瀏覽器(Firefox、部分 Chromium)點了不會下載
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 有些瀏覽器會來不及開始下載
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return fellBack ? 'fallback' : 'downloaded'
}
