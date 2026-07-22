import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { createDeck } from '../db/repo'
import { deckQueue, startOfToday } from '../lib/queue'
import { State } from '../lib/fsrs'
import { getSyncSpace } from '../lib/space'
import { useBusy } from '../lib/useBusy'
import { Loading } from '../components/Loading'

const KEY_HINT_DISMISSED = 'key-hint-dismissed'

export default function DeckList() {
  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray(), [])
  const cards = useLiveQuery(() => db.cards.toArray(), [])
  const todayLogs = useLiveQuery(
    () => db.review_logs.where('reviewed_at').aboveOrEqual(startOfToday()).toArray(), [],
  )
  const space = useLiveQuery(() => getSyncSpace(), [])
  const [keyHintDismissed, setKeyHintDismissed] = useState(
    () => localStorage.getItem(KEY_HINT_DISMISSED) === '1',
  )
  const [name, setName] = useState('')
  const [adding, runAdd] = useBusy()

  const addDeck = () => runAdd(async () => {
    if (!name.trim()) return
    await createDeck(name)
    setName('')
  })

  if (!decks || !cards || !todayLogs) return <Loading />

  const queues = new Map(decks.map((d) => [d.id, deckQueue(d.id, d.new_per_day, cards, todayLogs).queue]))
  const totalDue = [...queues.values()].reduce((s, q) => s + q.length, 0)

  return (
    <div>
      <h1>牌組</h1>
      {decks.length > 0 && (
        <p className="today-line">
          {totalDue > 0
            ? <>還有 <b>{totalDue}</b> 張到期</>
            : todayLogs.length > 0 ? '今天清空了 🎉' : '今天沒有到期的卡'}
          {todayLogs.length > 0 && <> · 已複習 <b>{todayLogs.length}</b> 張</>}
        </p>
      )}
      {space === '' && !keyHintDismissed && (
        <p className="notice">
          <span>還沒設同步金鑰,正在跟別人共用預設空間。</span>
          <Link to="/settings" className="link">前往設定</Link>
          <button className="link" onClick={() => {
            localStorage.setItem(KEY_HINT_DISMISSED, '1')
            setKeyHintDismissed(true)
          }}>知道了</button>
        </p>
      )}
      <ul className="deck-list">
        {decks.map((deck) => {
          const queue = queues.get(deck.id)!
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
        {decks.length === 0 && (
          <li className="empty">
            還沒有牌組。從<Link to="/import?mode=templates" className="link">範本</Link>挑一份,
            或在下面自己建;<br />第一次用先看<Link to="/guide" className="link">說明</Link>。
          </li>
        )}
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
