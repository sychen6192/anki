import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { sortDecks } from '../lib/deckOrder'
import { createDeck } from '../db/repo'
import { deckQueue, splitCounts, startOfToday } from '../lib/queue'
import { nextLearningDue, useNow } from '../lib/useNow'
import { streakDays } from '../lib/stats'
import { adoptSyncSpace, generateSyncKey, getSyncSpace } from '../lib/space'
import { humanizeSyncError, syncMessage } from '../lib/syncText'
import { isStandaloneApp, isTouchDevice, storageSeparateFromApp } from '../lib/share'
import { syncNow } from '../lib/sync'
import { useBusy } from '../lib/useBusy'
import { Loading } from '../components/Loading'
import { PageHeader } from '../components/PageHeader'
import { ActionSheet, Sheet } from '../components/Sheet'
import { JoinSpaceSheet } from '../components/JoinSpaceSheet'
import { ListSection, useToast } from '../components/controls'
import {
  CheckIcon, DecksIcon, FileIcon, FlameIcon, LayersIcon, LinkIcon, NewDeckIcon, PlayIcon, PlusIcon, UploadIcon,
} from '../components/icons'
import './home.css'

const KEY_HINT_DISMISSED = 'key-hint-dismissed'

/** 在瀏覽器裡開(不是主畫面的 App),而且這個瀏覽器的資料和裝好的 App 分開存(iPhone、Mac Safari…) */
function inSeparateBrowser(): boolean {
  if (typeof navigator === 'undefined' || isStandaloneApp()) return false
  return storageSeparateFromApp(navigator.userAgent, navigator.maxTouchPoints ?? 0, isTouchDevice())
}

/**
 * 第一次打開(還沒有牌組、也沒開同步):先讓人開始背。同步等背過一輪再問
 * (首頁的「開啟同步」提示),開啟時這台的資料會整份帶上去,晚點開不會少東西。
 * 在別台用過的人,從最下面那行直接輸入金鑰。
 */
function Welcome({ onImport, onJoin, inBrowser }: { onImport: () => void; onJoin: () => void; inBrowser: boolean }) {
  return (
    <section className="welcome card">
      <img className="welcome-icon" src="/icon.svg" alt="" width={64} height={64} />
      <h2>歡迎使用字卡</h2>
      <p>挑一份單字範本就能開始背，每天只會出一小批新字。</p>
      {inBrowser && (
        // 瀏覽器和裝好的 App 各存各的:先在這裡背,之後裝到主畫面會發現 App 裡是空的
        <p className="welcome-install">
          <b>打算天天用？</b>先把這頁加到主畫面（iPhone：分享 →「加入主畫面」；Mac：加入 Dock），
          從那裡打開再開始。在瀏覽器裡建立的牌組，裝好的 App 看不到。
        </p>
      )}
      <div className="btn-stack">
        <Link to="/import?mode=templates" className="btn lg">從範本開始</Link>
        <button className="btn lg secondary" onClick={onImport}>匯入自己的單字…</button>
      </div>
      <button className="btn plain welcome-join" onClick={onJoin}>在別台用過字卡？輸入同步金鑰</button>
    </section>
  )
}

/** 剛產生的金鑰:先抄下來,換裝置要用 */
function KeyCreated({ keyValue, onDone }: { keyValue: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <section className="welcome card" role="status">
      <span className="welcome-check"><CheckIcon size={30} /></span>
      <h2>同步金鑰建好了</h2>
      <p>換手機或在電腦上用時要輸入它，先抄下來或複製存好。設定頁隨時查得到。</p>
      <div className="key-box">
        <code className="key-code">{keyValue}</code>
        <button className="btn sm tinted" onClick={() => {
          void navigator.clipboard?.writeText(keyValue).then(() => setCopied(true), () => {})
        }}>{copied ? '已複製' : '複製'}</button>
      </div>
      <button className="btn lg" onClick={onDone}>開始使用</button>
    </section>
  )
}

