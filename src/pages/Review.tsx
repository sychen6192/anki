import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { db } from '../db/db'
import { applyReview } from '../db/repo'
import { formatInterval, previewIntervals, rate, type RatingValue } from '../lib/fsrs'
import { buildQueue, startOfToday } from '../lib/queue'
import { syncNow } from '../lib/sync'
import type { CardRecord, NoteRecord } from '../../shared/types'

const RATING_LABELS: Record<RatingValue, string> = { 1: '重來', 2: '困難', 3: '普通', 4: '簡單' }

export default function Review() {
  const { deckId } = useParams()
  const [current, setCurrent] = useState<{ card: CardRecord; note: NoteRecord } | null>(null)
  const [showBack, setShowBack] = useState(false)
  const [remaining, setRemaining] = useState(0)
  const [done, setDone] = useState(false)
  const [nextDue, setNextDue] = useState<number | null>(null)

  const loadNext = useCallback(async () => {
    const deck = await db.decks.get(deckId!)
    if (!deck) return
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
    const card = queue[0]
    const note = (await db.notes.get(card.note_id))!
    setCurrent({ card, note })
    setRemaining(queue.length)
    setShowBack(false)
  }, [deckId])

  useEffect(() => { void loadNext() }, [loadNext])

  const answer = useCallback(async (rating: RatingValue) => {
    if (!current) return
    const { fields, log } = rate(current.card, rating)
    await applyReview(current.card, fields, log)
    await loadNext()
  }, [current, loadNext])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ') { e.preventDefault(); setShowBack(true) }
      else if (showBack && ['1', '2', '3', '4'].includes(e.key)) void answer(Number(e.key) as RatingValue)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showBack, answer])

  if (done) {
    return (
      <div className="review-done">
        <h1>今日完成 🎉</h1>
        {nextDue !== null && <p>還有學習中的卡片,約 {formatInterval(nextDue - Date.now())}後到期</p>}
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
      <p className="remaining">剩 {remaining} 張</p>
      <div className="flashcard" onClick={() => setShowBack(true)}>
        {!showBack ? (
          <p className="expression">{front}</p>
        ) : (
          <>
            <p className="expression">{note.expression}</p>
            {note.reading !== '' && <p className="reading">{note.reading}</p>}
            <p className="meaning">{note.meaning}</p>
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
