import Papa from 'papaparse'
import type { NoteRecord } from '../../shared/types'
import { isValidAccent } from './accent'

export interface CsvMapping { expression: number; reading: number | null; meaning: number; accent: number | null }
export interface ParsedRow { expression: string; reading: string; meaning: string; accent: string }

// CSV 與 apkg 匯入共用同一份表頭別名(apkgMap.ts 引用這裡),
// 才不會出現「.apkg 認得 単語/意味、CSV 卻不認得」這種不一致。
export const EXPRESSION_ALIASES = ['漢字', '單字', '单字', '単語', '語彙', '表面', '正面', 'expression', 'word', 'front', 'vocabulary', 'vocab', 'kanji', 'term']
export const READING_ALIASES = ['拼音', '読み', 'よみ', '讀音', '读音', '振り仮名', 'ふりがな', '假名', 'reading', 'kana', 'furigana', 'pronunciation', 'hiragana']
export const MEANING_ALIASES = ['中文翻譯', '中文翻译', '中文', '意味', '意思', '翻譯', '翻译', '訳', '背面', 'meaning', 'back', 'english', 'translation', 'definition', 'gloss']
export const ACCENT_ALIASES = ['重音', 'アクセント', 'accent', 'pitch', 'pitchaccent']

export function parseCsv(text: string): string[][] {
  return Papa.parse<string[]>(text.trim(), { skipEmptyLines: true }).data
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
      const rawAccent = mapping.accent === null ? '' : (r[mapping.accent] ?? '').trim()
      return {
        expression: (r[mapping.expression] ?? '').trim(),
        reading: mapping.reading === null ? '' : (r[mapping.reading] ?? '').trim(),
        meaning: (r[mapping.meaning] ?? '').trim(),
        accent: isValidAccent(rawAccent) ? rawAccent : '',
      }
    })
    .filter((r) => r.expression !== '' && r.meaning !== '')
}

export const noteKey = (expression: string, reading: string): string => `${expression}\u0000${reading}`

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
  return csv.replace(/\r/g, '')
}
