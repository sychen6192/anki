import { isTouchDevice } from './share'

/**
 * 把文字存成檔案。iPhone 主畫面 App 裡 <a download> 常常沒反應:觸控裝置上能用系統分享面板
 * 就用它(「儲存到檔案」、AirDrop、傳給別的 App);不行或被擋(點擊後等太久)才退回一般下載。
 */
export async function download(filename: string, text: string, type = 'text/csv'): Promise<void> {
  if (isTouchDevice() && typeof navigator.canShare === 'function' && typeof File === 'function') {
    const file = new File([text], filename, { type })
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename })
        return
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return // 自己關掉面板
        // NotAllowedError 等:退回一般下載
      }
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // 立刻 revoke 有些瀏覽器會來不及開始下載
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
