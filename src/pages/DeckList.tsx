import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { createDeck } from '../db/repo'
import { deckQueue, startOfToday } from '../lib/queue'
import { State } from '../lib/fsrs'
import { generateSyncKey, getSyncSpace, setSyncSpace } from '../lib/space'
import { syncNow } from '../lib/sync'
import { useBusy } from '../lib/useBusy'
import { Loading } from '../components/Loading'

const KEY_HINT_DISMISSED = 'key-hint-dismissed'

/**
 * 首次啟動的金鑰選擇。沒金鑰時 syncNow 一律跳過(純本機),所以「先不同步」
 * 只是把選擇記下來讓這張卡消失,不需要補同步;產生金鑰那條才要立刻推上去。
 */
function Onboarding({ onKeyGenerated }: { onKeyGenerated: (key: string) => void }) {
  const [busy, run] = useBusy()

  const generate = () => run(async () => {
    const key = generateSyncKey()
    await setSyncSpace(key)
    // 先通知父層顯示金鑰:meta 一寫入,父層條件就會把這個元件卸載
    onKeyGenerated(key)
    await syncNow()
  })
  const stayLocal = () => run(async () => {
    if (!confirm('不設金鑰的話資料只留在這台裝置,換手機或清掉瀏覽器資料就沒了。之後隨時能在設定頁補上。確定?')) return
    await setSyncSpace('')
  })

  return (
    <div className="notice onboard">
      <p><b>第一次使用</b> —— 設一組同步金鑰,進度才能跨裝置帶著走:</p>
      <div className="form-actions">
        <button className="btn" disabled={busy} onClick={() => void generate()}>產生我的金鑰(推薦)</button>
        <Link to="/settings" className="btn secondary">我有金鑰,去輸入</Link>
        <button className="link" disabled={busy} onClick={() => void stayLocal()}>先不同步,只存這台</button>
      </div>
    </div>
  )
}

export default function DeckList() {
  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray(), [])
  const cards = useLiveQuery(() => db.cards.toArray(), [])
  const todayLogs = useLiveQuery(
    () => db.review_logs.where('reviewed_at').aboveOrEqual(startOfToday()).toArray(), [],
  )
  const space = useLiveQuery(() => getSyncSpace(), [])
  // 'unset' = meta 沒有 sync_space 列(從沒選過金鑰);loading 期間是 undefined
  const spaceChosen = useLiveQuery(
    async () => (await db.meta.get('sync_space')) === undefined ? 'unset' : 'set', [],
  )
  const syncError = useLiveQuery(() => db.meta.get('sync_error'), [])
  const [keyHintDismissed, setKeyHintDismissed] = useState(
    () => localStorage.getItem(KEY_HINT_DISMISSED) === '1',
  )
  const [name, setName] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const [adding, runAdd] = useBusy()
  const [retrying, runRetry] = useBusy()

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
        <div className="today-row">
          <p className="today-line">
            {totalDue > 0
              ? <>還有 <b>{totalDue}</b> 張到期</>
              : todayLogs.length > 0 ? '今天清空了 🎉' : '今天沒有到期的卡'}
            {todayLogs.length > 0 && <> · 已複習 <b>{todayLogs.length}</b> 張</>}
          </p>
          {/* 兩副以上才有意義;沒東西可看時不放一顆點了只會看到完成畫面的按鈕 */}
          {decks.length > 1 && totalDue > 0 && (
            <Link to="/review/all" className="btn">全部一起複習</Link>
          )}
        </div>
      )}
      {/* 全新安裝(沒選過金鑰、也還沒有資料)先選空間;本機已有資料的舊安裝走下面的橫幅 */}
      {newKey !== null ? (
        <div className="notice onboard" role="status">
          <p>✓ 已建立你的同步金鑰:<b className="key-code">{newKey}</b></p>
          <p className="hint">換手機或多裝置同步時要用,先抄下來。設定頁隨時查得到。</p>
          <button className="link" onClick={() => setNewKey(null)}>知道了</button>
        </div>
      ) : spaceChosen === 'unset' && decks.length === 0 && <Onboarding onKeyGenerated={setNewKey} />}
      {syncError !== undefined && (
        <p className="notice sync-error">
          <span>上次同步失敗:{String(syncError.value)}</span>
          <button className="link" disabled={retrying} onClick={() => void runRetry(async () => {
            await syncNow() // 成功會清掉 sync_error meta,這條橫幅跟著消失
          })}>{retrying ? '同步中…' : '重試'}</button>
        </p>
      )}
      {!(spaceChosen === 'unset' && decks.length === 0) && space === '' && !keyHintDismissed && (
        <p className="notice">
          <span>還沒設同步金鑰,資料只存在這台裝置,沒有備份到雲端。</span>
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
