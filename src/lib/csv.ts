import Papa from 'papaparse'
import type { NoteRecord } from '../../shared/types'
import { isValidAccent, normalizeAccent } from './accent'

export interface CsvMapping { expression: number; reading: number | null; meaning: number; accent: number | null }
export interface ParsedRow { expression: string; reading: string; meaning: string; accent: string }

// CSV 與 apkg 匯入共用同一份表頭別名(apkgMap.ts 引用這裡),
// 才不會出現「.apkg 認得 単語/意味、CSV 卻不認得」這種不一致。
export const EXPRESSION_ALIASES = ['漢字', '單字', '单字', '単語', '語彙', '表面', '正面', 'expression', 'word', 'front', 'vocabulary', 'vocab', 'kanji', 'term']
export const READING_ALIASES = ['拼音', '読み', 'よみ', '讀音', '读音', '振り仮名', 'ふりがな', '假名', 'reading', 'kana', 'furigana', 'pronunciation', 'hiragana']
export const MEANING_ALIASES = ['中文翻譯', '中文翻译', '中文', '意味', '意思', '翻譯', '翻译', '訳', '背面', 'meaning', 'back', 'english', 'translation', 'definition', 'gloss']
export const ACCENT_ALIASES = ['重音', 'アクセント', 'accent', 'pitch', 'pitchaccent']

export function parseCsv(text: string): string[][] {
  // greedy:只有逗號或空白的列(Excel 常在表格下面留一堆「,,」)也不算一列,
  // 不然預覽會說「有 N 列缺少單字或意思」,讓人去找根本不存在的資料。
  // 頭尾只去掉整列空白與引號外多餘的空格,不整段 trim:Excel 的「Unicode 文字」是 tab 分隔,
  // 第一格(或最後一格)空著時,trim 會吃掉那一列的 tab,那列少一欄 —— 表頭少一欄是整份錯位,
  // 列數少的兩欄資料則會讓 Papa 猜不出是 tab 分隔。開頭的空白列還是要去掉(Papa 只看前 10 列猜分隔符號,
  // 全是空白列就猜成逗號);開頭引號前、結尾引號後的空格也會讓引號對不起來
  const trimmed = text
    .replace(/^(?:[^\S\r\n]*\r?\n)+/, '')
    .replace(/^ +(?=")/, '')
    .replace(/(?:\r?\n[^\S\r\n]*)+$/, '')
    .replace(/" +$/, '"')
  return Papa.parse<string[]>(trimmed, { skipEmptyLines: 'greedy' }).data
}

export function autoMapHeaders(headers: string[]): CsvMapping | null {
  const norm = headers.map((h) => h.trim().toLowerCase())
  const find = (aliases: string[]) => {
    const i = norm.findIndex((h) => aliases.some((a) => a.toLowerCase() === h))
    return i === -1 ? null : i
  }
  const expression = find(EXPRESSION_ALIASES)
  const meaning = find(MEANING_ALIASES)
  if (expression === null || meaning === null) return null
  return { expression, reading: find(READING_ALIASES), meaning, accent: find(ACCENT_ALIASES) }
}

export function mapRows(rows: string[][], mapping: CsvMapping): ParsedRow[] {
  return rows
    .map((r) => {
      // 「０、２」這類手打的全形寫法先統一成「0,2」;還是不合格式的就留空,匯入時自動查字典
      const accent = mapping.accent === null ? '' : normalizeAccent(r[mapping.accent] ?? '')
      return {
        expression: (r[mapping.expression] ?? '').trim(),
        reading: mapping.reading === null ? '' : (r[mapping.reading] ?? '').trim(),
        meaning: (r[mapping.meaning] ?? '').trim(),
        accent: isValidAccent(accent) ? accent : '',
      }
    })
    .filter((r) => r.expression !== '' && r.meaning !== '')
}

export const noteKey = (expression: string, reading: string): string => `${expression}\u0000${reading}`

/**
 * 找牌組裡「單字+讀音」相同的現有筆記(與匯入去重同一個判準,比對前先修剪空白)。
 * excludeId:編輯時排除自己。已刪除的不算。
 */
export function findDuplicateNote<T extends { id: string; expression: string; reading: string; deleted: 0 | 1 }>(
  notes: T[], expression: string, reading: string, excludeId?: string,
): T | undefined {
  const key = noteKey(expression.trim(), reading.trim())
  return notes.find((n) => !n.deleted && n.id !== excludeId && noteKey(n.expression.trim(), n.reading.trim()) === key)
}

export function dedupeRows(rows: ParsedRow[], existingKeys: Set<string>): { toImport: ParsedRow[]; skipped: ParsedRow[] } {
  const seen = new Set(existingKeys)
  const toImport: ParsedRow[] = []
  const skipped: ParsedRow[] = []
  for (const r of rows) {
    const k = noteKey(r.expression, r.reading)
    if (seen.has(k)) skipped.push(r)
    else { seen.add(k); toImport.push(r) }
  }
  return { toImport, skipped }
}

export function exportCsv(notes: NoteRecord[]): string {
  const csv = Papa.unparse({
    fields: ['單字', '讀音', '意思', '重音'],
    data: notes.filter((n) => !n.deleted).map((n) => [n.expression, n.reading, n.meaning, n.accent]),
  })
  // 開頭的 BOM 讓 Excel 認得這是 UTF-8,不然中日文會變成亂碼(自己的匯入讀得懂,會自動略過)
  return '\uFEFF' + csv.replace(/\r/g, '')
}

/** unknown:哪一種都解不開,只好照 UTF-8 硬解(內容多半有亂碼,畫面要提醒) */
export type TextEncodingName = 'utf-8' | 'big5' | 'shift_jis' | 'utf-16le' | 'utf-16be' | 'unknown'

/**
 * 讀使用者選的 CSV 檔。Excel 預設存的「CSV(逗號分隔)」不是 UTF-8:繁中 Windows 是 Big5,
 * 日文 Windows 是 Shift_JIS。先照 UTF-8 嚴格解,解不開再依序試 Big5、Shift_JIS,並回報用了哪一種。
 * 開頭有 UTF-16 的 BOM(Excel 的「Unicode 文字」、Numbers 匯出)就直接照它解。
 */
export function decodeCsvBytes(bytes: ArrayBuffer | Uint8Array): { text: string; encoding: TextEncodingName } {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b), encoding: 'utf-16le' }
  if (b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(b), encoding: 'utf-16be' }
  for (const encoding of ['utf-8', 'big5', 'shift_jis'] as const) {
    try {
      return { text: new TextDecoder(encoding, { fatal: true }).decode(b), encoding }
    } catch {
      // 這個編碼解不開,換下一個
    }
  }
  return { text: new TextDecoder('utf-8').decode(b), encoding: 'unknown' }
}

/** 選檔後的編碼說明(UTF-8 不必說) */
export function encodingNote(encoding: TextEncodingName): string {
  if (encoding === 'utf-8') return ''
  if (encoding === 'unknown') {
    return '看不出這個檔案用的是哪種編碼，下面的字可能是亂碼。在 Excel 用「另存新檔」選「CSV UTF-8」再匯入。'
  }
  const name = encoding === 'big5' ? 'Big5' : encoding === 'shift_jis' ? 'Shift_JIS' : 'UTF-16'
  return `這個檔案是 ${name} 編碼，已自動轉換。字看起來不對的話，在 Excel 用「另存新檔」選「CSV UTF-8」再匯入。`
}
