import type { ApkgNote } from './apkg'
import { ACCENT_ALIASES, EXPRESSION_ALIASES, MEANING_ALIASES, READING_ALIASES, type ParsedRow } from './csv'
import { splitFurigana, stripAnkiHtml } from './ankiText'
import { isValidAccent } from './accent'

export interface ApkgMapping { expression: number; reading: number | null; meaning: number; accent: number | null }

const normalize = (s: string) => s.trim().toLowerCase().replace(/[\s_-]/g, '')

function findField(fieldNames: string[], aliases: string[]): number | null {
  const norm = fieldNames.map(normalize)
  const exact = norm.findIndex((n) => aliases.includes(n))
  if (exact !== -1) return exact
  // 共享牌組常見 "Vocabulary-Furigana"、"Meaning (Chinese)" 這類複合名稱
  const partial = norm.findIndex((n) => n !== '' && aliases.some((a) => n.includes(a)))
  return partial === -1 ? null : partial
}

/** 依欄位名猜對應;猜不到單字/意思時退回位置對應(第 1 欄 / 第 2 或第 3 欄)。 */
export function autoMapFields(fieldNames: string[]): ApkgMapping {
  const expression = findField(fieldNames, EXPRESSION_ALIASES)
  const reading = findField(fieldNames, READING_ALIASES)
  const meaning = findField(fieldNames, MEANING_ALIASES)
  const accent = findField(fieldNames, ACCENT_ALIASES)
  const wide = fieldNames.length > 2
  return {
    expression: expression ?? 0,
    reading: reading ?? (expression === null && wide ? 1 : null),
    meaning: meaning ?? (wide ? 2 : 1),
    accent,
  }
}

/**
 * 把 apkg 的 note 欄位映射成匯入用的列。欄位內容一律先清成純文字;
 * 若沒有讀音欄但單字欄帶 furigana(`漢字[かんじ]`),就從中拆出讀音。
 */
export function mapApkgNotes(notes: ApkgNote[], mapping: ApkgMapping): ParsedRow[] {
  const at = (note: ApkgNote, index: number | null) =>
    index === null ? '' : stripAnkiHtml(note.fields[index] ?? '')

  return notes
    .map((note) => {
      let expression = at(note, mapping.expression)
      let reading = at(note, mapping.reading)
      if (reading === '') {
        const furigana = splitFurigana(expression)
        if (furigana.reading !== '') {
          expression = furigana.base
          reading = furigana.reading
        }
      }
      const rawAccent = at(note, mapping.accent)
      return {
        expression,
        reading,
        meaning: at(note, mapping.meaning),
        accent: isValidAccent(rawAccent) ? rawAccent : '',
      }
    })
    .filter((r) => r.expression !== '' && r.meaning !== '')
}
