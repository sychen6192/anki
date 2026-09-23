import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { createDeck, createNotes } from '../db/repo'
import { requestSync } from '../lib/sync'
import {
  autoMapHeaders, dedupeRows, mapRows, noteKey, parseCsv,
  type CsvMapping, type ParsedRow,
} from '../lib/csv'
import { DECK_TEMPLATES, type DeckTemplate } from '../data/templates'
import { parseApkg, type ApkgParse } from '../lib/apkg'
import { autoMapFields, mapApkgNotes, type ApkgMapping } from '../lib/apkgMap'
import { fillMissingAccents } from '../lib/accent'
import {
  fetchShare, isStandaloneApp, parseShareCode, storageSeparateFromApp, type SharedDeck,
} from '../lib/share'
import { useBusy } from '../lib/useBusy'
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

/** 一次匯入的結果:摘要 + 匯進哪副牌組(給「開始複習/查看牌組」的連結用) */
interface ImportResult { summary: Summary; deckId: string }

type Mode = 'csv' | 'apkg' | 'templates' | 'share'

const MODE_LABELS: readonly (readonly [Mode, string])[] = [
  ['csv', 'CSV'], ['apkg', 'Anki 牌組'], ['templates', '範本'], ['share', '分享連結'],
]

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 匯入結果:CSV/apkg/範本顯示在表單下方,分享的顯示在分享卡片裡,共用同一個樣子 */
function SummaryView({ result }: { result: ImportResult }) {
  const { summary, deckId } = result
  return (
    <div className="summary" role="status" aria-live="polite">
      <p>✓ 匯入 {summary.imported} 筆,跳過重複 {summary.skipped.length} 筆
        {summary.otherSkipped > 0 && `,略過其他樣板 ${summary.otherSkipped} 筆`}</p>
      {summary.annotateSkipped
        ? <p className="hint">沒連上字典,重音先空著;之後在牌組頁按「自動標註重音」補。</p>
        : <p className="hint">自動標註重音 {summary.annotated} 筆,查無 {summary.missed} 筆</p>}
      {summary.skipped.length > 0 && (
        <>
          {/* 只列前 10 筆:整副重匯時全列出來會生出上千個節點 */}
          <ul>{summary.skipped.slice(0, 10).map((r, i) => (
            <li key={i}>{r.expression}{r.reading && `(${r.reading})`} — {r.meaning}</li>
          ))}</ul>
          {summary.skipped.length > 10 && (
            <p className="hint">…還有 {summary.skipped.length - 10} 筆重複未列出</p>
          )}
        </>
      )}
      <div className="form-actions">
        <Link to={`/review/${deckId}`} className="btn">開始複習</Link>
        <Link to={`/deck/${deckId}`} className="btn secondary">查看牌組</Link>
      </div>
    </div>
  )
}

interface ShareCardProps {
  shared: SharedDeck | null; loadError: string; importError: string
  result: ImportResult | null; busy: boolean
  withReverse: boolean; onWithReverse: (v: boolean) => void; onImport: () => void
}

