import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import {
  createNote, softDeleteDeck, softDeleteNote, updateDeck, updateNote, type NoteInput,
} from '../db/repo'
import { exportCsv } from '../lib/csv'
import { download } from '../lib/download'
import { fillMissingAccents, isValidAccent, lookupAccents } from '../lib/accent'
import { PitchAccent } from '../components/PitchAccent'
import { isSpeechSupported, speak } from '../lib/speak'
import { useBusy } from '../lib/useBusy'
import { Loading } from '../components/Loading'
import { SpeakerIcon } from '../components/SpeakerIcon'

const EMPTY: NoteInput = { expression: '', reading: '', meaning: '', reversed: false, accent: '' }
// 一次只掛這麼多列到 DOM;捲到底再長出下一批。整副 869 筆全部掛上去時,
// 光是清空搜尋就要重建近千個節點,在手機上看得出頓挫。
const PAGE_SIZE = 60

export default function DeckDetail() {
  const { deckId } = useParams()
  const navigate = useNavigate()
  const deck = useLiveQuery(() => db.decks.get(deckId!), [deckId])
  const notes = useLiveQuery(
    () => db.notes.where('deck_id').equals(deckId!).filter((n) => !n.deleted).toArray(), [deckId],
  )
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null) // 'new' = 新增模式
  const [form, setForm] = useState<NoteInput>(EMPTY)
  const [deckName, setDeckName] = useState<string | null>(null)
  const [newPerDay, setNewPerDay] = useState<number | null>(null)
  const [busy, run] = useBusy()
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const sentinel = useRef<HTMLDivElement | null>(null)

  // 搜尋條件變了就從頭算起
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [search])

  // 捲到列表底部就再多顯示一批
  useEffect(() => {
    const el = sentinel.current
    if (el === null || typeof IntersectionObserver !== 'function') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisibleCount((n) => n + PAGE_SIZE)
    }, { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [notes, search])
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [looking, setLooking] = useState(false)
  const [annotateMsg, setAnnotateMsg] = useState<string | null>(null)
  const [shareMsg, setShareMsg] = useState<string | null>(null)

  if (!deck || !notes) return <Loading />
  if (deck.deleted) {
    return (
      <div className="review-done">
        <h1>牌組已刪除</h1>
        <Link to="/" className="btn">回牌組列表</Link>
      </div>
    )
  }

  const filtered = search
    ? notes.filter((n) => [n.expression, n.reading, n.meaning].some((s) => s.includes(search)))
    : notes
  const shown = filtered.slice(0, visibleCount)

  const lookupOne = async () => {
    if (!form.expression.trim()) { setErrMsg('請先輸入單字'); return }
    setLooking(true)
    try {
      const [pitch] = await lookupAccents([{ expression: form.expression.trim(), reading: form.reading.trim() }])
      if (pitch != null) { setForm((f) => ({ ...f, accent: pitch })); setErrMsg(null) }
      else setErrMsg('字典查無此字的重音')
    } catch (e) {
      setErrMsg(`查詢失敗:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLooking(false)
    }
  }

  const annotateDeck = () => run(async () => {
    const blanks = notes.filter((n) => !n.accent)
    if (blanks.length === 0) { setAnnotateMsg('這副牌組沒有待標註的卡片'); return }
    setAnnotateMsg(`標註中…(${blanks.length} 筆)`)
    try {
      const { rows, filled, missed } = await fillMissingAccents(
        blanks.map((n) => ({ id: n.id, expression: n.expression, reading: n.reading, accent: n.accent ?? '' })),
      )
      // 幾百筆各開一個交易會慢到看得出來,包成一個交易寫回
      await db.transaction('rw', [db.notes, db.cards], async () => {
        for (const r of rows) {
          if (r.accent !== '') await updateNote(r.id, { accent: r.accent })
        }
      })
      setAnnotateMsg(`完成:標註 ${filled} 筆,查無 ${missed} 筆`)
      setErrMsg(null)
    } catch (e) {
      setAnnotateMsg(null)
      setErrMsg(`自動標註失敗:${e instanceof Error ? e.message : String(e)}`)
    }
  })

  const saveNote = () => run(async () => {
    if (!form.expression.trim() || !form.meaning.trim()) {
      setErrMsg('單字與意思為必填')
      return
    }
    if (!isValidAccent(form.accent.trim())) {
      setErrMsg('重音格式錯誤(只能是數字,多重音用逗號分隔,如 0 或 0,3)')
      return
    }
    try {
      if (editingId === 'new') await createNote(deck.id, form)
      else if (editingId) await updateNote(editingId, form)
      setEditingId(null)
      setForm(EMPTY)
      setErrMsg(null)
    } catch (e) {
      setErrMsg(`操作失敗:${e instanceof Error ? e.message : String(e)}`)
    }
  })

  const saveDeck = () => run(async () => {
    try {
      const name = (deckName ?? deck.name).trim()
      if (name === '') {
        setErrMsg('牌組名稱不能是空的')
        return
      }
      const rawLimit = newPerDay ?? deck.new_per_day
      if (Number.isNaN(rawLimit)) {
        setErrMsg('請輸入每日新卡上限')
        return
      }
      const limit = Math.max(0, Math.floor(rawLimit))
      await updateDeck(deck.id, {
        name,
        new_per_day: limit,
      })
      setDeckName(null); setNewPerDay(null)
      setErrMsg(null)
    } catch (e) {
      setErrMsg(`操作失敗:${e instanceof Error ? e.message : String(e)}`)
    }
  })

  /** 產生分享連結:內容上傳到 /api/share,拿 code 組網址;手機開分享面板、桌機複製 */
  const shareDeck = () => run(async () => {
    try {
      setShareMsg(`上傳 ${notes.length} 筆…`)
      const rows = notes.map((n) => ({
        expression: n.expression, reading: n.reading, meaning: n.meaning, accent: n.accent ?? '',
      }))
      // 大牌組的 JSON 有幾十 KB,行動網路上行慢 —— 能壓就壓(約剩 1/3)
      const json = JSON.stringify({ name: deck.name, rows })
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      let payload: BodyInit = json
      if (typeof CompressionStream === 'function') {
        payload = await new Response(
          new Blob([json]).stream().pipeThrough(new CompressionStream('gzip')),
        ).blob()
        headers['x-body-gzip'] = '1'
      }
      const res = await fetch('/api/share', { method: 'POST', headers, body: payload })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { code } = await res.json() as { code: string }
      const url = `${location.origin}/import?share=${code}`
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: `字卡牌組:${deck.name}`, url })
        setShareMsg('已分享')
      } else {
        await navigator.clipboard.writeText(url)
        setShareMsg('連結已複製,貼給朋友就能匯入')
      }
      setErrMsg(null)
    } catch (e) {
      setShareMsg(null)
      // 使用者自己關掉分享面板不是錯誤
      if (e instanceof DOMException && e.name === 'AbortError') return
      setErrMsg(`分享失敗:${e instanceof Error ? e.message : String(e)}`)
    }
  })

  const removeDeck = () => run(async () => {
    if (!confirm(`刪除牌組「${deck.name}」與其所有卡片?`)) return
    try {
      await softDeleteDeck(deck.id)
      setErrMsg(null)
      navigate('/')
    } catch (e) {
      setErrMsg(`操作失敗:${e instanceof Error ? e.message : String(e)}`)
    }
  })

  const removeNote = (id: string, label: string) => run(async () => {
    if (!confirm(`刪除「${label}」?`)) return
    try {
      await softDeleteNote(id)
      setErrMsg(null)
    } catch (e) {
      setErrMsg(`操作失敗:${e instanceof Error ? e.message : String(e)}`)
    }
  })

  return (
    <div>
      <h1>{deck.name}</h1>
      {errMsg && <p className="err" role="alert">{errMsg}</p>}
      <div className="toolbar">
        <Link to={`/review/${deck.id}`} className="btn">開始複習</Link>
        <button className="btn secondary" onClick={() => download(`${deck.name}.csv`, exportCsv(notes))}>
          匯出 CSV
        </button>
        <button className="btn secondary" onClick={() => { setEditingId('new'); setForm(EMPTY) }}>＋新增卡片</button>
        <button className="btn secondary" disabled={busy} onClick={() => void annotateDeck()}>自動標註重音</button>
        <button className="btn secondary" disabled={busy || notes.length === 0} onClick={() => void shareDeck()}>分享牌組</button>
      </div>
      {annotateMsg && <p className="hint" role="status" aria-live="polite">{annotateMsg}</p>}
      {shareMsg && <p className="hint" role="status" aria-live="polite">{shareMsg}</p>}

      {/* 收合放列表上方:長牌組的列表會越捲越長,放底部根本捲不到 */}
      <details className="deck-settings-details">
        <summary>牌組設定</summary>
        <div className="deck-settings">
          <label>名稱 <input value={deckName ?? deck.name} onChange={(e) => setDeckName(e.target.value)} /></label>
          <label>每日新卡上限 <input type="number" min={0}
            value={newPerDay !== null && Number.isNaN(newPerDay) ? '' : newPerDay ?? deck.new_per_day}
            onChange={(e) => setNewPerDay(e.target.value === '' ? NaN : Number(e.target.value))} /></label>
          <div className="form-actions">
            <button className="btn" disabled={busy} onClick={() => void saveDeck()}>儲存設定</button>
            <button className="btn danger" disabled={busy} onClick={() => void removeDeck()}>刪除牌組</button>
          </div>
        </div>
      </details>

      {editingId !== null && (
        <div className="note-form">
          <label className="field">單字
            <input placeholder="例如 勉強" value={form.expression}
              onChange={(e) => setForm({ ...form, expression: e.target.value })} />
          </label>
          <div className="accent-field">
            <label className="field">讀音(可空)
              <input placeholder="例如 べんきょう" value={form.reading}
                onChange={(e) => setForm({ ...form, reading: e.target.value })} />
            </label>
            {isSpeechSupported() && (
              <button type="button" className="speak-btn" aria-label="播放發音"
                onClick={() => speak(form.reading || form.expression)}><SpeakerIcon /></button>
            )}
          </div>
          <label className="field">意思
            <input placeholder="例如 讀書、用功" value={form.meaning}
              onChange={(e) => setForm({ ...form, meaning: e.target.value })} />
          </label>
          <div className="accent-field">
            <label className="field">重音(可空)
              <input placeholder="如 0、2、0,3" value={form.accent}
                onChange={(e) => setForm({ ...form, accent: e.target.value })} />
            </label>
            <button type="button" className="btn secondary" disabled={looking} onClick={lookupOne}>
              {looking ? '查詢中…' : '自動查詢'}
            </button>
          </div>
          {form.reading.trim() !== '' && form.accent.trim() !== '' && isValidAccent(form.accent.trim()) && (
            <div className="accent-preview"><PitchAccent reading={form.reading.trim()} accent={form.accent.trim()} /></div>
          )}
          <label><input type="checkbox" checked={form.reversed}
            onChange={(e) => setForm({ ...form, reversed: e.target.checked })} /> 反向卡(意思→單字)</label>
          <div className="form-actions">
            <button className="btn" disabled={busy} onClick={() => void saveNote()}>儲存</button>
            <button className="btn secondary" onClick={() => setEditingId(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="search-wrap">
        <input className="search" placeholder="搜尋" value={search} onChange={(e) => setSearch(e.target.value)} />
        {search !== '' && (
          <button className="search-clear" aria-label="清除搜尋" onClick={() => setSearch('')}>✕</button>
        )}
      </div>
      <ul className="note-list">
        {shown.map((n) => (
          <li key={n.id} className="note-row">
            <div className="note-text">
              <b lang="ja">{n.expression}</b>
              {n.reading && <span className="reading-inline" lang="ja">{n.reading}</span>}
              <span>{n.meaning}</span>
            </div>
            <button className="link" onClick={() => {
              setEditingId(n.id)
              setForm({ expression: n.expression, reading: n.reading, meaning: n.meaning, reversed: n.reversed === 1, accent: n.accent ?? '' })
            }}>編輯</button>
            <button className="link danger" disabled={busy}
              onClick={() => void removeNote(n.id, n.expression)}>刪除</button>
          </li>
        ))}
      </ul>
      <div ref={sentinel} />
      <p className="hint">
        顯示 {shown.length} / {filtered.length} 筆{filtered.length !== notes.length && `(共 ${notes.length} 筆)`}
        {shown.length < filtered.length && (
          <> · <button className="link" onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>顯示更多</button></>
        )}
      </p>

    </div>
  )
}