/** 新增牌組:名稱填好就進到那副牌組,馬上可以加卡片 */
function NewDeckSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('')
  const [adding, run] = useBusy()
  const navigate = useNavigate()
  const submit = () => run(async () => {
    if (!name.trim()) return
    const deck = await createDeck(name)
    setName('')
    onClose()
    navigate(`/deck/${deck.id}`)
  })
  return (
    <Sheet open={open} onClose={() => { setName(''); onClose() }} title="新增牌組" dirty={name.trim() !== ''}
      end={<button className="btn plain strong" disabled={adding || !name.trim()} onClick={() => void submit()}>建立</button>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <label className="field">
          <span className="field-label">牌組名稱</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：N3 單字" data-autofocus
            enterKeyHint="done" />
        </label>
        <p className="hint">建好之後可以一張一張加卡片，也可以從「+」匯入 CSV 或 Anki 牌組。</p>
      </form>
    </Sheet>
  )
}

export default function DeckList() {
  const navigate = useNavigate()
  // 「現在」:回到前景、跨日、學習中的卡到期時重算,首頁的數字才不會停在昨天
  const [wakeAt, setWakeAt] = useState<number | null>(null)
  const now = useNow(wakeAt)
  const dayStart = startOfToday(now)
  const decks = useLiveQuery(async () => sortDecks(await db.decks.filter((d) => !d.deleted).toArray()), [])
  const cards = useLiveQuery(() => db.cards.toArray(), [])
  useEffect(() => { setWakeAt(nextLearningDue(cards, now)) }, [cards, now])
  const todayLogs = useLiveQuery(
    () => db.review_logs.where('reviewed_at').aboveOrEqual(dayStart).toArray(), [dayStart],
  )
  // 連續天數只要時間戳:直接讀索引,不必把整筆紀錄撈出來
  const stamps = useLiveQuery(() => db.review_logs.orderBy('reviewed_at').keys(), [])
  const space = useLiveQuery(() => getSyncSpace(), [])
  const syncError = useLiveQuery(() => db.meta.get('sync_error'), [])
  const lastSyncAt = useLiveQuery(() => db.meta.get('last_sync_at'), [])
  const [keyHintDismissed, setKeyHintDismissed] = useState(
    () => localStorage.getItem(KEY_HINT_DISMISSED) === '1',
  )
  const [newKey, setNewKey] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [newDeckOpen, setNewDeckOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)
  const [inBrowser] = useState(inSeparateBrowser)
  const [retrying, runRetry] = useBusy()
  const [enabling, runEnable] = useBusy()
  const toast = useToast()

  if (!decks || !cards || !todayLogs || !stamps || space === undefined) return <Loading />

  const liveCards = cards.filter((c) => !c.deleted)
  const queues = new Map(decks.map((d) => [d.id, deckQueue(d.id, d.new_per_day, cards, todayLogs, now).queue]))
  const wordCount = new Map<string, number>()
  const seenNotes = new Set<string>()
  for (const c of liveCards) {
    if (seenNotes.has(c.note_id)) continue
    seenNotes.add(c.note_id)
    wordCount.set(c.deck_id, (wordCount.get(c.deck_id) ?? 0) + 1)
  }
  const all = [...queues.values()].flat()
  const total = splitCounts(all)
  const totalDue = all.length
  const streak = streakDays(stamps as number[], dayStart)
  // 只有一副牌組時直接進那副;好幾副才用「全部一起」
  const reviewAllTo = decks.length === 1 ? `/review/${decks[0].id}` : '/review/all'

  const totalWords = [...wordCount.values()].reduce((a, b) => a + b, 0)
  // 同步的提示等真的背過(有複習紀錄)再出現:第一次打開就問金鑰只會擋路。
  // 在瀏覽器裡(資料和裝好的 App 分開存)就早點提醒,不然之後裝到主畫面會以為資料不見了
  const showKeyHint = newKey === null && space === '' && !keyHintDismissed && decks.length > 0
    && (stamps.length > 0 || inBrowser)
  // 偶爾一次同步失敗(捷運、電梯)不必嚇人:導覽列的小紅點就夠。超過一天沒同步成功才在首頁提醒
  const lastOk = typeof lastSyncAt?.value === 'number' ? lastSyncAt.value : 0
  const showSyncProblem = syncError !== undefined && space !== '' && now - lastOk > 24 * 3600_000

  const addActions = [
    { label: '新增牌組', icon: <NewDeckIcon />, onSelect: () => setNewDeckOpen(true) },
    { label: '從範本加入', icon: <LayersIcon />, onSelect: () => navigate('/import?mode=templates') },
    { label: '匯入 CSV', icon: <FileIcon />, onSelect: () => navigate('/import?mode=csv') },
    { label: '匯入 Anki 牌組', icon: <UploadIcon />, onSelect: () => navigate('/import?mode=apkg') },
    { label: '貼上分享連結', icon: <LinkIcon />, onSelect: () => navigate('/import?mode=share') },
  ]

  return (
    <>
      <PageHeader title="牌組" actions={
        <button className="icon-btn" aria-label="新增牌組或匯入" onClick={() => setMenuOpen(true)}><PlusIcon /></button>
      } />

      {newKey !== null && <KeyCreated keyValue={newKey} onDone={() => setNewKey(null)} />}

      {decks.length > 0 && totalWords === 0 && (
        <section className="today card" aria-label="今天">
          <span className="today-label">今天</span>
          <p className="today-headline small">先幫「{decks[0].name}」加幾個字</p>
          <div className="btn-row">
            <Link to={`/deck/${decks[0].id}`} className="btn">加卡片</Link>
            <Link to="/import?mode=templates" className="btn secondary">從範本開始</Link>
          </div>
        </section>
      )}
      {decks.length > 0 && totalWords > 0 && (
        <section className="today card" aria-label="今天">
          <div className="today-top">
            <div className="today-main">
              <span className="today-label">今天</span>
              {totalDue > 0 ? (
                <p className="today-headline">還有 <b className="num">{totalDue}</b> 張</p>
              ) : (
                <p className="today-headline done"><CheckIcon size={22} />
                  {todayLogs.length > 0 ? '今天完成了' : '今天沒有要複習的卡'}</p>
              )}
            </div>
            {streak > 0 && (
              <span className="streak" role="img" aria-label={`連續 ${streak} 天`}><FlameIcon size={15} />{streak} 天</span>
            )}
          </div>
          {totalDue > 0 && (
            <div className="counts-inline">
              <span className={`count${total.news === 0 ? ' zero' : ''}`}><span className="dot new" />新卡 <b>{total.news}</b></span>
              <span className={`count${total.learn === 0 ? ' zero' : ''}`}><span className="dot learn" />學習中 <b>{total.learn}</b></span>
              <span className={`count${total.rev === 0 ? ' zero' : ''}`}><span className="dot due" />待複習 <b>{total.rev}</b></span>
            </div>
          )}
          {todayLogs.length > 0 && <p className="today-sub">今天已複習 {todayLogs.length} 次</p>}
          {totalDue > 0 && (
            <Link to={reviewAllTo} className="btn lg today-cta"><PlayIcon size={14} />開始複習</Link>
          )}
        </section>
      )}

      {showSyncProblem && (
        <div className="notice" role="status">
          <span className="notice-text">超過一天沒同步成功：{humanizeSyncError(String(syncError.value))}</span>
          <span className="notice-actions">
            <button className="link" disabled={retrying} onClick={() => void runRetry(async () => {
              const r = await syncNow() // 成功會清掉 sync_error meta,這條橫幅跟著消失
              // 還是失敗(或離線)也要有回應,不然會以為沒按到、一直按
              toast.show(syncMessage(r, '同步完成'))
            })}>{retrying ? '同步中…' : '重試'}</button>
          </span>
        </div>
      )}
      {showKeyHint && (
        <div className="notice">
          <span className="notice-text">{inBrowser
            ? '這些牌組只存在這個瀏覽器，加到主畫面的 App 看不到。先開啟同步，App 裡輸入同一組金鑰就能接上。'
            : '資料只存在這台裝置，沒有備份。開啟同步後會上傳到你的私人空間。'}</span>
          <span className="notice-actions">
            <button className="link" disabled={enabling} onClick={() => void runEnable(async () => {
              // 純本機開始同步:本機資料整份帶過去(adoptSyncSpace 不清本機)
              const key = generateSyncKey()
              await adoptSyncSpace(key)
              setNewKey(key)
              await syncNow()
            })}>{enabling ? '開啟中…' : '開啟同步'}</button>
            <button className="link" onClick={() => {
              localStorage.setItem(KEY_HINT_DISMISSED, '1')
              setKeyHintDismissed(true)
            }}>略過</button>
          </span>
        </div>
      )}

      {decks.length > 0 ? (
        <ListSection header="我的牌組" className="deck-section">
          {decks.map((deck) => {
            const queue = queues.get(deck.id)!
            const c = splitCounts(queue)
            const words = wordCount.get(deck.id) ?? 0
            return (
              <div key={deck.id} className="row deck-row">
                <Link to={`/deck/${deck.id}`} className="deck-link">
                  <span className="row-title deck-name">{deck.name}</span>
                  <span className="row-subtitle deck-meta">
                    {words === 0 ? (
                      <span className="deck-done">還沒有卡片</span>
                    ) : queue.length === 0 ? (
                      <span className="deck-done">今天完成了</span>
                    ) : (
                      <>
                        {/* 和今天卡片同一個順序與寫法:新卡 → 學習中 → 待複習 */}
                        {c.news > 0 && <span className="count"><span className="dot new" />新卡 {c.news}</span>}
                        {c.learn > 0 && <span className="count"><span className="dot learn" />學習中 {c.learn}</span>}
                        {c.rev > 0 && <span className="count"><span className="dot due" />待複習 {c.rev}</span>}
                      </>
                    )}
                    {words > 0 && <span className="deck-words">{words} 個字</span>}
                  </span>
                </Link>
                {queue.length > 0 ? (
                  <Link to={`/review/${deck.id}`} className="btn sm tinted deck-review"
                    aria-label={`複習「${deck.name}」，${queue.length} 張`}>
                    <PlayIcon size={10} />{queue.length}
                  </Link>
                ) : words > 0 && (
                  <span className="deck-check" role="img" aria-label="今天完成了"><CheckIcon size={18} /></span>
                )}
              </div>
            )
          })}
        </ListSection>
      ) : newKey === null && space === '' ? (
        <Welcome onImport={() => setMenuOpen(true)} onJoin={() => setJoinOpen(true)} inBrowser={inBrowser} />
      ) : newKey === null && (
        <div className="empty-state">
          <span className="empty-icon"><DecksIcon size={30} /></span>
          <h2>還沒有牌組</h2>
          <p>從範本開始最快；也可以匯入自己的單字表，或建一副空白的慢慢加。</p>
          <div className="btn-stack">
            <Link to="/import?mode=templates" className="btn lg">從範本開始</Link>
            <button className="btn lg secondary" onClick={() => setMenuOpen(true)}>匯入或新增…</button>
          </div>
          <Link to="/guide" className="link">第一次用？看使用說明</Link>
        </div>
      )}

      <ActionSheet open={menuOpen} onClose={() => setMenuOpen(false)} actions={addActions} />
      <NewDeckSheet open={newDeckOpen} onClose={() => setNewDeckOpen(false)} />
      <JoinSpaceSheet open={joinOpen} onClose={() => setJoinOpen(false)}
        onJoined={(message) => { setJoinOpen(false); toast.show(message) }} />
      {toast.node}
    </>
  )
}
