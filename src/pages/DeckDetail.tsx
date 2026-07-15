import { useRef, useState } from 'react'
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
import { SpeakerIcon } from '../components/SpeakerIcon'

const EMPTY: NoteInput = { expression: '', reading: '', meaning: '', reversed: false, accent: '' }

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
  const busy = useRef(false)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [looking, setLooking] = useState(false)
  const [annotateMsg, setAnnotateMsg] = useState<string | null>(null)

  if (!deck || !notes) return null
  if (deck.deleted) return <p>牌組已刪除</p>

  const filtered = search
    ? notes.filter((n) => [n.expression, n.reading, n.meaning].some((s) => s.includes(search)))
    : notes

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

  const annotateDeck = async () => {
    if (busy.current) return
    const blanks = notes.filter((n) => !n.accent)
    if (blanks.length === 0) { setAnnotateMsg('這副牌組沒有待標註的卡片'); return }
    busy.current = true
    setAnnotateMsg(`標註中…(${blanks.length} 筆)`)
    try {
      const { rows, filled, missed } = await fillMissingAccents(
        blanks.map((n) => ({ id: n.id, expression: n.expression, reading: n.reading, accent: n.accent ?? '' })),
      )
      for (const r of rows) {
        if (r.accent !== '') await updateNote(r.id, { accent: r.accent })
      }
      setAnnotateMsg(`完成:標註 ${filled} 筆,查無 ${missed} 筆`)
      setErrMsg(null)
    } catch (e) {
      setAnnotateMsg(null)
      setErrMsg(`自動標註失敗:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      busy.current = false
    }
  }

  const saveNote = async () => {
    if (busy.current) return
    if (!form.expression.trim() || !form.meaning.trim()) {
      setErrMsg('單字與意思為必填')
      return
    }
    if (!isValidAccent(form.accent.trim())) {
      setErrMsg('重音格式錯誤(只能是數字,多重音用逗號分隔,如 0 或 0,3)')
      return
    }
    busy.current = true
    try {
      if (editingId === 'new') await createNote(deck.id, form)
      else if (editingId) await updateNote(editingId, form)
      setEditingId(null)
      setForm(EMPTY)
      setErrMsg(null)
    } catch (e) {
      setErrMsg(`操作失敗:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      busy.current = false
    }
  }

  const saveDeck = async () => {
    if (busy.current) return
    busy.current = true
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
    } finally {
      busy.current = false
    }
  }

  const removeDeck = async () => {
    if (busy.current) return
    if (!confirm(`刪除牌組「${deck.name}」與其所有卡片?`)) return
    busy.current = true
    try {
      await softDeleteDeck(deck.id)
      setErrMsg(null)
      navigate('/')
    } catch (e) {
      setErrMsg(`操作失敗:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      busy.current = false
    }
  }

  return (
    <div>
      <h1>{deck.name}</h1>
      {errMsg && <p className="err">{errMsg}</p>}
      <div className="toolbar">
        <Link to={`/review/${deck.id}`} className="btn">開始複習</Link>
        <button className="btn secondary" onClick={() => download(`${deck.name}.csv`, exportCsv(notes))}>
          匯出 CSV
        </button>
        <button className="btn secondary" onClick={() => { setEditingId('new'); setForm(EMPTY) }}>＋新增卡片</button>
        <button className="btn secondary" onClick={annotateDeck}>自動標註重音</button>
      </div>
      {annotateMsg && <p className="hint">{annotateMsg}</p>}

      {editingId !== null && (
        <div className="note-form">
          <input placeholder="單字" value={form.expression}
            onChange={(e) => setForm({ ...form, expression: e.target.value })} />
          <div className="accent-field">
            <input placeholder="讀音(可空)" value={form.reading}
              onChange={(e) => setForm({ ...form, reading: e.target.value })} />
            {isSpeechSupported() && (
              <button type="button" className="speak-btn" aria-label="播放發音"
                onClick={() => speak(form.reading || form.expression)}><SpeakerIcon /></button>
            )}
          </div>
          <input placeholder="意思" value={form.meaning}
            onChange={(e) => setForm({ ...form, meaning: e.target.value })} />
          <div className="accent-field">
            <input placeholder="重音(如 0、2、0,3;可空)" value={form.accent}
              onChange={(e) => setForm({ ...form, accent: e.target.value })} />
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
            <button className="btn" onClick={saveNote}>儲存</button>
            <button className="btn secondary" onClick={() => setEditingId(null)}>取消</button>
          </div>
        </div>
      )}

      <input className="search" placeholder="搜尋" value={search} onChange={(e) => setSearch(e.target.value)} />
      <ul className="note-list">
        {filtered.map((n) => (
          <li key={n.id} className="note-row">
            <div className="note-text">
              <b>{n.expression}</b>
              {n.reading && <span className="reading-inline">{n.reading}</span>}
              <span>{n.meaning}</span>
            </div>
            <button className="link" onClick={() => {
              setEditingId(n.id)
              setForm({ expression: n.expression, reading: n.reading, meaning: n.meaning, reversed: n.reversed === 1, accent: n.accent ?? '' })
            }}>編輯</button>
            <button className="link danger" onClick={async () => {
              if (busy.current) return
              if (confirm(`刪除「${n.expression}」?`)) {
                busy.current = true
                try {
                  await softDeleteNote(n.id)
                  setErrMsg(null)
                } catch (e) {
                  setErrMsg(`操作失敗:${e instanceof Error ? e.message : String(e)}`)
                } finally {
                  busy.current = false
                }
              }
            }}>刪除</button>
          </li>
        ))}
      </ul>
      <p className="hint">{filtered.length} / {notes.length} 筆</p>

      <h2>牌組設定</h2>
      <div className="deck-settings">
        <label>名稱 <input value={deckName ?? deck.name} onChange={(e) => setDeckName(e.target.value)} /></label>
        <label>每日新卡上限 <input type="number" min={0}
          value={newPerDay !== null && Number.isNaN(newPerDay) ? '' : newPerDay ?? deck.new_per_day}
          onChange={(e) => setNewPerDay(e.target.value === '' ? NaN : Number(e.target.value))} /></label>
        <div className="form-actions">
          <button className="btn" onClick={saveDeck}>儲存設定</button>
          <button className="btn danger" onClick={removeDeck}>刪除牌組</button>
        </div>
      </div>
    </div>
  )
}
