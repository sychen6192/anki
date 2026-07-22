import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { createDeck, createNotes } from '../db/repo'
import {
  autoMapHeaders, dedupeRows, mapRows, noteKey, parseCsv,
  type CsvMapping, type ParsedRow,
} from '../lib/csv'
import { DECK_TEMPLATES, type DeckTemplate } from '../data/templates'
import { parseApkg, type ApkgParse } from '../lib/apkg'
import { autoMapFields, mapApkgNotes, type ApkgMapping } from '../lib/apkgMap'
import { fillMissingAccents } from '../lib/accent'
import { Loading } from '../components/Loading'

type MappingField = keyof ApkgMapping
// CSV 與 apkg 都能對應重音欄(重音一向可匯入,只是之前 CSV 的 UI 沒把它露出來)
const FIELD_LABELS: readonly (readonly [MappingField, string])[] =
  [['expression', '單字'], ['reading', '讀音'], ['meaning', '意思'], ['accent', '重音']]
const OPTIONAL_FIELDS = new Set<MappingField>(['reading', 'accent'])
// 解壓 + wasm heap 的峰值約為原始 DB 的 2~3 倍,手機瀏覽器撐不住更大的檔案
const MAX_APKG_BYTES = 60 * 1024 * 1024

interface Summary {
  imported: number; skipped: ParsedRow[]; otherSkipped: number
  annotated: number; missed: number; annotateSkipped: boolean
}

type Mode = 'csv' | 'apkg' | 'templates'

/** 範本卡片上的前幾個字,讓人看一眼就知道內容(範本 csv 無引號逗號,直接切) */
const templatePreview = (t: DeckTemplate): string =>
  t.csv.split('\n').slice(1, 4).map((l) => l.split(',')[0]).join('、') + '…'

