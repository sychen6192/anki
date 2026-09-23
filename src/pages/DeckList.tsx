import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import type { CardRecord } from '../../shared/types'
import { db } from '../db/db'
import { createDeck } from '../db/repo'
import { deckQueue, startOfToday } from '../lib/queue'
import { State } from '../lib/fsrs'
import { streakDays } from '../lib/stats'
import { adoptSyncSpace, generateSyncKey, getSyncSpace, setSyncSpace } from '../lib/space'
import { syncNow } from '../lib/sync'
import { useBusy } from '../lib/useBusy'
import { Loading } from '../components/Loading'
import { PageHeader } from '../components/PageHeader'
import { ActionSheet, Sheet } from '../components/Sheet'
import { useConfirm } from '../components/Confirm'
import { ListSection, useToast } from '../components/controls'
import {
  CheckIcon, DecksIcon, FileIcon, FlameIcon, LayersIcon, LinkIcon, NewDeckIcon, PlayIcon, PlusIcon, UploadIcon,
} from '../components/icons'
import './home.css'

const KEY_HINT_DISMISSED = 'key-hint-dismissed'

/**
 * 首次啟動:先選資料要不要跨裝置同步。沒金鑰時 syncNow 一律跳過(純本機),
 * 所以「先只存這台」只是把選擇記下來讓這張卡消失;產生金鑰那條才要立刻推上去。
 */
