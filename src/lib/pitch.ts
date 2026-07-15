// 拗音用的小假名(平/片假名):併入前一拍。促音 っ/ッ、撥音 ん/ン、長音 ー 不在此集合,各自成拍。
const SMALL_KANA = new Set('ゃゅょぁぃぅぇぉゎ' + 'ャュョァィゥェォヮ')

/** 把読み依「拍(mora)」切分。 */
export function splitMorae(reading: string): string[] {
  const morae: string[] = []
  for (const ch of reading) {
    if (SMALL_KANA.has(ch) && morae.length > 0) morae[morae.length - 1] += ch
    else morae.push(ch)
  }
  return morae
}

export interface Pattern { high: boolean[]; dropAfter: number | null }

/**
 * 由拍數與重音數字算高低 pattern。
 * accent(N)語意:0=平板、1=頭高、2..M=中高/尾高(第 N 拍後降)。
 * dropAfter = 降調發生在「第幾拍之後」(1-based);平板為 null。
 * 非法(N<0、N>拍數、拍數為 0、非整數)回 null,由呼叫端只顯示數字不畫線。
 */
export function pitchPattern(moraCount: number, accent: number): Pattern | null {
  if (!Number.isInteger(accent) || accent < 0 || moraCount === 0 || accent > moraCount) return null
  const high = new Array<boolean>(moraCount).fill(false)
  if (accent === 0) {
    for (let i = 1; i < moraCount; i++) high[i] = true
    return { high, dropAfter: null }
  }
  // accent >= 1:第 2..N 拍高(頭高時此迴圈不執行),第 1 拍高僅在頭高成立。
  for (let i = 1; i < accent; i++) high[i] = true
  if (accent === 1) high[0] = true
  return { high, dropAfter: accent }
}
