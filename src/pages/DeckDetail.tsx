import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import {
  createNote, enableReverseCards, moveNote, softDeleteDeck, softDeleteNote,
  updateDeck, updateNote, type NoteInput,
} from '../db/repo'
import { exportCsv } from '../lib/csv'
import { download } from '../lib/download'
import { fillMissingAccents, isValidAccent, lookupAccents } from '../lib/accent'
import { PitchAccent } from '../components/PitchAccent'
import { isSpeechSupported, speak } from '../lib/speak'
import { requestSync } from '../lib/sync'
import { State } from '../lib/fsrs'
import { useBusy } from '../lib/useBusy'
import { Loading } from '../components/Loading'
import { SpeakerIcon } from '../components/SpeakerIcon'
import type { NoteRecord } from '../../shared/types'

const EMPTY: NoteInput = { expression: '', reading: '', meaning: '', reversed: false, accent: '' }
// 一次只掛這麼多列到 DOM;捲到底再長出下一批。整副 869 筆全部掛上去時,
// 光是清空搜尋就要重建近千個節點,在手機上看得出頓挫。
const PAGE_SIZE = 60

type SortKey = 'added-desc' | 'added-asc' | 'kana'
const SORTS: readonly (readonly [SortKey, string])[] = [
  ['added-desc', '最近新增/編輯'],
  ['added-asc', '匯入順序'],
  ['kana', '五十音'],
]

/** 一筆 note 的複習狀態標籤(彙總它的正/反向卡):到期 > 學習中 > 新卡 > 排程中 */
function noteStateBadge(cards: { state: number; due: number }[] | undefined, now: number) {
  if (!cards || cards.length === 0) return null
  if (cards.some((c) => c.state !== State.New && c.due <= now)) return { label: '到期', cls: 'c-due' }
  if (cards.some((c) => c.state === State.Learning || c.state === State.Relearning)) {
    return { label: '學習中', cls: 'c-learn' }
  }
  if (cards.every((c) => c.state === State.New)) return { label: '新', cls: 'c-new' }
  return { label: '排程中', cls: 'faint' }
}

