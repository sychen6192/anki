import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { createDeck } from '../db/repo'
import { buildQueue, startOfToday } from '../lib/queue'
import { State } from '../lib/fsrs'

export default function DeckList() {
  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray(), [])
  const cards = useLiveQuery(() => db.cards.toArray(), [])
  const todayLogs = useLiveQuery(
    () => db.review_logs.where('reviewed_at').aboveOrEqual(startOfToday()).toArray(), [],
  )
  const [name, setName] = useState('')

  if (!decks || !cards || !todayLogs) return null

  const addDeck = async () => {
    if (!name.trim()) return
    await createDeck(name)
    setName('')
  }

  return (
    <div>
      <h1>牌組</h1>
      <ul className="deck-list">
        {decks.map((deck) => {
          const deckCards = cards.filter((c) => c.deck_id === deck.id)
          const ids = new Set(deckCards.map((c) => c.id))
          const logs = todayLogs.filter((l) => ids.has(l.card_id))
          const { queue } = buildQueue(deckCards, logs, deck.new_per_day)
          const news = queue.filter((c) => c.state === State.New).length
          const learn = queue.filter((c) => c.state === State.Learning || c.state === State.Relearning).length
          const rev = queue.length - news - learn
          return (
            <li key={deck.id} className="deck-row">
              <Link to={`/deck/${deck.id}`} className="deck-name">{deck.name}</Link>
              <span className="counts">
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
      <div className="new-deck">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="新牌組名稱"
          onKeyDown={(e) => e.key === 'Enter' && addDeck()} />
        <button className="btn" onClick={addDeck}>建立</button>
      </div>
    </div>
  )
}
