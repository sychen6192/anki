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
  fetchShare, isInAppBrowser, isStandaloneApp, isTouchDevice, parseShareCode, ShareNotFoundError, storageSeparateFromApp,
  type SharedDeck,
} from '../lib/share'
import { useBusy } from '../lib/useBusy'
import { Loading } from '../components/Loading'
import { PageHeader } from '../components/PageHeader'
import { ListSection, Segmented, Switch } from '../components/controls'
import { CheckIcon, FileIcon, LinkIcon, UploadIcon } from '../components/icons'
import './import.css'

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
  ['templates', '範本'], ['csv', 'CSV'], ['apkg', 'Anki'], ['share', '分享連結'],
]
const MODE_TITLES: Record<Mode, string> = {
  templates: '從範本加入', csv: '匯入 CSV', apkg: '匯入 Anki 牌組', share: '貼上分享連結',
}
// CSV 範例要用半形逗號(這是檔案格式,不是中文句子);用 join 組起來,標點轉換工具就不會碰它
const CSV_EXAMPLE = ['単語', 'たんご', '單字'].join(',')
const isMode = (m: string | null): m is Mode => m === 'csv' || m === 'apkg' || m === 'templates' || m === 'share'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 匯入結果:CSV/apkg/範本顯示在表單下方,分享的顯示在分享卡片裡,共用同一個樣子 */
function SummaryView({ result }: { result: ImportResult }) {
  const { summary, deckId } = result
  return (
    <div className="summary" role="status" aria-live="polite">
      <p className="summary-title"><CheckIcon size={18} />匯入 {summary.imported} 筆
        {summary.skipped.length > 0 && <span className="summary-sub">，跳過重複 {summary.skipped.length} 筆</span>}
        {summary.otherSkipped > 0 && <span className="summary-sub">，略過其他樣板 {summary.otherSkipped} 筆</span>}
      </p>
      {summary.annotateSkipped
        ? <p className="hint">沒連上字典，重音先空著；之後在牌組頁的「⋯」→「自動標註重音」補。</p>
        : <p className="hint">自動標註重音 {summary.annotated} 筆，查無 {summary.missed} 筆</p>}
      {summary.skipped.length > 0 && (
        <details className="summary-skipped">
          <summary>看跳過了哪些</summary>
          {/* 只列前 10 筆:整副重匯時全列出來會生出上千個節點 */}
          <ul>{summary.skipped.slice(0, 10).map((r, i) => (
            <li key={i}><span lang="ja">{r.expression}{r.reading && `(${r.reading})`}</span> — {r.meaning}</li>
          ))}</ul>
          {summary.skipped.length > 10 && (
            <p className="hint">…還有 {summary.skipped.length - 10} 筆重複未列出</p>
          )}
        </details>
      )}
      <div className="btn-row">
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
  /** 只有重試可能有用時才給(離線、伺服器一時出錯);連結壞掉或分享過期就不給 */
  onRetry?: () => void
}

/** 朋友分享的牌組:讀取中 → 內容與匯入鈕 → 匯入後在卡片裡直接顯示結果(按鈕收掉,不會重複匯入) */
function ShareCard({ shared, loadError, importError, result, busy, withReverse, onWithReverse, onImport, onRetry }: ShareCardProps) {
  const resultRef = useRef<HTMLDivElement | null>(null)
  // 手機螢幕短,結果出現時捲進畫面
  useEffect(() => { if (result !== null) resultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [result])

  if (loadError !== '') {
    return (
      <div className="card share-card">
        <p className="err" role="alert">{loadError}</p>
        {/* 主畫面的 App 沒有重新整理鈕:離線或伺服器一時出錯時,要能在這裡再試一次 */}
        {onRetry !== undefined && <button className="btn secondary" onClick={onRetry}>重試</button>}
      </div>
    )
  }
  if (shared === null) {
    return <div className="card share-card share-loading" role="status"><span className="spinner" aria-hidden="true" />讀取分享內容…</div>
  }
  return (
    <div className="card share-card">
      <div className="share-head">
        <span className="share-icon"><LinkIcon size={20} /></span>
        <div className="share-info">
          <b className="share-name">{shared.name}</b>
          <span className="hint">朋友分享的牌組 · {shared.rows.length} 筆</span>
        </div>
      </div>
      {shared.rows.length > 0 && (
        <p className="share-preview" lang="ja">
          {shared.rows.slice(0, 4).map((r) => r.expression).join('、')}{shared.rows.length > 4 ? '…' : ''}
        </p>
      )}
      {result === null && (
        <>
          <label className="switch-row">
            <span>同時建立反向卡</span>
            <Switch label="同時建立反向卡" checked={withReverse} onChange={onWithReverse} />
          </label>
          <button className="btn lg" disabled={busy || shared.rows.length === 0} onClick={onImport}>
            {busy ? '匯入中…' : `匯入 ${shared.rows.length} 筆`}
          </button>
        </>
      )}
      {importError !== '' && <p className="err" role="alert">匯入失敗：{importError}</p>}
      {result !== null && <div ref={resultRef}><SummaryView result={result} /></div>}
    </div>
  )
}

/**
 * iPhone/Mac 的 Safari、Mac/Linux 的 Firefox、LINE 之類的內建瀏覽器,資料和另外裝的字卡 App 分開存:
 * 在這裡匯入,App 裡看不到。提醒一次,並給一顆「複製連結」讓人帶去 App 的「分享連結」分頁貼上。
 * 內建瀏覽器另外說:在那裡匯入連平常用的瀏覽器都看不到,建議貼到平常用的地方;
 * 但判斷可能誤認(少數 Android 瀏覽器也用 WebView),所以仍保留「這就是平常用的瀏覽器就直接匯入」。
 */
function BrowserNotice({ inApp }: { inApp: boolean }) {
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
    <div className="card browser-notice" role="note">
      {inApp ? (
        <>
          <p><b>看起來你是在 LINE 之類 App 的內建瀏覽器裡打開這個連結的。</b>在這裡匯入的牌組只會存在這個內建瀏覽器，平常用的字卡裡看不到。</p>
          <p className="hint">請複製連結：用主畫面上的字卡 App 的話，到「牌組」右上的「+」→「貼上分享連結」；平常在別的瀏覽器用字卡的話，把連結貼到那個瀏覽器的網址列。App 裡找不到這個選項，先按 App 下方的「更新」，或把 App 完全關掉再打開。如果這就是你平常用字卡的瀏覽器，直接在下面匯入就好。</p>
        </>
      ) : (
        <>
          <p><b>你是在瀏覽器裡打開這個連結的。</b>加到主畫面（或 Mac 的 Dock）的字卡 App 和瀏覽器的資料是分開的，在這裡匯入的牌組不會出現在 App 裡。</p>
          <p className="hint">要匯入到 App：複製連結，打開字卡 App，到「牌組」右上的「+」→「貼上分享連結」；找不到這個選項的話，先按 App 下方的「更新」，或把 App 完全關掉再打開。平常就在這個瀏覽器用字卡的話，直接在下面匯入就好。</p>
        </>
      )}
      <input ref={input} className="share-link-input" readOnly value={href} aria-label="分享連結"
        onFocus={(e) => e.currentTarget.select()} />
      <div className="btn-row">
        <button className="btn tinted" onClick={() => void copy()}>{copied === 'yes' ? '已複製 ✓' : '複製連結'}</button>
      </div>
      {copied === 'failed' && <p className="hint">沒辦法自動複製，連結已選取，請手動拷貝</p>}
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
  const [searchParams, setSearchParams] = useSearchParams()
  // 「牌組」右上的「+」各項直達對應的方式(?mode=templates / csv / apkg / share);沒指定就從範本開始
  const [mode, setMode] = useState<Mode>(() => {
    const m = searchParams.get('mode')
    return isMode(m) ? m : 'templates'
  })
  // 牌組頁「匯入 CSV」帶 ?deck=<id>:目標牌組預設就是那一副
  const [deckId, setDeckId] = useState(() => searchParams.get('deck') ?? 'new')
  // 範本:目前在匯哪一份、結果屬於哪一份(結果顯示在那一份的卡片裡)
  const [importingTemplate, setImportingTemplate] = useState<string | null>(null)
  const [resultTemplate, setResultTemplate] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [newDeckName, setNewDeckName] = useState('')
  const [withReverse, setWithReverse] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  // 最近一次匯入寫進哪副牌組 —— 摘要裡給「開始複習/查看牌組」的直達連結
  const [lastDeckId, setLastDeckId] = useState<string | null>(null)
  const [busy, runBusy] = useBusy()
  const [errMsg, setErrMsg] = useState('')

  const [text, setText] = useState('')
  // 上一次自動對應時的第一列:之後只是改內容、第一列沒變,就保留使用者手動調過的對應
  const firstRowKey = useRef('')
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
  // 每按一次「讀取」或「重試」就加一:同一個碼也要重新讀(上次可能是離線失敗)
  const [loadNonce, setLoadNonce] = useState(0)
  // 目前卡片對應的是第幾次載入;匯入跑完時對不上,代表使用者已經換成別的分享,結果就丟掉
  const shareGen = useRef(0)
  const activeShareCode = linkMode ? linkCode : pastedCode
  const [shared, setShared] = useState<SharedDeck | null>(null)
  const [shareLoadErr, setShareLoadErr] = useState('')
  const [shareLoadRetryable, setShareLoadRetryable] = useState(false)
  const [shareImportErr, setShareImportErr] = useState('')
  const [shareResult, setShareResult] = useState<ImportResult | null>(null)
  useEffect(() => {
    shareGen.current += 1
    setShared(null)
    setShareLoadErr('')
    setShareImportErr('')
    setShareResult(null)
    setShareLoadRetryable(false)
    if (activeShareCode === null) {
      if (linkMode) setShareLoadErr('這個分享連結不完整，請朋友重新傳一次')
      return
    }
    let cancelled = false
    fetchShare(activeShareCode)
      .then((d) => { if (!cancelled) setShared(d) })
      .catch((e: unknown) => {
        if (cancelled) return
        setShareLoadErr(errText(e))
        setShareLoadRetryable(!(e instanceof ShareNotFoundError))
      })
    return () => { cancelled = true }
  }, [activeShareCode, linkMode, loadNonce])
  // 提醒只在「從瀏覽器打開連結、而且這個瀏覽器的資料和 App 分開」時出現
  const showBrowserNotice = linkMode && typeof navigator !== 'undefined'
    && !isStandaloneApp() && storageSeparateFromApp(navigator.userAgent, navigator.maxTouchPoints ?? 0, isTouchDevice())
  const inAppBrowser = typeof navigator !== 'undefined' && isInAppBrowser(navigator.userAgent, navigator.maxTouchPoints ?? 0)

  const loadPasted = () => {
    const code = parseShareCode(pasteText)
    if (code === null) { setPasteErr('看不出分享碼，請貼上朋友傳來的完整連結'); return }
    setPasteErr('')
    setPastedCode(code)
    setLoadNonce((n) => n + 1)
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
    setFileName('')
    // 寫回網址:重新整理或返回時停在同一個分頁
    setSearchParams({ mode: next }, { replace: true })
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
    if (!first) { setMapping(null); firstRowKey.current = ''; return }
    const key = JSON.stringify(first)
    if (key === firstRowKey.current) return
    firstRowKey.current = key
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
      setErrMsg(`檔案太大（${(file.size / 1024 / 1024).toFixed(0)} MB），目前上限 60 MB`)
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
    setImportingTemplate(t.id)
    setResultTemplate(null)
    try {
      let csv: string
      try {
        csv = await t.loadCsv()
      } catch {
        throw new Error('範本資料載入失敗，請重新整理後再試')
      }
      const tRows = parseCsv(csv)
      const tMapping = autoMapHeaders(tRows[0])
      if (!tMapping) throw new Error('範本表頭無法解析')
      showResult(await importNamed(t.name, mapRows(tRows.slice(1), tMapping)))
      setResultTemplate(t.id)
    } finally {
      setImportingTemplate(null)
    }
  })

  /** 分享的牌組匯入到同名牌組(沒有就建),結果顯示在分享卡片裡;匯入一次後按鈕就收掉 */
  const importShared = () => {
    if (shared === null || shareResult !== null) return
    const gen = shareGen.current
    void runBusy(async () => {
      try {
        setShareImportErr('')
        const r = await importNamed(shared.name, shared.rows)
        // 匯入要查字典,可能好幾秒;這段期間若換成別的分享,結果不能掛到新卡片上
        if (gen === shareGen.current) setShareResult(r)
      } catch (e) {
        if (gen === shareGen.current) setShareImportErr(errText(e))
      }
    })
  }

  // ?deck= 指到不存在的牌組(被刪了、打錯)就退回「建立新牌組」
  useEffect(() => {
    if (decks !== undefined && deckId !== 'new' && !decks.some((d) => d.id === deckId)) setDeckId('new')
  }, [decks, deckId])

  if (!decks) return <Loading />

  const shareCard = (
    <ShareCard shared={shared} loadError={shareLoadErr} importError={shareImportErr} result={shareResult}
      busy={busy} withReverse={withReverse} onWithReverse={setWithReverse} onImport={importShared}
      onRetry={shareLoadRetryable ? () => setLoadNonce((n) => n + 1) : undefined} />
  )

  // 從分享連結打開:只放分享卡片,不混進 CSV 表單;要用別的方式匯入再點下面的連結
  if (linkMode) {
    return (
      <>
        <PageHeader title="匯入分享的牌組" back={{ to: '/', label: '牌組' }} />
        <div className="import-body">
          {showBrowserNotice && <BrowserNotice inApp={inAppBrowser} />}
          {shareCard}
          <p className="import-alt"><Link to="/import" className="link">改用範本、CSV 或 Anki 牌組匯入</Link></p>
        </div>
      </>
    )
  }

  // 新牌組沒取名就不讓匯入:以前會默默生出一副叫「新牌組」的
  const needsName = deckId === 'new' && newDeckName.trim() === ''
  const targetName = deckId === 'new' ? newDeckName.trim() : decks.find((d) => d.id === deckId)?.name ?? ''

  const targetDeck = (
    <ListSection header="匯入到">
      <label className="row">
        <span className="row-main"><span className="row-title">牌組</span></span>
        <select className="row-select" value={deckId} onChange={(e) => setDeckId(e.target.value)} aria-label="目標牌組">
          <option value="new">＋ 建立新牌組</option>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>{d.name}（{noteCounts?.get(d.id) ?? 0} 筆）</option>
          ))}
        </select>
      </label>
      {deckId === 'new' && (
        <label className="row">
          <span className="row-main"><span className="row-title">名稱</span></span>
          <input className="row-input" placeholder="新牌組名稱" value={newDeckName} onChange={(e) => setNewDeckName(e.target.value)} />
        </label>
      )}
    </ListSection>
  )

  const reverseToggle = (
    <ListSection footer="反向卡：看中文意思，想出日文單字。">
      <label className="row">
        <span className="row-main"><span className="row-title">同時建立反向卡</span></span>
        <Switch label="同時建立反向卡" checked={withReverse} onChange={setWithReverse} />
      </label>
    </ListSection>
  )

  return (
    <>
      <PageHeader title={MODE_TITLES[mode]} shortTitle="匯入" back={{ to: '/', label: '牌組' }} />
      <div className="import-modes">
        <Segmented label="匯入方式" value={mode} options={MODE_LABELS} onChange={switchMode} />
      </div>

      <div className="import-body">
        {mode === 'templates' && (
          <>
            <p className="import-intro">選一份直接開始。重音會自動標好；同一份重複匯入只會補上新字。</p>
            {reverseToggle}
            <div className="template-list">
              {DECK_TEMPLATES.map((t) => {
                const added = decks.find((d) => d.name === t.name)
                return (
                  <div className="card template-card" key={t.id}>
                    <div className="template-head">
                      <b className="template-name">{t.name}</b>
                      <span className="template-count">{t.count} 字</span>
                    </div>
                    <p className="template-desc">{t.description}</p>
                    <p className="template-preview" lang="ja">{t.preview}</p>
                    {resultTemplate === t.id && summary && lastDeckId !== null ? (
                      <SummaryView result={{ summary, deckId: lastDeckId }} />
                    ) : added !== undefined ? (
                      <>
                        <p className="template-added"><CheckIcon size={16} />已經加入過了</p>
                        <div className="btn-row">
                          <Link to={`/deck/${added.id}`} className="btn">打開牌組</Link>
                          <button className="btn tinted" disabled={busy} onClick={() => importTemplate(t)}>
                            {importingTemplate === t.id ? '匯入中…' : '補上新字'}
                          </button>
                        </div>
                      </>
                    ) : (
                      <button className="btn lg" disabled={busy} onClick={() => importTemplate(t)}>
                        {importingTemplate === t.id ? '匯入中…（要查重音，稍等一下）' : `加入這 ${t.count} 字`}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {mode === 'share' && (
          <>
            <p className="import-intro">朋友傳來的分享連結貼在這裡，會匯入成同名的牌組；已經有的字會跳過。</p>
            <form className="paste-share" onSubmit={(e) => { e.preventDefault(); loadPasted() }}>
              <input value={pasteText} onChange={(e) => setPasteText(e.target.value)}
                placeholder="貼上分享連結" aria-label="分享連結" inputMode="url" autoCapitalize="off" autoCorrect="off" />
              <button className="btn" type="submit" disabled={busy || pasteText.trim() === ''}>讀取</button>
            </form>
            {pasteErr !== '' && <p className="err" role="alert">{pasteErr}</p>}
            {pastedCode !== null && shareCard}
          </>
        )}

        {(mode === 'csv' || mode === 'apkg') && (
          <>
            {mode === 'csv' ? (
              <p className="import-intro">一列一個字：單字、讀音、意思（重音可有可無）。第一列可以是表頭，欄位會自動對應。</p>
            ) : (
              <p className="import-intro">讀 Anki / AnkiWeb 的 .apkg。只拿文字；進度、圖片、音檔不帶，全部當新卡重排。</p>
            )}
            <div className="file-row">
              <label className="file-pick">
                <input type="file" accept={mode === 'csv' ? '.csv,text/csv' : '.apkg,.colpkg'}
                  onChange={async (e) => {
                    const f = e.target.files?.[0]
                    e.target.value = '' // 清掉選檔紀錄,否則選同一個檔案第二次不會觸發
                    if (!f) return
                    setFileName(f.name)
                    if (mode === 'apkg') { void onApkgFile(f); return }
                    // 檔名當牌組名的預設值,免得沒填名稱默默生出一副「新牌組」
                    if (deckId === 'new' && newDeckName.trim() === '') {
                      setNewDeckName(f.name.replace(/\.csv$/i, ''))
                    }
                    onTextLoaded(await f.text())
                  }} />
                <span className="btn tinted">{mode === 'csv' ? <FileIcon size={18} /> : <UploadIcon size={18} />}
                  選擇{mode === 'csv' ? ' CSV ' : ' .apkg '}檔</span>
              </label>
              {fileName !== '' && <span className="file-name">{fileName}</span>}
            </div>
            {mode === 'csv' && (
              <textarea rows={5} placeholder={`或直接貼上 CSV 內容，例如：\n${CSV_EXAMPLE}`} value={text}
                aria-label="CSV 內容" onChange={(e) => { setFileName(''); onTextLoaded(e.target.value) }} />
            )}
            {mode === 'apkg' && parsing && <p className="hint import-status" role="status"><span className="spinner" aria-hidden="true" />解析中…</p>}
            {mode === 'apkg' && apkg && apkg.notetypes.length > 1 && (
              <ListSection header="樣板">
                <label className="row">
                  <span className="row-main"><span className="row-title">使用的樣板</span></span>
                  <select className="row-select" value={notetypeId} onChange={(e) => selectNotetype(apkg, e.target.value)}>
                    {apkg.notetypes.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}（{t.noteCount} 筆）</option>
                    ))}
                  </select>
                </label>
              </ListSection>
            )}

            {activeMapping && fieldOptions.length > 0 && (
              <>
                <ListSection header="欄位對應" footer="重音留空的字，匯入時會自動查字典。">
                  {mode === 'csv' && rows.length > 0 && (
                    <label className="row">
                      <span className="row-main"><span className="row-title">第一列是表頭</span></span>
                      <Switch label="第一列是表頭" checked={hasHeader} onChange={setHasHeader} />
                    </label>
                  )}
                  {labels.map(([field, label]) => (
                    <label className="row" key={field}>
                      <span className="row-main"><span className="row-title">{label}</span></span>
                      <select className="row-select"
                        value={activeMapping[field] === null ? '' : String(activeMapping[field])}
                        onChange={(e) => setMappingField(field, e.target.value === '' ? null : Number(e.target.value))}>
                        {OPTIONAL_FIELDS.has(field) && <option value="">（無）</option>}
                        {fieldOptions.map((cell, i) => (
                          <option key={i} value={i}>
                            {mode === 'csv' ? `第 ${i + 1} 欄（${cell}…）` : cell || `欄位 ${i + 1}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </ListSection>

                <ListSection header={`預覽（共 ${parsed.length} 筆${mode === 'apkg' && otherNoteCount > 0 ? `，另有 ${otherNoteCount} 筆屬於其他樣板不會匯入` : ''}）`}>
                  <div className="preview-scroll">
                    <table className="preview">
                      <thead><tr><th>單字</th><th>讀音</th><th>意思</th><th>重音</th></tr></thead>
                      <tbody>
                        {parsed.slice(0, 5).map((r, i) => (
                          <tr key={i}><td lang="ja">{r.expression}</td><td lang="ja">{r.reading}</td><td>{r.meaning}</td><td>{r.accent}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </ListSection>

                {targetDeck}
                {reverseToggle}
                {needsName && <p className="hint import-need-name">先幫新牌組取個名字，再匯入。</p>}
                <button className="btn lg import-go" disabled={busy || parsed.length === 0 || needsName} onClick={doImport}>
                  {busy ? '匯入中…' : `匯入 ${parsed.length} 筆到「${targetName || '新牌組'}」`}
                </button>
              </>
            )}
          </>
        )}

        {summary && lastDeckId !== null && mode !== 'share' && mode !== 'templates' && (
          <SummaryView result={{ summary, deckId: lastDeckId }} />
        )}
        {errMsg && <p className="err import-err" role="alert">匯入失敗：{errMsg}</p>}
      </div>
    </>
  )
}
