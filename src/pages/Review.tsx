import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PitchAccent } from '../components/PitchAccent'
import { isSpeechSupported, speak } from '../lib/speak'
import { SpeakerIcon } from '../components/SpeakerIcon'
import { PencilIcon, SkipIcon, UndoIcon } from '../components/icons'
import { Loading } from '../components/Loading'
import { db } from '../db/db'
import { applyReview, undoReview, updateNote } from '../db/repo'
import { formatInterval, previewIntervals, rate, type RatingValue } from '../lib/fsrs'
import { deckQueue, startOfToday } from '../lib/queue'
import { syncNow } from '../lib/sync'
import type { CardRecord, NoteRecord } from '../../shared/types'

const RATING_LABELS: Record<RatingValue, string> = { 1: '重來', 2: '困難', 3: '普通', 4: '簡單' }
/** 學習中的卡片若在這段時間內到期,停在完成畫面等它,時間到自動接回去複習 */
const AUTO_RESUME_WINDOW = 10 * 60 * 1000

export default function Review() {
  const { deckId } = useParams()
  const [current, setCurrent] = useState<{ card: CardRecord; note: NoteRecord } | null>(null)
  const [showBack, setShowBack] = useState(false)
  const [remaining, setRemaining] = useState(0)
  const [done, setDone] = useState(false)
  const [nextDue, setNextDue] = useState<number | null>(null)
  const [missing, setMissing] = useState(false)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [undoable, setUndoable] = useState<{ card: CardRecord; logId: string } | null>(null)
  const [tick, setTick] = useState(() => Date.now())
  const [doneStats, setDoneStats] = useState<{ count: number; correct: number } | null>(null)
  const [editing, setEditing] = useState<{ expression: string; reading: string; meaning: string; accent: string } | null>(null)
  const answering = useRef(false)
  // 這次 session 裡跳過的卡片。只存在記憶體,離開複習畫面就重來 —— 跳過是
  // 「現在不想看」,不是 Anki 的 bury,不該寫進資料庫影響排程。
  const skipped = useRef(new Set<string>())
  // 進度條用:記住這次 session 見過的最大待複習數。按「重來」會讓待複習數
  // 回升,取最大值當分母,進度條就不會倒退。
  const [sessionMax, setSessionMax] = useState(0)

  /** preferCardId:復原時用,讓剛還原的那張卡直接回到眼前,而不是排到佇列尾端 */
  const loadNext = useCallback(async (preferCardId?: string) => {
    const deck = await db.decks.get(deckId!)
    if (!deck || deck.deleted) { setMissing(true); return }
    const cards = await db.cards.where('deck_id').equals(deckId!).toArray()
    const logs = await db.review_logs.where('reviewed_at').aboveOrEqual(startOfToday()).toArray()
    const built = deckQueue(deckId!, deck.new_per_day, cards, logs)
    const nextLearningDue = built.nextLearningDue
    const queue = built.queue.filter((c) => !skipped.current.has(c.id))
    if (queue.length === 0) {
      // 完成畫面的今日成績:這副牌組今天複習幾張、一次就答對的比例
      const cardIds = new Set(cards.map((c) => c.id))
      const deckLogs = logs.filter((l) => cardIds.has(l.card_id))
      setDoneStats({ count: deckLogs.length, correct: deckLogs.filter((l) => l.rating > 1).length })
      setCurrent(null)
      setDone(true)
      setNextDue(nextLearningDue)
      void syncNow() // 複習結束觸發同步
      return
    }
    const card = (preferCardId && queue.find((c) => c.id === preferCardId)) || queue[0]
    const note = await db.notes.get(card.note_id)
    if (!note) {
      setErrMsg('卡片資料缺失')
      setCurrent(null)
      setDone(true)
      return
    }
    setCurrent({ card, note })
    setRemaining(queue.length)
    setSessionMax((m) => Math.max(m, queue.length))
    setShowBack(false)
    setDone(false)
    setNextDue(null)
  }, [deckId])

  useEffect(() => { void loadNext() }, [loadNext])

  const answer = useCallback(async (rating: RatingValue) => {
    if (!current || answering.current) return
    answering.current = true
    const answered = current.card
    try {
      const { fields, log } = rate(answered, rating)
      const logId = await applyReview(answered, fields, log)
      // 評分已儲存成功,先清掉舊錯誤——loadNext 若失敗是另一回事,不代表評分沒存到。
      setErrMsg(null)
      setUndoable({ card: answered, logId })
      try {
        await loadNext()
      } catch {
        // 評分已寫入,但下一張沒載到。清掉畫面上這張已作答的卡,
        // 否則評分按鈕還掛著舊狀態,再按一次會用過期資料重複評分。
        setCurrent(null)
        setDone(true)
        setErrMsg('載入下一張失敗,請回列表重新進入')
      }
    } catch (e) {
      setErrMsg(`評分未儲存:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      answering.current = false
    }
  }, [current, loadNext])

  const skip = useCallback(async () => {
    if (!current || answering.current) return
    skipped.current.add(current.card.id)
    await loadNext()
  }, [current, loadNext])

  const saveEdit = useCallback(async () => {
    if (!current || !editing || answering.current) return
    answering.current = true
    try {
      // 只改文字,不動「反向卡」—— 複習到一半增刪卡片會讓當下的佇列對不上
      await updateNote(current.note.id, editing)
      const fresh = await db.notes.get(current.note.id)
      if (fresh) setCurrent({ card: current.card, note: fresh })
      setEditing(null)
      setErrMsg(null)
    } catch (e) {
      setErrMsg(`儲存失敗:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      answering.current = false
    }
  }, [current, editing])

  const currentNoteFields = useCallback(() => current === null ? null : {
    expression: current.note.expression, reading: current.note.reading,
    meaning: current.note.meaning, accent: current.note.accent,
  }, [current])

  const undo = useCallback(async () => {
    if (!undoable || answering.current) return
    answering.current = true
    try {
      await undoReview(undoable.card, undoable.logId)
      setUndoable(null)
      setErrMsg(null)
      await loadNext(undoable.card.id)
    } catch (e) {
      setErrMsg(`復原失敗:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      answering.current = false
    }
  }, [undoable, loadNext])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 編輯中鍵盤要留給輸入框,只保留 Esc 取消
      if (editing !== null) {
        if (e.key === 'Escape') setEditing(null)
        return
      }
      if (e.key === ' ') { e.preventDefault(); setShowBack(true) }
      else if (e.key === 'e') { e.preventDefault(); setEditing(currentNoteFields()) }
      else if (e.key === 's') { e.preventDefault(); void skip() }
      else if (showBack && ['1', '2', '3', '4'].includes(e.key)) void answer(Number(e.key) as RatingValue)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showBack, answer, editing, skip, currentNoteFields])

  // 完成畫面上的倒數:只在馬上就有卡片到期時每秒更新,到期後自己停掉
  useEffect(() => {
    if (!done || nextDue === null || nextDue - Date.now() > AUTO_RESUME_WINDOW) return
    const id = setInterval(() => {
      setTick(Date.now())
      if (Date.now() >= nextDue) clearInterval(id)
    }, 1000)
    return () => clearInterval(id)
  }, [done, nextDue])

  // 時間到自動接回複習。每個 nextDue 只排一次,萬一還是載不到卡也不會空轉。
  useEffect(() => {
    if (!done || nextDue === null || nextDue - Date.now() > AUTO_RESUME_WINDOW) return
    const id = setTimeout(() => { void loadNext() }, Math.max(0, nextDue - Date.now()) + 200)
    return () => clearTimeout(id)
  }, [done, nextDue, loadNext])

  if (missing) {
    return (
      <div className="review-done">
        <h1>找不到這個牌組</h1>
        <Link to="/" className="btn">回牌組列表</Link>
      </div>
    )
  }
  if (done) {
    const waitMs = nextDue === null ? null : nextDue - tick
    return (
      <div className="review-done">
        <h1>今日完成 🎉</h1>
        {doneStats !== null && doneStats.count > 0 && (
          <p className="done-stats">
            今天複習 <b>{doneStats.count}</b> 張,一次答對 <b>{Math.round((doneStats.correct / doneStats.count) * 100)}%</b>
          </p>
        )}
        {errMsg && <p className="err" role="alert">{errMsg}</p>}
        {waitMs !== null && (waitMs > AUTO_RESUME_WINDOW ? (
          <p>還有學習中的卡片,約 {formatInterval(waitMs)}後到期</p>
        ) : (
          <>
            <p>還有學習中的卡片,{waitMs > 0 ? `${Math.ceil(waitMs / 1000)} 秒後自動繼續` : '正在繼續…'}</p>
            <button className="btn secondary" onClick={() => void loadNext()}>現在繼續</button>
          </>
        ))}
        {undoable && (
          <button className="btn secondary" onClick={() => void undo()}>復原上一次評分</button>
        )}
        <Link to="/" className="btn">回牌組列表</Link>
      </div>
    )
  }
  if (!current) return <Loading />

  const { card, note } = current
  const front = card.direction === 'forward' ? note.expression : note.meaning
  const preview = previewIntervals(card)

  const progress = sessionMax > 0 ? Math.round(((sessionMax - remaining + 1) / sessionMax) * 100) : 0

  return (
    <div className="review">
      <div className="session-progress" role="progressbar"
        aria-valuemin={0} aria-valuemax={sessionMax} aria-valuenow={sessionMax - remaining + 1}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="review-head">
        {undoable
          ? <button className="link icon-link" onClick={() => void undo()}><UndoIcon size={15} />復原上一張</button>
          : <span />}
        <p className="remaining">剩 {remaining} 張</p>
      </div>
      {errMsg && <p className="err" role="alert">{errMsg}</p>}
      <div className="flashcard" onClick={() => setShowBack(true)}>
        {!showBack ? (
          // 反向卡的正面是意思(中文),長句降一級字號;正向卡正面是日文單字
          <p className={`expression${front.length > 12 ? ' long' : ''}`}
            lang={card.direction === 'forward' ? 'ja' : undefined}>{front}</p>
        ) : (
          <>
            <p className="expression" lang="ja">{note.expression}</p>
            {note.reading !== '' && <PitchAccent reading={note.reading} accent={note.accent} />}
            <p className="meaning">{note.meaning}</p>
            {isSpeechSupported() && (
              <button
                className="speak-btn"
                aria-label="播放發音"
                onClick={(e) => { e.stopPropagation(); speak(note.reading || note.expression) }}
              ><SpeakerIcon /></button>
            )}
          </>
        )}
      </div>
      {!showBack ? (
        <button className="btn show-answer" onClick={() => setShowBack(true)}>
          顯示答案<span className="kbd-hint">(空白鍵)</span>
        </button>
      ) : (
        <div className="ratings">
          {([1, 2, 3, 4] as const).map((r) => (
            <button key={r} className={`btn rating-${r}`} onClick={() => answer(r)}>
              <span>{RATING_LABELS[r]}</span>
              <small>{preview[r]}</small>
            </button>
          ))}
        </div>
      )}

      {editing === null ? (
        <div className="card-actions">
          <button className="link icon-link" onClick={() => setEditing(currentNoteFields())}>
            <PencilIcon size={15} />編輯這張<span className="kbd-hint">(E)</span>
          </button>
          <button className="link icon-link" onClick={() => void skip()}>
            <SkipIcon size={15} />跳過<span className="kbd-hint">(S)</span>
          </button>
        </div>
      ) : (
        <div className="note-form">
          <label className="field">單字
            <input value={editing.expression} autoFocus
              onChange={(e) => setEditing({ ...editing, expression: e.target.value })} />
          </label>
          <label className="field">讀音
            <input value={editing.reading}
              onChange={(e) => setEditing({ ...editing, reading: e.target.value })} />
          </label>
          <label className="field">意思
            <input value={editing.meaning}
              onChange={(e) => setEditing({ ...editing, meaning: e.target.value })} />
          </label>
          <label className="field">重音
            <input value={editing.accent}
              onChange={(e) => setEditing({ ...editing, accent: e.target.value })} />
          </label>
          <div className="form-actions">
            <button className="btn" onClick={() => void saveEdit()}>儲存</button>
            <button className="btn secondary" onClick={() => setEditing(null)}>取消<span className="kbd-hint">(Esc)</span></button>
          </div>
        </div>
      )}
    </div>
  )
}
