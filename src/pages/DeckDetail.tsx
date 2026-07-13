import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import {
  createNote, softDeleteDeck, softDeleteNote, updateDeck, updateNote, type NoteInput,
} from '../db/repo'
import { exportCsv } from '../lib/csv'
import { download } from '../lib/download'

const EMPTY: NoteInput = { expression: '', reading: '', meaning: '', reversed: false }

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

  if (!deck || !notes) return null
  if (deck.deleted) return <p>牌組已刪除</p>

  const filtered = search
    ? notes.filter((n) => [n.expression, n.reading, n.meaning].some((s) => s.includes(search)))
    : notes

  const saveNote = async () => {
    if (!form.expression.trim() || !form.meaning.trim()) return
    if (editingId === 'new') await createNote(deck.id, form)
    else if (editingId) await updateNote(editingId, form)
    setEditingId(null)
    setForm(EMPTY)
  }

  const saveDeck = async () => {
    await updateDeck(deck.id, {
      name: deckName ?? deck.name,
      new_per_day: newPerDay ?? deck.new_per_day,
    })
    setDeckName(null); setNewPerDay(null)
  }

  const removeDeck = async () => {
    if (!confirm(`刪除牌組「${deck.name}」與其所有卡片?`)) return
    await softDeleteDeck(deck.id)
    navigate('/')
  }

  return (
    <div>
      <h1>{deck.name}</h1>
      <div className="toolbar">
        <Link to={`/review/${deck.id}`} className="btn">開始複習</Link>
        <button className="btn secondary" onClick={() => download(`${deck.name}.csv`, exportCsv(notes))}>
          匯出 CSV
        </button>
        <button className="btn secondary" onClick={() => { setEditingId('new'); setForm(EMPTY) }}>＋新增卡片</button>
      </div>

      {editingId !== null && (
        <div className="note-form">
          <input placeholder="單字" value={form.expression}
            onChange={(e) => setForm({ ...form, expression: e.target.value })} />
          <input placeholder="讀音(可空)" value={form.reading}
            onChange={(e) => setForm({ ...form, reading: e.target.value })} />
          <input placeholder="意思" value={form.meaning}
            onChange={(e) => setForm({ ...form, meaning: e.target.value })} />
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
              setForm({ expression: n.expression, reading: n.reading, meaning: n.meaning, reversed: n.reversed === 1 })
            }}>編輯</button>
            <button className="link danger" onClick={async () => {
              if (confirm(`刪除「${n.expression}」?`)) await softDeleteNote(n.id)
            }}>刪除</button>
          </li>
        ))}
      </ul>
      <p className="hint">{filtered.length} / {notes.length} 筆</p>

      <h2>牌組設定</h2>
      <div className="deck-settings">
        <label>名稱 <input value={deckName ?? deck.name} onChange={(e) => setDeckName(e.target.value)} /></label>
        <label>每日新卡上限 <input type="number" min={0} value={newPerDay ?? deck.new_per_day}
          onChange={(e) => setNewPerDay(Number(e.target.value))} /></label>
        <div className="form-actions">
          <button className="btn" onClick={saveDeck}>儲存設定</button>
          <button className="btn danger" onClick={removeDeck}>刪除牌組</button>
        </div>
      </div>
    </div>
  )
}
