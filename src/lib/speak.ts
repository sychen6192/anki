// 日文發音:用瀏覽器內建 Web Speech API(speechSynthesis)。
// 免後端、免費、可離線 —— 在 Apple 裝置上用的就是系統日語語音(Kyoko/加強版),
// 聽起來與 iOS 翻譯一致;其他平台用該裝置最好的日語語音。

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

// 挑一個日語語音;getVoices() 可能非同步載入(首次為空),此時回 null,
// 交給 utterance.lang = 'ja-JP' 讓瀏覽器自行配對日語語音。
function pickJaVoice(): SpeechSynthesisVoice | null {
  if (!isSpeechSupported()) return null
  const ja = window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('ja'))
  if (ja.length === 0) return null
  return ja.find((v) => /kyoko|siri|enhanced|premium|neural/i.test(v.name)) ?? ja[0]
}

/** 唸出日文文字。呼叫端請傳「読音優先,沒有才傳漢字」以求發音準確。 */
export function speak(text: string): void {
  if (!isSpeechSupported() || text.trim() === '') return
  const synth = window.speechSynthesis
  synth.cancel() // 中斷前一段,避免疊唸
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'ja-JP'
  const voice = pickJaVoice()
  if (voice) u.voice = voice
  u.rate = 0.95
  synth.speak(u)
}
