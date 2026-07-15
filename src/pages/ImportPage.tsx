import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { createDeck, createNotes } from '../db/repo'
import {
  autoMapHeaders, dedupeRows, mapRows, noteKey, parseCsv,
  type CsvMapping, type ParsedRow,
} from '../lib/csv'

const FIELD_LABELS = [['expression', '單字'], ['reading', '讀音'], ['meaning', '意思']] as const

export default function ImportPage() {
  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray(), [])
  const [deckId, setDeckId] = useState('new')
  const [newDeckName, setNewDeckName] = useState('')
  const [text, setText] = useState('')
  const [mapping, setMapping] = useState<CsvMapping | null>(null)
  const [hasHeader, setHasHeader] = useState(false)
  const [summary, setSummary] = useState<{ imported: number; skipped: ParsedRow[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [errMsg, setErrMsg] = useState('')

  const rows = useMemo(() => (text.trim() ? parseCsv(text) : []), [text])
  const dataRows = hasHeader ? rows.slice(1) : rows
  const parsed = mapping ? mapRows(dataRows, mapping) : []

  const onTextLoaded = (t: string) => {
    setText(t)
    setSummary(null)
    const first = parseCsv(t)[0]
    if (!first) { setMapping(null); return }
    const auto = autoMapHeaders(first)
    setMapping(auto ?? {
      expression: 0,
      reading: first.length > 2 ? 1 : null,
      meaning: first.length > 2 ? 2 : 1,
      accent: null,
    })
    setHasHeader(auto !== null)
  }

  const doImport = async () => {
    if (!mapping || parsed.length === 0 || busy) return
    setBusy(true)
    try {
      let targetId = deckId
      if (targetId === 'new') targetId = (await createDeck(newDeckName.trim() || '新牌組')).id
      const existing = await db.notes.where('deck_id').equals(targetId).filter((n) => !n.deleted).toArray()
      const keys = new Set(existing.map((n) => noteKey(n.expression, n.reading)))
      const { toImport, skipped } = dedupeRows(parsed, keys)
      await createNotes(targetId, toImport.map((r) => ({ ...r, reversed: false, accent: '' })))
      setSummary({ imported: toImport.length, skipped })
      setErrMsg('')
    } catch (e) {
      setSummary(null)
      setErrMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!decks) return null

  return (
    <div>
      <h1>匯入 CSV</h1>
      <div className="import-form">
        <label>目標牌組
          <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
            <option value="new">＋ 建立新牌組</option>
            {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        {deckId === 'new' && (
          <input placeholder="新牌組名稱" value={newDeckName} onChange={(e) => setNewDeckName(e.target.value)} />
        )}
        <input type="file" accept=".csv,text/csv"
          onChange={async (e) => { const f = e.target.files?.[0]; if (f) onTextLoaded(await f.text()) }} />
        <textarea rows={5} placeholder="或直接貼上 CSV 內容" value={text}
          onChange={(e) => onTextLoaded(e.target.value)} />

        {rows.length > 0 && mapping && (
          <>
            <label><input type="checkbox" checked={hasHeader}
              onChange={(e) => setHasHeader(e.target.checked)} /> 第一列是表頭</label>
            <div className="mapping">
              {FIELD_LABELS.map(([field, label]) => (
                <label key={field}>{label}
                  <select
                    value={mapping[field] === null ? '' : String(mapping[field])}
                    onChange={(e) => setMapping({
                      ...mapping,
                      [field]: e.target.value === '' ? null : Number(e.target.value),
                    })}>
                    {field === 'reading' && <option value="">(無)</option>}
                    {rows[0].map((cell, i) => (
                      <option key={i} value={i}>第 {i + 1} 欄({cell}…)</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <table className="preview">
              <thead><tr><th>單字</th><th>讀音</th><th>意思</th></tr></thead>
              <tbody>
                {parsed.slice(0, 5).map((r, i) => (
                  <tr key={i}><td>{r.expression}</td><td>{r.reading}</td><td>{r.meaning}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="hint">共 {parsed.length} 筆有效資料</p>
            <button className="btn" disabled={busy} onClick={doImport}>
              {busy ? '匯入中…' : `匯入 ${parsed.length} 筆`}
            </button>
          </>
        )}

        {summary && (
          <div className="summary">
            <p>✓ 匯入 {summary.imported} 筆,跳過重複 {summary.skipped.length} 筆</p>
            {summary.skipped.length > 0 && (
              <ul>{summary.skipped.map((r, i) => (
                <li key={i}>{r.expression}{r.reading && `(${r.reading})`} — {r.meaning}</li>
              ))}</ul>
            )}
          </div>
        )}
        {errMsg && <p className="err">匯入失敗:{errMsg}</p>}
      </div>
    </div>
  )
}
