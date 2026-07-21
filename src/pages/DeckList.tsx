import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { createDeck } from '../db/repo'
import { deckQueue, startOfToday } from '../lib/queue'
import { State } from '../lib/fsrs'
import { useBusy } from '../lib/useBusy'
import { Loading } from '../components/Loading'

export default function DeckList() {
  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray(), [])
  const cards = useLiveQuery(() => db.cards.toArray(), [])
  const todayLogs = useLiveQuery(
    () => db.review_logs.where('reviewed_at').aboveOrEqual(startOfToday()).toArray(), [],
  )
  const [name, setName] = useState('')
  const [adding, runAdd] = useBusy()

  const addDeck = () => runAdd(async () => {
    if (!name.trim()) return
    await createDeck(name)
    setName('')
  })

  if (!decks || !cards || !todayLogs) return <Loading />

  return (
    <div>
      <h1>牌組</h1>
      <ul className="deck-list">
        {decks.map((deck) => {
          const { queue } = deckQueue(deck.id, deck.new_per_day, cards, todayLogs)
          const news = queue.filter((c) => c.state === State.New).length
          const learn = queue.filter((c) => c.state === State.Learning || c.state === State.Relearning).length
          const rev = queue.length - news - learn
          return (
            <li key={deck.id} className="deck-row">
              <Link to={`/deck/${deck.id}`} className="deck-name">{deck.name}</Link>
              <span className="counts" title={`新卡 ${news} · 學習中 ${learn} · 待複習 ${rev}`}
                aria-label={`新卡 ${news},學習中 ${learn},待複習 ${rev}`}>
                <b className="c-new">{news}</b> · <b className="c-learn">{learn}</b> · <b className="c-due">{rev}</b>
              </span>
              {queue.length > 0
                ? <Link to={`/review/${deck.id}`} className="btn">複習</Link>
                : <span className="done-mark">✓</span>}
            </li>
          )
        })}
        {decks.length === 0 && <li className="empty">還沒有牌組,先建一個吧</li>}
      </ul>
      {decks.length > 0 && (
        <p className="hint legend">
          <b className="c-new">■</b> 新卡 · <b className="c-learn">■</b> 學習中 · <b className="c-due">■</b> 待複習
        </p>
      )}
      <div className="new-deck">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="新牌組名稱"
          onKeyDown={(e) => { if (e.key === 'Enter') void addDeck() }} />
        <button className="btn" disabled={adding} onClick={() => void addDeck()}>建立</button>
      </div>
    </div>
  )
}