/** 朋友分享的牌組:讀取中 → 內容與匯入鈕 → 匯入後在卡片裡直接顯示結果(按鈕收掉,不會重複匯入) */
function ShareCard({ shared, loadError, importError, result, busy, withReverse, onWithReverse, onImport }: ShareCardProps) {
  const resultRef = useRef<HTMLDivElement | null>(null)
  // 手機螢幕短,結果出現時捲進畫面
  useEffect(() => { if (result !== null) resultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [result])

  if (loadError !== '') return <div className="template-card share-card"><p className="err" role="alert">{loadError}</p></div>
  if (shared === null) return <div className="template-card share-card"><p className="hint">讀取分享內容…</p></div>
  return (
    <div className="template-card share-card">
      <div className="template-info">
        <b>{shared.name}</b>
        <p className="hint">朋友分享的牌組,{shared.rows.length} 筆</p>
        {result === null && (
          <label className="check-row"><input type="checkbox" checked={withReverse}
            onChange={(e) => onWithReverse(e.target.checked)} /> 同時建立反向卡</label>
        )}
      </div>
      {result === null && (
        <button className="btn" disabled={busy || shared.rows.length === 0} onClick={onImport}>
          {busy ? '匯入中…' : '匯入'}
        </button>
      )}
      {importError !== '' && <p className="err share-result" role="alert">匯入失敗:{importError}</p>}
      {result !== null && <div className="share-result" ref={resultRef}><SummaryView result={result} /></div>}
    </div>
  )
}

/**
 * iPhone 的瀏覽器、LINE 之類的內建瀏覽器,資料和主畫面的 App 分開存:在這裡匯入,App 裡看不到。
 * 提醒一次,並給一顆「複製連結」讓人帶去 App 的「分享連結」分頁貼上。
 */
function BrowserNotice() {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no')
  const input = useRef<HTMLInputElement | null>(null)
  const href = typeof location !== 'undefined' ? location.href : ''
  const copy = async () => {
    try {
      // 點擊當下直接寫剪貼簿,中間不能先 await 別的東西,iPhone 才允許
      await navigator.clipboard.writeText(href)
      setCopied('yes')
    } catch {
      input.current?.select()
      setCopied('failed')
    }
  }
  return (
    <div className="notice onboard" role="note">
      <p><b>你是在瀏覽器裡打開這個連結的。</b>在這裡匯入的牌組會存在這個瀏覽器,不會出現在主畫面上的字卡 App 裡。</p>
      <p className="hint">要匯入到 App:複製連結,打開主畫面上的字卡,到「匯入」頁選「分享連結」貼上。沒有把字卡加到主畫面的話,直接在下面匯入就好。</p>
      <input ref={input} className="share-link-input" readOnly value={href} aria-label="分享連結"
        onFocus={(e) => e.currentTarget.select()} />
      <div className="form-actions">
        <button className="btn secondary" onClick={() => void copy()}>{copied === 'yes' ? '已複製 ✓' : '複製連結'}</button>
        {copied === 'failed' && <span className="hint">沒辦法自動複製,連結已選取,請手動拷貝</span>}
      </div>
    </div>
  )
}

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
  // 空牌組列表/說明頁的「從範本開始」直達 ?mode=templates;?mode=share 直接開「分享連結」分頁
  const [mode, setMode] = useState<Mode>(() => {
    const m = searchParams.get('mode')
    return m === 'templates' || m === 'share' ? m : 'csv'
  })
  const [deckId, setDeckId] = useState('new')
  const [newDeckName, setNewDeckName] = useState('')
  const [withReverse, setWithReverse] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  // 最近一次匯入寫進哪副牌組 —— 摘要裡給「開始複習/查看牌組」的直達連結
  const [lastDeckId, setLastDeckId] = useState<string | null>(null)
  const [busy, runBusy] = useBusy()
  const [errMsg, setErrMsg] = useState('')

  const [text, setText] = useState('')
  const [mapping, setMapping] = useState<CsvMapping | null>(null)
  const [hasHeader, setHasHeader] = useState(false)

  const [apkg, setApkg] = useState<ApkgParse | null>(null)
  const [notetypeId, setNotetypeId] = useState('')
  const [apkgMapping, setApkgMapping] = useState<ApkgMapping | null>(null)
  const [parsing, setParsing] = useState(false)

  // 分享:從連結打開(/import?share=code)是專用頁;在 App 裡則是「分享連結」分頁貼上
  const linkParam = searchParams.get('share')
  const linkMode = linkParam !== null
  const linkCode = linkParam === null ? null : parseShareCode(linkParam)
  const [pasteText, setPasteText] = useState('')
  const [pastedCode, setPastedCode] = useState<string | null>(null)
  const [pasteErr, setPasteErr] = useState('')
  const activeShareCode = linkMode ? linkCode : pastedCode
  const [shared, setShared] = useState<SharedDeck | null>(null)
  const [shareLoadErr, setShareLoadErr] = useState('')
  const [shareImportErr, setShareImportErr] = useState('')
  const [shareResult, setShareResult] = useState<ImportResult | null>(null)
  useEffect(() => {
    setShared(null)
    setShareLoadErr('')
    setShareImportErr('')
    setShareResult(null)
    if (activeShareCode === null) {
      if (linkMode) setShareLoadErr('這個分享連結不完整,請朋友重新傳一次')
      return
    }
    let cancelled = false
    fetchShare(activeShareCode)
      .then((d) => { if (!cancelled) setShared(d) })
      .catch((e: unknown) => { if (!cancelled) setShareLoadErr(errText(e)) })
    return () => { cancelled = true }
  }, [activeShareCode, linkMode])
  // 提醒只在「從瀏覽器打開連結、而且這個瀏覽器的資料和 App 分開」時出現
  const showBrowserNotice = linkMode && typeof navigator !== 'undefined'
    && !isStandaloneApp() && storageSeparateFromApp(navigator.userAgent, navigator.maxTouchPoints ?? 0)

  const loadPasted = () => {
    const code = parseShareCode(pasteText)
    if (code === null) { setPasteErr('看不出分享碼,請貼上朋友傳來的完整連結'); return }
    setPasteErr('')
    setPastedCode(code)
  }

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

  /** CSV/apkg/範本的結果顯示在表單下方,目標牌組切到剛匯入的那副 */
  const showResult = (r: ImportResult) => {
    setSummary(r.summary)
    setLastDeckId(r.deckId)
    // 目標牌組切到剛匯入的那副:再按一次「匯入」會走去重,而不是又建一副同名新牌組
    setDeckId(r.deckId)
    setNewDeckName('')
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

  /** 去重 → 自動標重音(離線或失敗照常匯入) → 寫入 → 回傳摘要;CSV/apkg/範本/分享共用 */
  const importParsed = async (targetId: string, parsedRows: ParsedRow[], otherSkipped: number): Promise<ImportResult> => {
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

    await createNotes(targetId, toCreate.map((r) => ({ ...r, reversed: withReverse })))
    requestSync() // 匯入完成就推上雲端,不用等下次複習結束
    return {
      summary: { imported: toCreate.length, skipped, annotated, missed, annotateSkipped, otherSkipped },
      deckId: targetId,
    }
  }

  /** 包住 busy 與錯誤處理;所有匯入入口共用,失敗一律把摘要清掉再顯示訊息 */
  const runImport = (fn: () => Promise<void>) => void runBusy(async () => {
    try {
      await fn()
    } catch (e) {
      setSummary(null)
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  })

  const doImport = () => {
    if (parsed.length === 0) return
    runImport(async () => {
      let targetId = deckId
      if (targetId === 'new') targetId = (await createDeck(newDeckName.trim() || '新牌組')).id
      showResult(await importParsed(targetId, parsed, mode === 'apkg' ? otherNoteCount : 0))
    })
  }

  /** 匯入到「以名字找到或新建」的牌組;範本與分享共用 */
  const importNamed = async (name: string, parsedRows: ParsedRow[]): Promise<ImportResult> => {
    const existingDeck = await db.decks.filter((d) => !d.deleted && d.name === name).first()
    const targetId = existingDeck?.id ?? (await createDeck(name)).id
    return importParsed(targetId, parsedRows, 0)
  }

  // csv 本體是動態 import 進來的,整段(含下載)都在 busy 內,免得下載期間又被按一次
  const importTemplate = (t: DeckTemplate) => runImport(async () => {
    let csv: string
    try {
      csv = await t.loadCsv()
    } catch {
      throw new Error('範本資料載入失敗,請重新整理後再試')
    }
    const tRows = parseCsv(csv)
    const tMapping = autoMapHeaders(tRows[0])
    if (!tMapping) throw new Error('範本表頭無法解析')
    showResult(await importNamed(t.name, mapRows(tRows.slice(1), tMapping)))
  })

  /** 分享的牌組匯入到同名牌組(沒有就建),結果顯示在分享卡片裡;匯入一次後按鈕就收掉 */
  const importShared = () => {
    if (shared === null || shareResult !== null) return
    void runBusy(async () => {
      try {
        setShareImportErr('')
        setShareResult(await importNamed(shared.name, shared.rows))
      } catch (e) {
        setShareImportErr(errText(e))
      }
    })
  }

  if (!decks) return <Loading />

  const shareCard = (
    <ShareCard shared={shared} loadError={shareLoadErr} importError={shareImportErr} result={shareResult}
      busy={busy} withReverse={withReverse} onWithReverse={setWithReverse} onImport={importShared} />
  )

  // 從分享連結打開:只放分享卡片,不混進 CSV 表單;要用別的方式匯入再點下面的連結
  if (linkMode) {
    return (
      <div>
        <h1>匯入分享的牌組</h1>
        {showBrowserNotice && <BrowserNotice />}
        {shareCard}
        <p className="hint"><Link to="/import" className="link">改用 CSV、Anki 牌組或範本匯入</Link></p>
      </div>
    )
  }

  return (
    <div>
      <h1>匯入</h1>

      <div className="tabs">
        {MODE_LABELS.map(([m, label]) => (
          <button key={m} className={`tab${mode === m ? ' active' : ''}`} onClick={() => switchMode(m)}>{label}</button>
        ))}
      </div>

      <div className="import-form">
        {(mode === 'csv' || mode === 'apkg') && (
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

        {mode === 'share' && (
          <>
            <p className="hint">朋友傳來的分享連結貼在這裡,會匯入成同名的牌組;已經有的字會跳過。</p>
            <form className="paste-share" onSubmit={(e) => { e.preventDefault(); loadPasted() }}>
              <input value={pasteText} onChange={(e) => setPasteText(e.target.value)}
                placeholder="貼上分享連結" aria-label="分享連結" inputMode="url" autoCapitalize="off" autoCorrect="off" />
              <button className="btn" type="submit" disabled={pasteText.trim() === ''}>讀取</button>
            </form>
            {pasteErr !== '' && <p className="err" role="alert">{pasteErr}</p>}
            {pastedCode !== null && shareCard}
          </>
        )}

        {mode === 'templates' && (
          <>
            <p className="hint">選一份直接開始。重音自動標;重複匯入只補新字,不會重複。</p>
            <label className="check-row"><input type="checkbox" checked={withReverse}
              onChange={(e) => setWithReverse(e.target.checked)} /> 同時建立反向卡(意思→單字)</label>
            {DECK_TEMPLATES.map((t) => (
              <div className="template-card" key={t.id}>
                <div className="template-info">
                  <b>{t.name}</b>
                  <p className="hint">{t.description}</p>
                  <p className="hint" lang="ja">{t.preview}</p>
                </div>
                <button className="btn" disabled={busy} onClick={() => importTemplate(t)}>
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
                if (!f) return
                // 檔名當牌組名的預設值,免得沒填名稱默默生出一副「新牌組」
                if (deckId === 'new' && newDeckName.trim() === '') {
                  setNewDeckName(f.name.replace(/\.csv$/i, ''))
                }
                onTextLoaded(await f.text())
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
            <p className="hint">讀 Anki / AnkiWeb 的 .apkg。只拿文字;進度、圖片、音檔不帶,全部當新卡重排。</p>
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
            <p className="hint">重音留空的字,匯入時自動查字典。</p>
            <p className="hint">
              共 {parsed.length} 筆有效資料
              {mode === 'apkg' && otherNoteCount > 0 && `,另有 ${otherNoteCount} 筆屬於其他樣板不會匯入`}
            </p>
            <label className="check-row"><input type="checkbox" checked={withReverse}
              onChange={(e) => setWithReverse(e.target.checked)} /> 同時建立反向卡(意思→單字)</label>
            <button className="btn" disabled={busy || parsed.length === 0} onClick={doImport}>
              {busy ? '匯入中…' : `匯入 ${parsed.length} 筆`}
            </button>
          </>
        )}

        {summary && lastDeckId !== null && mode !== 'share' && <SummaryView result={{ summary, deckId: lastDeckId }} />}
        {errMsg && <p className="err" role="alert">匯入失敗:{errMsg}</p>}
      </div>
    </div>
  )
}
