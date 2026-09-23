import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// 介面上的中文句子用全形標點(，：；？！（）)。這支測試掃程式碼裡的字串與 JSX 文字,
// 看到「中文字緊鄰半形 , : ; ? ! ( )」就失敗,免得之後又混進來。
// 註解不算(給開發者看的);範本單字表(src/data)是資料不是介面,也不掃。
const DIRS = ['src/pages', 'src/components', 'src/lib', 'src/db']
const files = [
  'src/App.tsx',
  ...DIRS.flatMap((d) => readdirSync(d).filter((f) => /\.tsx?$/.test(f)).map((f) => join(d, f))),
]

const CJK = '\\u3400-\\u9fff\\u3040-\\u30ff'
const BAD = new RegExp(`[${CJK}][,;:?!(]|[,;?!)][${CJK}]|\\([${CJK}]`)

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
        if (BAD.test(line)) offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