export default function DeckDetail() {
  const { deckId } = useParams()
  const navigate = useNavigate()
  const deck = useLiveQuery(() => db.decks.get(deckId!), [deckId])
  const notes = useLiveQuery(
    () => db.notes.where('deck_id').equals(deckId!).filter((n) => !n.deleted).toArray(), [deckId],
  )
  // 列表每行的狀態標籤要看卡片;搬移牌組的下拉要牌組列表
  const deckCards = useLiveQuery(
    () => db.cards.where('deck_id').equals(deckId!).filter((c) => !c.deleted).toArray(), [deckId],
  )
  const allDecks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray(), [])
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortKey>('added-desc')
  const [editingId, setEditingId] = useState<string | null>(null) // 'new' = 新增模式
  const [form, setForm] = useState<NoteInput>(EMPTY)
  const [moveTo, setMoveTo] = useState<string | null>(null)
  const [deckName, setDeckName] = useState<string | null>(null)
  const [newPerDay, setNewPerDay] = useState<number | null>(null)
  const [busy, run] = useBusy()
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const sentinel = useRef<HTMLDivElement | null>(null)

  // 搜尋或排序變了就從頭算起
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [search, sort])

  const cardsByNote = useMemo(() => {
    const m = new Map<string, { state: number; due: number }[]>()
    for (const c of deckCards ?? []) {
      const list = m.get(c.note_id)
      if (list) list.push(c)
      else m.set(c.note_id, [c])
    }
    return m
  }, [deckCards])

  const sorted = useMemo(() => {
    if (!notes) return []
    const arr: NoteRecord[] = [...notes]
    if (sort === 'added-desc') arr.sort((a, b) => b.updated_at - a.updated_at)
    else if (sort === 'added-asc') arr.sort((a, b) => a.updated_at - b.updated_at)
    else arr.sort((a, b) => (a.reading || a.expression).localeCompare(b.reading || b.expression, 'ja'))
    return arr
  }, [notes, sort])

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
    ? sorted.filter((n) => [n.expression, n.reading, n.meaning].some((s) => s.includes(search)))
    : sorted
  const shown = filtered.slice(0, visibleCount)
  const listNow = Date.now()

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
      requestSync()
    } catch (e) {
      setAnnotateMsg(null)
      setErrMsg(`自動標註失敗:${e instanceof Error ? e.message : String(e)}`)
    }
  })

  const bulkReverse = () => run(async () => {
    const missing = notes.filter((n) => n.reversed === 0).length
    if (missing === 0) { setAnnotateMsg('所有卡片都已開啟反向卡'); return }
    if (!confirm(`為 ${missing} 筆卡片開啟反向卡(意思→單字)?新的反向卡從新卡開始排程。`)) return
    try {
      const changed = await enableReverseCards(deck.id)
      setAnnotateMsg(`已為 ${changed} 筆開啟反向卡`)
      setErrMsg(null)
      requestSync()
    } catch (e) {
      setErrMsg(`開啟反向卡失敗:${e instanceof Error ? e.message : String(e)}`)
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
      else if (editingId) {
        await updateNote(editingId, form)
        if (moveTo !== null && moveTo !== deck.id) {
          await moveNote(editingId, moveTo)
          const target = allDecks?.find((d) => d.id === moveTo)
          setAnnotateMsg(`已把「${form.expression}」搬到「${target?.name ?? '另一副牌組'}」`)
        }
      }
      setEditingId(null)
      setForm(EMPTY)
      setMoveTo(null)
      setErrMsg(null)
      requestSync()
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
      requestSync()
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
      setErrMsg(null)
      // 系統分享面板只給觸控裝置:桌機的 navigator.share 也存在,但 macOS 的
      // popover 常沒人注意到,await 不會 resolve,busy 鎖住整頁按鈕 =「卡死」。
      if (typeof navigator.share === 'function' && matchMedia('(hover: none)').matches) {
        try {
          await navigator.share({ title: `字卡牌組:${deck.name}`, url })
          setShareMsg('已分享')
          return
        } catch (e) {
          // 自己關掉面板 → 收工;其他失敗(如上傳太久手勢過期)→ 落到複製
          if (e instanceof DOMException && e.name === 'AbortError') { setShareMsg(null); return }
        }
      }
      try {
        await navigator.clipboard.writeText(url)
        setShareMsg(`已複製連結:${url}`)
      } catch {
        setShareMsg(`連結(請手動複製):${url}`)
      }
    } catch (e) {
      setShareMsg(null)
      setErrMsg(`分享失敗:${e instanceof Error ? e.message : String(e)}`)
    }
  })

  const removeDeck = () => run(async () => {
    if (!confirm(`刪除牌組「${deck.name}」與其所有卡片?`)) return
    try {
      await softDeleteDeck(deck.id)
      setErrMsg(null)
      requestSync()
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
      requestSync()
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
            <button className="btn secondary" disabled={busy} onClick={() => void bulkReverse()}>為整副開啟反向卡</button>
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
          {editingId !== 'new' && allDecks !== undefined && allDecks.length > 1 && (
            <label className="field">牌組(改選別副 = 搬過去,進度保留)
              <select value={moveTo ?? deck.id} onChange={(e) => setMoveTo(e.target.value)}>
                {allDecks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          )}
          <div className="form-actions">
            <button className="btn" disabled={busy} onClick={() => void saveNote()}>儲存</button>
            <button className="btn secondary" onClick={() => { setEditingId(null); setMoveTo(null) }}>取消</button>
          </div>
        </div>
      )}

      <div className="list-controls">
        <div className="search-wrap">
          <input className="search" placeholder="搜尋" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search !== '' && (
            <button className="search-clear" aria-label="清除搜尋" onClick={() => setSearch('')}>✕</button>
          )}
        </div>
        <select className="sort-select" aria-label="排序" value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}>
          {SORTS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </div>
      <ul className="note-list">
        {shown.map((n) => {
          const badge = noteStateBadge(cardsByNote.get(n.id), listNow)
          return (
          <li key={n.id} className="note-row">
            <div className="note-text">
              <b lang="ja">{n.expression}</b>
              {n.reading && <span className="reading-inline" lang="ja">{n.reading}</span>}
              <span>{n.meaning}</span>
              {badge !== null && <span className={`note-state ${badge.cls}`}>{badge.label}</span>}
            </div>
            <button className="link" onClick={() => {
              setEditingId(n.id)
              setMoveTo(null)
              setForm({ expression: n.expression, reading: n.reading, meaning: n.meaning, reversed: n.reversed === 1, accent: n.accent ?? '' })
            }}>編輯</button>
            <button className="link danger" disabled={busy}
              onClick={() => void removeNote(n.id, n.expression)}>刪除</button>
          </li>
          )
        })}
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