function Welcome({ onKeyGenerated }: { onKeyGenerated: (key: string) => void }) {
  const [busy, run] = useBusy()
  const confirm = useConfirm()

  const generate = () => run(async () => {
    const key = generateSyncKey()
    await setSyncSpace(key)
    // 先通知父層顯示金鑰:meta 一寫入,父層條件就會把這個元件卸載
    onKeyGenerated(key)
    await syncNow()
  })
  const stayLocal = () => run(async () => {
    const ok = await confirm({
      title: '只存在這台裝置?',
      message: '換手機或清掉瀏覽器資料,牌組和進度就沒了。之後隨時能在設定頁補設金鑰。',
      confirmLabel: '只存這台',
    })
    if (ok) await setSyncSpace('')
  })

  return (
    <section className="welcome card">
      <img className="welcome-icon" src="/icon.svg" alt="" width={64} height={64} />
      <h2>歡迎使用字卡</h2>
      <p>要在手機、電腦之間同步進度嗎?同步用一組金鑰當你的私人空間,不用註冊帳號。</p>
      <div className="btn-stack">
        <button className="btn lg" disabled={busy} onClick={() => void generate()}>產生同步金鑰(推薦)</button>
        <Link to="/settings" className="btn lg secondary">我已經有金鑰</Link>
        <button className="btn plain" disabled={busy} onClick={() => void stayLocal()}>先只存在這台裝置</button>
      </div>
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
      <p>換手機或在電腦上用時要輸入它,先抄下來或複製存好。設定頁隨時查得到。</p>
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
    <Sheet open={open} onClose={() => { setName(''); onClose() }} title="新增牌組"
      end={<button className="btn plain strong" disabled={adding || !name.trim()} onClick={() => void submit()}>建立</button>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <label className="field">
          <span className="field-label">牌組名稱</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如:N3 單字" autoFocus
            enterKeyHint="done" />
        </label>
        <p className="hint">建好之後可以一張一張加卡片,也可以從「+」匯入 CSV 或 Anki 牌組。</p>
      </form>
    </Sheet>
  )
}

export default function DeckList() {
  const navigate = useNavigate()
  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray(), [])
  const cards = useLiveQuery(() => db.cards.toArray(), [])
  const todayLogs = useLiveQuery(
    () => db.review_logs.where('reviewed_at').aboveOrEqual(startOfToday()).toArray(), [],
  )
  // 連續天數只要時間戳:直接讀索引,不必把整筆紀錄撈出來
  const stamps = useLiveQuery(() => db.review_logs.orderBy('reviewed_at').keys(), [])
  const space = useLiveQuery(() => getSyncSpace(), [])
  // 'unset' = meta 沒有 sync_space 列(從沒選過金鑰);loading 期間是 undefined
  const spaceChosen = useLiveQuery(
    async () => (await db.meta.get('sync_space')) === undefined ? 'unset' : 'set', [],
  )
  const syncError = useLiveQuery(() => db.meta.get('sync_error'), [])
  const [keyHintDismissed, setKeyHintDismissed] = useState(
    () => localStorage.getItem(KEY_HINT_DISMISSED) === '1',
  )
  const [newKey, setNewKey] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [newDeckOpen, setNewDeckOpen] = useState(false)
  const [retrying, runRetry] = useBusy()
  const [enabling, runEnable] = useBusy()
  const toast = useToast()

  if (!decks || !cards || !todayLogs || !stamps) return <Loading />

  const liveCards = cards.filter((c) => !c.deleted)
  const queues = new Map(decks.map((d) => [d.id, deckQueue(d.id, d.new_per_day, cards, todayLogs).queue]))
  const wordCount = new Map<string, number>()
  const seenNotes = new Set<string>()
  for (const c of liveCards) {
    if (seenNotes.has(c.note_id)) continue
    seenNotes.add(c.note_id)
    wordCount.set(c.deck_id, (wordCount.get(c.deck_id) ?? 0) + 1)
  }
  const split = (queue: CardRecord[]) => {
    const news = queue.filter((c) => c.state === State.New).length
    const learn = queue.filter((c) => c.state === State.Learning || c.state === State.Relearning).length
    return { news, learn, rev: queue.length - news - learn }
  }
  const all = [...queues.values()].flat()
  const total = split(all)
  const totalDue = all.length
  const streak = streakDays(stamps as number[], startOfToday())
  // 只有一副牌組時直接進那副;好幾副才用「全部一起」
  const reviewAllTo = decks.length === 1 ? `/review/${decks[0].id}` : '/review/all'

  const onboarding = newKey === null && spaceChosen === 'unset' && decks.length === 0
  const showKeyHint = !onboarding && newKey === null && space === '' && !keyHintDismissed

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
      {onboarding && <Welcome onKeyGenerated={setNewKey} />}

      {decks.length > 0 && (
        <section className="today card" aria-label="今天">
          <div className="today-top">
            <div className="today-main">
              <span className="today-label">今天</span>
              {totalDue > 0 ? (
                <p className="today-headline"><b className="num">{totalDue}</b> 張要複習</p>
              ) : (
                <p className="today-headline done"><CheckIcon size={22} />
                  {todayLogs.length > 0 ? '今天都複習完了' : '今天沒有到期的卡'}</p>
              )}
            </div>
            {streak > 0 && (
              <span className="streak" aria-label={`連續 ${streak} 天`}><FlameIcon size={15} />{streak} 天</span>
            )}
          </div>
          {totalDue > 0 && (
            <div className="counts-inline">
              <span className="count"><span className="dot new" />新卡 <b>{total.news}</b></span>
              <span className="count"><span className="dot learn" />學習中 <b>{total.learn}</b></span>
              <span className="count"><span className="dot due" />待複習 <b>{total.rev}</b></span>
            </div>
          )}
          {todayLogs.length > 0 && <p className="today-sub">今天已複習 {todayLogs.length} 張</p>}
          {totalDue > 0 && (
            <Link to={reviewAllTo} className="btn lg today-cta"><PlayIcon size={14} />開始複習</Link>
          )}
        </section>
      )}

      {syncError !== undefined && (
        <div className="notice error" role="alert">
          <span className="notice-text">同步失敗:{String(syncError.value)}</span>
          <span className="notice-actions">
            <button className="link" disabled={retrying} onClick={() => void runRetry(async () => {
              const r = await syncNow() // 成功會清掉 sync_error meta,這條橫幅跟著消失
              if (r.ok) toast.show('同步完成')
            })}>{retrying ? '同步中…' : '重試'}</button>
          </span>
        </div>
      )}
      {showKeyHint && (
        <div className="notice">
          <span className="notice-text">資料只存在這台裝置,沒有備份。開啟同步後會上傳到你的私人空間。</span>
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
            const c = split(queue)
            const words = wordCount.get(deck.id) ?? 0
            return (
              <div key={deck.id} className="row deck-row">
                <Link to={`/deck/${deck.id}`} className="deck-link">
                  <span className="row-title deck-name">{deck.name}</span>
                  <span className="row-subtitle deck-meta">
                    {queue.length === 0 ? (
                      <span className="deck-done">今天完成</span>
                    ) : (
                      <>
                        {c.rev > 0 && <span className="count"><span className="dot due" />{c.rev} 待複習</span>}
                        {c.learn > 0 && <span className="count"><span className="dot learn" />{c.learn} 學習中</span>}
                        {c.news > 0 && <span className="count"><span className="dot new" />{c.news} 新卡</span>}
                      </>
                    )}
                    <span className="deck-words">{words} 字</span>
                  </span>
                </Link>
                {queue.length > 0 ? (
                  <Link to={`/review/${deck.id}`} className="btn sm tinted deck-review"
                    aria-label={`複習「${deck.name}」,${queue.length} 張`}>
                    <PlayIcon size={10} />{queue.length}
                  </Link>
                ) : (
                  <span className="deck-check" aria-label="今天完成"><CheckIcon size={18} /></span>
                )}
              </div>
            )
          })}
        </ListSection>
      ) : !onboarding && newKey === null && (
        <div className="empty-state">
          <span className="empty-icon"><DecksIcon size={30} /></span>
          <h2>還沒有牌組</h2>
          <p>從範本開始最快;也可以匯入自己的單字表,或建一副空白的慢慢加。</p>
          <div className="btn-stack">
            <Link to="/import?mode=templates" className="btn lg">從範本開始</Link>
            <button className="btn lg secondary" onClick={() => setMenuOpen(true)}>匯入或新增…</button>
          </div>
          <Link to="/guide" className="link">第一次用?看使用說明</Link>
        </div>
      )}

      <ActionSheet open={menuOpen} onClose={() => setMenuOpen(false)} actions={addActions} />
      <NewDeckSheet open={newDeckOpen} onClose={() => setNewDeckOpen(false)} />
      {toast.node}
    </>
  )
}
