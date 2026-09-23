import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DECK_TEMPLATES } from '../src/data/templates'

// 介面上的中文句子用全形標點(，：；？！（）)。這支測試掃程式碼裡的字串與 JSX 文字,
// 看到「中文字緊鄰半形 , : ; ? ! ( )」就失敗,免得之後又混進來。
// 註解不算(給開發者看的);範本單字表(src/data)是資料不是介面,也不掃 —— 但範本的名稱與說明會顯示在畫面上,另外檢查。
const DIRS = ['src/pages', 'src/components', 'src/lib', 'src/db']
const files = [
  'src/App.tsx',
  ...DIRS.flatMap((d) => readdirSync(d).filter((f) => /\.tsx?$/.test(f)).map((f) => join(d, f))),
]

const CJK = '\\u3400-\\u9fff\\u3040-\\u30ff'
const BAD = new RegExp(`[${CJK}][,;:?!(]|[,;?!)][${CJK}]|\\([${CJK}]`)
// JSX 文字裡,標籤後面緊接半形標點(例如「按右上的 <span>…</span>,」):結束標籤後面是行尾、下一個標籤
// 或中文才算;自閉合標籤只算後面緊接標籤或中文的 —— 程式碼裡 `icon: <Icon />,` 那種逗號不算。同一行也要有中文
const BAD_AFTER_TAG = new RegExp(`</\\w+>[,;:?!](?=\\s*$|<|[${CJK}])|/>[,;:?!](?=<|[${CJK}])`)
const HAS_CJK = new RegExp(`[${CJK}]`)
// 數量單位只用「字/張/次」:「3 筆」「{n} 筆」是資料庫用語,介面上不用
const BAD_UNIT = /(\d|\})\s*筆/

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')        // /* */ 與 JSX 的 {/* */}
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1') // 行尾註解(網址裡的 // 前面是冒號,不會被當成註解)
}

describe('介面文字的標點', () => {
  it('中文旁邊不用半形標點', () => {
    const offenders: string[] = []
    for (const f of files) {
      stripComments(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        if (BAD.test(line) || (HAS_CJK.test(line) && BAD_AFTER_TAG.test(line))) {
          offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('範本的名稱與說明(第一次打開就會看到)也用全形標點', () => {
    const offenders = DECK_TEMPLATES.flatMap((t) => [t.name, t.description])
      .filter((text) => BAD.test(text))
    expect(offenders).toEqual([])
  })

  it('中文引號裡的加號用全形「＋」', () => {
    const offenders: string[] = []
    for (const f of files) {
      stripComments(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        if (line.includes('「+」')) offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('數量單位用「個字/張/次」,不用「筆」', () => {
    const offenders: string[] = []
    for (const f of files) {
      stripComments(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        if (BAD_UNIT.test(line)) offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
