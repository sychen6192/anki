import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PitchAccent } from '../components/PitchAccent'
import { isSpeechSupported, speak } from '../lib/speak'
import { SpeakerIcon } from '../components/SpeakerIcon'
import { db } from '../db/db'
import { applyReview, undoReview } from '../db/repo'
import { formatInterval, previewIntervals, rate, type RatingValue } from '../lib/fsrs'
import { buildQueue, startOfToday } from '../lib/queue'
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
  const answering = useRef(false)

  /** preferCardId:復原時用,讓剛還原的那張卡直接回到眼前,而不是排到佇列尾端 */
  const loadNext = useCallback(async (preferCardId?: string) => {
    const deck = await db.decks.get(deckId!)
    if (!deck || deck.deleted) { setMissing(true); return }
    const cards = await db.cards.where('deck_id').equals(deckId!).toArray()
    const ids = new Set(cards.map((c) => c.id))
    const logs = (await db.review_logs.where('reviewed_at').aboveOrEqual(startOfToday()).toArray())
      .filter((l) => ids.has(l.card_id))
    const { queue, nextLearningDue } = buildQueue(cards, logs, deck.new_per_day)
    if (queue.length === 0) {
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
      if (e.key === ' ') { e.preventDefault(); setShowBack(true) }
      else if (showBack && ['1', '2', '3', '4'].includes(e.key)) void answer(Number(e.key) as RatingValue)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showBack, answer])

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
        {errMsg && <p className="err">{errMsg}</p>}
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
  if (!current) return null

  const { card, note } = current
  const front = card.direction === 'forward' ? note.expression : note.meaning
  const preview = previewIntervals(card)

  return (
    <div className="review">
      <div className="review-head">
        {undoable
          ? <button className="link" onClick={() => void undo()}>↩ 復原上一張</button>
          : <span />}
        <p className="remaining">剩 {remaining} 張</p>
      </div>
      {errMsg && <p className="err">{errMsg}</p>}
      <div className="flashcard" onClick={() => setShowBack(true)}>
        {!showBack ? (
          <p className="expression">{front}</p>
        ) : (
          <>
            <p className="expression">{note.expression}</p>
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
        <button className="btn show-answer" onClick={() => setShowBack(true)}>顯示答案(空白鍵)</button>
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
    </div>
  )
}
