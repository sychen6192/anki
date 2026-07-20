// Anki 欄位內容是 HTML,還可能夾帶 [sound:] 標籤、cloze 標記與 furigana 語法。
// 這裡的規則對照 anki 本身的 rslib/src/text.rs、template_filters.rs、cloze.rs。

const CLOZE = /\{\{c[\d,]+::(.*?)(?:::.*?)?\}\}/gs
const SOUND_TAG = /\[sound:[^\]]+\]/g
// 區塊標籤先換成空白,否則表格/列表的相鄰內容會黏在一起
const BLOCK_TAGS = /<\/?(?:br|p|div|li|ul|ol|tr|td|th|table|tbody|thead|h[1-6]|blockquote|section|article|hr)\b[^>]*>/gis
const HTML = /<!--.*?-->|<style\b[^>]*>.*?<\/style>|<script\b[^>]*>.*?<\/script>|<[^>]*>/gis
// 選擇性的前導空白 + 基底文字 + [讀音];前導空白是 Anki 的分隔記號,要一併吃掉
const FURIGANA = / ?([^ >]+?)\[(.+?)\]/g

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * 把 Anki 的欄位 HTML 清成純文字:去標籤/註解、解 entity、拿掉 [sound:] 與 cloze 標記。
 * 最後的空白壓縮同時把 NBSP(\s 涵蓋)正規化成一般空白。
 */
export function stripAnkiHtml(field: string): string {
  return decodeEntities(
    field
      .replace(CLOZE, '$1')
      .replace(SOUND_TAG, ' ')
      .replace(BLOCK_TAGS, ' ')
      .replace(HTML, ''),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 拆解 Anki 的 furigana 語法(`私[わたし]は 学生[がくせい]`)。
 * 沒有任何 furigana 時 reading 回空字串。`word[sound:x.mp3]` 不算 furigana。
 */
export function splitFurigana(text: string): { base: string; reading: string } {
  let base = ''
  let reading = ''
  let last = 0
  let matched = false
  FURIGANA.lastIndex = 0
  for (let m = FURIGANA.exec(text); m !== null; m = FURIGANA.exec(text)) {
    if (m[2].startsWith('sound:')) continue
    matched = true
    const between = text.slice(last, m.index)
    base += between + m[1]
    reading += between + m[2]
    last = m.index + m[0].length
  }
  if (!matched) return { base: text.trim(), reading: '' }
  const tail = text.slice(last)
  return { base: (base + tail).trim(), reading: (reading + tail).trim() }
}