export default function ImportPage() {
  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray(), [])
  // 同名牌組在下拉選單裡分不出誰是誰,附上筆數當線索
  const noteCounts = useLiveQuery(async () => {
    const counts = new Map<string, number>()
    await db.notes.filter((n) => !n.deleted).each((n) => {
      counts.set(n.deck_id, (counts.get(n.deck_id) ?? 0) + 1)
    })
    return counts
  }, [])
  const [searchParams] = useSearchParams()
  // 空牌組列表/說明頁的「從範本開始」直達 ?mode=templates
  const [mode, setMode] = useState<Mode>(
    searchParams.get('mode') === 'templates' ? 'templates' : 'csv',
  )
  const [deckId, setDeckId] = useState('new')
  const [newDeckName, setNewDeckName] = useState('')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [busy, setBusy] = useState(false)
  const [errMsg, setErrMsg] = useState('')

  const [text, setText] = useState('')
  const [mapping, setMapping] = useState<CsvMapping | null>(null)
  const [hasHeader, setHasHeader] = useState(false)

  const [apkg, setApkg] = useState<ApkgParse | null>(null)
  const [notetypeId, setNotetypeId] = useState('')
  const [apkgMapping, setApkgMapping] = useState<ApkgMapping | null>(null)
  const [parsing, setParsing] = useState(false)

  const rows = useMemo(() => (text.trim() ? parseCsv(text) : []), [text])
  const dataRows = hasHeader ? rows.slice(1) : rows
  const csvParsed = mapping ? mapRows(dataRows, mapping) : []

  const notetype = apkg?.notetypes.find((t) => t.id === notetypeId) ?? null
  const apkgParsed = useMemo(
    () => (apkg && apkgMapping ? mapApkgNotes(apkg.notes.filter((n) => n.notetypeId === notetypeId), apkgMapping) : []),
    [apkg, notetypeId, apkgMapping],
  )
  const otherNoteCount = apkg ? apkg.notes.length - (notetype?.noteCount ?? 0) : 0

  const parsed = mode === 'csv' ? csvParsed : apkgParsed
  const activeMapping: CsvMapping | ApkgMapping | null = mode === 'csv' ? mapping : apkgMapping
  const fieldOptions = mode === 'csv' ? (rows[0] ?? []) : mode === 'apkg' ? (notetype?.fieldNames ?? []) : []
  const labels = FIELD_LABELS

  const switchMode = (next: Mode) => {
    setMode(next)
    setSummary(null)
    setErrMsg('')
  }

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

  const onApkgFile = async (file: File) => {
    setSummary(null)
    setErrMsg('')
    setApkg(null)
    if (file.size > MAX_APKG_BYTES) {
      setErrMsg(`檔案太大(${(file.size / 1024 / 1024).toFixed(0)} MB),目前上限 60 MB`)
      return
    }
    setParsing(true)
    try {
      const result = await parseApkg(new Uint8Array(await file.arrayBuffer()))
      if (result.notetypes.length === 0) throw new Error('這個牌組裡沒有可匯入的 note')
      setApkg(result)
      selectNotetype(result, result.notetypes[0].id)
      if (deckId === 'new' && newDeckName.trim() === '' && result.deckName) setNewDeckName(result.deckName)
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setParsing(false)
    }
  }

  const selectNotetype = (source: ApkgParse, id: string) => {
    setNotetypeId(id)
    const t = source.notetypes.find((n) => n.id === id)
    setApkgMapping(autoMapFields(t?.fieldNames ?? []))
  }

  const setMappingField = (field: MappingField, value: number | null) => {
    if (mode === 'csv') setMapping((m) => (m ? { ...m, [field]: value } : m))
    else setApkgMapping((m) => (m ? { ...m, [field]: value } : m))
  }

  /** 去重 → 自動標重音(離線或失敗照常匯入) → 寫入 → 出摘要;CSV/apkg/範本共用 */
  const importParsed = async (targetId: string, parsedRows: ParsedRow[], otherSkipped: number) => {
    const existing = await db.notes.where('deck_id').equals(targetId).filter((n) => !n.deleted).toArray()
    const keys = new Set(existing.map((n) => noteKey(n.expression, n.reading)))
    const { toImport, skipped } = dedupeRows(parsedRows, keys)

    let toCreate = toImport
    let annotated = 0, missed = 0, annotateSkipped = false
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      annotateSkipped = true
    } else {
      try {
        const res = await fillMissingAccents(toImport)
        toCreate = res.rows; annotated = res.filled; missed = res.missed
      } catch {
        annotateSkipped = true
      }
    }

    await createNotes(targetId, toCreate.map((r) => ({ ...r, reversed: false })))
    setSummary({ imported: toCreate.length, skipped, annotated, missed, annotateSkipped, otherSkipped })
    setErrMsg('')
  }

  const doImport = async () => {
    if (parsed.length === 0 || busy) return
    setBusy(true)
    try {
      let targetId = deckId
      if (targetId === 'new') targetId = (await createDeck(newDeckName.trim() || '新牌組')).id
      await importParsed(targetId, parsed, mode === 'apkg' ? otherNoteCount : 0)
    } catch (e) {
      setSummary(null)
      setErrMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 一鍵匯入範本:同名牌組存在就併入(去重),否則建立同名牌組 */
  const importTemplate = async (t: DeckTemplate) => {
    if (busy) return
    setBusy(true)
    try {
      const tRows = parseCsv(t.csv)
      const tMapping = autoMapHeaders(tRows[0])
      if (!tMapping) throw new Error('範本表頭無法解析')
      const existingDeck = await db.decks.filter((d) => !d.deleted && d.name === t.name).first()
      const targetId = existingDeck?.id ?? (await createDeck(t.name)).id
      await importParsed(targetId, mapRows(tRows.slice(1), tMapping), 0)
    } catch (e) {
      setSummary(null)
      setErrMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!decks) return <Loading />

  return (
    <div>
      <h1>匯入</h1>
      <div className="tabs">
        <button className={`tab${mode === 'csv' ? ' active' : ''}`} onClick={() => switchMode('csv')}>CSV</button>
        <button className={`tab${mode === 'apkg' ? ' active' : ''}`} onClick={() => switchMode('apkg')}>Anki 牌組</button>
        <button className={`tab${mode === 'templates' ? ' active' : ''}`} onClick={() => switchMode('templates')}>範本</button>
      </div>

      <div className="import-form">
        {mode !== 'templates' && (
          <>
            <label>目標牌組
              <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
                <option value="new">＋ 建立新牌組</option>
                {decks.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}({noteCounts?.get(d.id) ?? 0} 筆)</option>
                ))}
              </select>
            </label>
            {deckId === 'new' && (
              <input placeholder="新牌組名稱" value={newDeckName} onChange={(e) => setNewDeckName(e.target.value)} />
            )}
          </>
        )}

        {mode === 'templates' && (
          <>
            <p className="hint">
              還沒有自己的單字表?選一份直接開始。匯入時會自動標註重音(需連線);
              重複匯入會自動跳過已有的字,之後隨時可在牌組頁增刪。
            </p>
            {DECK_TEMPLATES.map((t) => (
              <div className="template-card" key={t.id}>
                <div className="template-info">
                  <b>{t.name}</b>
                  <p className="hint">{t.description}</p>
                  <p className="hint" lang="ja">{templatePreview(t)}</p>
                </div>
                <button className="btn" disabled={busy} onClick={() => void importTemplate(t)}>
                  {busy ? '匯入中…' : `匯入 ${t.count} 筆`}
                </button>
              </div>
            ))}
          </>
        )}

        {mode === 'csv' && (
          <>
            <input type="file" accept=".csv,text/csv"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                e.target.value = '' // 清掉選檔紀錄,否則選同一個檔案第二次不會觸發
                if (f) onTextLoaded(await f.text())
              }} />
            <textarea rows={5} placeholder="或直接貼上 CSV 內容" value={text}
              onChange={(e) => onTextLoaded(e.target.value)} />
            {rows.length > 0 && mapping && (
              <label><input type="checkbox" checked={hasHeader}
                onChange={(e) => setHasHeader(e.target.checked)} /> 第一列是表頭</label>
            )}
          </>
        )}
        {mode === 'apkg' && (
          <>
            <input type="file" accept=".apkg,.colpkg"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void onApkgFile(f)
              }} />
            <p className="hint">
              從 Anki 或 AnkiWeb 下載的 .apkg 檔。只會匯入文字內容,卡片一律從新卡開始排程;
              排程進度、圖片與音檔不會匯入。
            </p>
            {parsing && <p className="hint">解析中…</p>}
            {apkg && apkg.notetypes.length > 1 && (
              <label>樣板
                <select value={notetypeId} onChange={(e) => selectNotetype(apkg, e.target.value)}>
                  {apkg.notetypes.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}({t.noteCount} 筆)</option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}

        {activeMapping && fieldOptions.length > 0 && (
          <>
            <div className="mapping">
              {labels.map(([field, label]) => (
                <label key={field}>{label}
                  <select
                    value={activeMapping[field] === null ? '' : String(activeMapping[field])}
                    onChange={(e) => setMappingField(field, e.target.value === '' ? null : Number(e.target.value))}>
                    {OPTIONAL_FIELDS.has(field) && <option value="">(無)</option>}
                    {fieldOptions.map((cell, i) => (
                      <option key={i} value={i}>
                        {mode === 'csv' ? `第 ${i + 1} 欄(${cell}…)` : cell || `欄位 ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <table className="preview">
              <thead><tr><th>單字</th><th>讀音</th><th>意思</th><th>重音</th></tr></thead>
              <tbody>
                {parsed.slice(0, 5).map((r, i) => (
                  <tr key={i}><td>{r.expression}</td><td>{r.reading}</td><td>{r.meaning}</td><td>{r.accent}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="hint">沒對應重音欄或欄位留空的字,匯入時會自動查字典。</p>
            <p className="hint">
              共 {parsed.length} 筆有效資料
              {mode === 'apkg' && otherNoteCount > 0 && `,另有 ${otherNoteCount} 筆屬於其他樣板不會匯入`}
            </p>
            <button className="btn" disabled={busy || parsed.length === 0} onClick={doImport}>
              {busy ? '匯入中…' : `匯入 ${parsed.length} 筆`}
            </button>
          </>
        )}

        {summary && (
          <div className="summary" role="status" aria-live="polite">
            <p>✓ 匯入 {summary.imported} 筆,跳過重複 {summary.skipped.length} 筆
              {summary.otherSkipped > 0 && `,略過其他樣板 ${summary.otherSkipped} 筆`}</p>
            {summary.annotateSkipped
              ? <p className="hint">離線或字典查詢失敗,未自動標註重音(可稍後在牌組頁按「自動標註重音」)</p>
              : <p className="hint">自動標註重音 {summary.annotated} 筆,查無 {summary.missed} 筆</p>}
            {summary.skipped.length > 0 && (
              <ul>{summary.skipped.map((r, i) => (
                <li key={i}>{r.expression}{r.reading && `(${r.reading})`} — {r.meaning}</li>
              ))}</ul>
            )}
          </div>
        )}
        {errMsg && <p className="err" role="alert">匯入失敗:{errMsg}</p>}
      </div>
    </div>
  )
}
