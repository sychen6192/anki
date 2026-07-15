// 用法:
//   1) curl -sL -o scripts/accents.txt \
//        https://raw.githubusercontent.com/mifunetoshiro/kanjium/master/data/source_files/raw/accents.txt
//   2) node scripts/build-accent-dict.mjs
//   產出 scripts/accent-dict.sql(gitignore)。資料來源:kanjium(mifunetoshiro/kanjium),CC 授權,僅個人使用。
import fs from 'node:fs'

const SRC = 'scripts/accents.txt'
const OUT = 'scripts/accent-dict.sql'
const ROWS_PER_INSERT = 500 // 每個 INSERT 的 VALUES 列數,避免單一 statement 過大

const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
const validPitch = (s) => /^\d+(,\d+)*$/.test(s)
const esc = (s) => s.replace(/'/g, "''")

const seen = new Set()
const rows = []
for (const line of fs.readFileSync(SRC, 'utf8').split('\n')) {
  const [expression, reading, pitch] = line.split('\t')
  if (!expression || !pitch) continue
  const hira = kataToHira((reading || expression).trim())
  const p = pitch.trim()
  if (!validPitch(p)) continue
  const key = expression + ' ' + hira
  if (seen.has(key)) continue // 同 (expression, reading) 取第一筆
  seen.add(key)
  rows.push([expression, hira, p])
}

const parts = ['DELETE FROM accent_dict;']
for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
  const values = rows.slice(i, i + ROWS_PER_INSERT)
    .map(([e, r, p]) => `('${esc(e)}','${esc(r)}','${esc(p)}')`).join(',')
  parts.push(`INSERT INTO accent_dict (expression, reading, pitch) VALUES ${values};`)
}
fs.writeFileSync(OUT, parts.join('\n') + '\n')
console.log(`wrote ${rows.length} rows to ${OUT}`)
