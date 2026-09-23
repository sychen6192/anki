import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { PitchAccent } from '../components/PitchAccent'
import { isSpeechSupported, readAutoSpeak, speak, writeAutoSpeak } from '../lib/speak'
import { SpeakerIcon } from '../components/SpeakerIcon'
import {
  ArchiveIcon, CheckIcon, CloseIcon, MoreIcon, PencilIcon, SkipIcon, UndoIcon,
} from '../components/icons'
import { Loading } from '../components/Loading'
import { ActionSheet, Sheet } from '../components/Sheet'
import { db } from '../db/db'
import { sortDecks } from '../lib/deckOrder'
import {
  applyReview, restoreCardsSuspended, setNoteSuspended, StaleCardError, undoReview, updateNote, type SuspendedSnapshot,
} from '../db/repo'
import { applyFsrsSettings, formatInterval, previewIntervals, rate, State, type RatingValue } from '../lib/fsrs'
import { getFsrsSettings } from '../lib/fsrsSettings'
import { isValidAccent, normalizeAccent } from '../lib/accent'
import {
  buildMultiDeckQueue, countKind, deckQueue, newOverLimit, splitCounts, startOfToday, type QueueCounts,
} from '../lib/queue'
import { reviewKeyAction, type KeyTarget } from '../lib/reviewKeys'
import { requestSync } from '../lib/sync'
import type { CardRecord, DeckRecord, NoteRecord } from '../../shared/types'
import './review.css'

const RATING_LABELS: Record<RatingValue, string> = { 1: '重來', 2: '困難', 3: '普通', 4: '簡單' }

/** 可以復原的動作:評分(刪 log、還原排程)、已經會了/先不學(把卡片狀態寫回去)、跳過(放回佇列) */
type UndoEntry =
  | { kind: 'rate'; card: CardRecord; logId: string }
  | { kind: 'suspend'; cardId: string; prev: SuspendedSnapshot[] }
  | { kind: 'skip'; cardId: string }
/** 這次複習能連續復原幾步 */
const UNDO_LIMIT = 20
/** 學習中的卡片若在這段時間內到期,停在完成畫面等它,時間到自動接回去複習 */
const AUTO_RESUME_WINDOW = 10 * 60 * 1000
/**
 * 到期卡與新卡都做完了,20 分鐘內會到期的學習中卡片直接提前拿來複習(Anki 預設同樣是 20 分鐘),
 * 不必停在完成畫面乾等。
 */
const LEARN_AHEAD = 20 * 60 * 1000
/** 複習中評分後多久同步一次(期間再評分就重新計時) */
const SYNC_DELAY_MS = 15_000

/** 翻面或換卡後這段時間內的點擊不算:「顯示答案」和評分鍵在同一個位置,連點會誤評分 */
const TAP_GUARD_MS = 350

/** 字數給 CSS 算字級(--n):依卡片的寬度把整個字放進一行,放不下才換行(review.css 的 .expression) */
function charCount(text: string): CSSProperties {
  return { '--n': Array.from(text).length } as CSSProperties
}

/** 卡上大字的行高與字重分級(字級本身依寬度算,見 charCount):正反面共用,翻面也不會跳 */
function sizeClass(text: string): string {
  const n = Array.from(text).length
  if (n <= 6) return ''
  if (n <= 9) return ' size-md'
  if (n <= 13) return ' size-sm'
  return ' size-xs'
}

interface EditState { noteId: string; expression: string; reading: string; meaning: string; accent: string }

/** 翻面後的答案(給讀螢幕唸):正向卡是讀音與意思,反向卡是日文單字與讀音 */
function answerText(card: CardRecord, note: NoteRecord): string {
  const parts = card.direction === 'reverse' ? [note.expression, note.reading] : [note.reading, note.meaning]
  return parts.filter((p) => p !== '').join('，')
}

/**
 * 按鍵落在哪種元素上(規則見 reviewKeys.ts 的 KeyTarget)。keyboardNav:最近一次是用 Tab 在畫面上移動
 * (而不是滑鼠或手指點的)。點過留著焦點的按鈕不算「移到按鈕上」—— 點完 ↶ 再按空白鍵應該是翻面、
 * 點完 🔊 再按空白鍵應該是評分;用滑鼠開「⋯」再按 Esc 關掉,焦點回到「⋯」也一樣。
 * 不看 :focus-visible:Chromium 在按下任何鍵的瞬間就會把目前的焦點標成 :focus-visible。
 */
function keyTarget(t: EventTarget | null, keyboardNav: boolean): KeyTarget {
  if (!(t instanceof HTMLElement)) return null
  if (t.isContentEditable || t.closest('input, textarea, select') !== null) return 'text'
  const control = t.closest('button, a[href], summary, [role="button"], [role="switch"], [role="radio"]')
  if (control === null) return null
  return keyboardNav ? 'control' : null
}

export default function Review() {
  const { deckId } = useParams()
  const navigate = useNavigate()
  // /review/all:所有牌組合成一次。到期卡跨牌組依 due 排,新卡各牌組照自己的每日上限
  const allMode = deckId === 'all'
  const [menuOpen, setMenuOpen] = useState(false)
  const [current, setCurrent] = useState<{ card: CardRecord; note: NoteRecord; deckName: string | null } | null>(null)
  const [sessionName, setSessionName] = useState<string | null>(null)
  const [showBack, setShowBack] = useState(false)
  // 剩下幾張,分新卡/學習中/待複習(和首頁的三色計數同一個算法)
  const [counts, setCounts] = useState<QueueCounts>({ news: 0, learn: 0, rev: 0 })
  const remaining = counts.news + counts.learn + counts.rev
  const [done, setDone] = useState(false)
  const [nextDue, setNextDue] = useState<number | null>(null)
  const [missing, setMissing] = useState(false)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  const lastAction = undoStack.length > 0 ? undoStack[undoStack.length - 1] : null
  const [tick, setTick] = useState(() => Date.now())
  const [doneStats, setDoneStats] = useState<{ count: number; correct: number } | null>(null)
  // 單副完成時,其他牌組還有幾張到期:完成畫面直接接「繼續複習其他牌組」
  const [othersDue, setOthersDue] = useState(0)
  // 動作後短暫出現的回饋(評了什麼、多久後再見;或已標為已會/先不學),可立即復原
  // undoable:這則回饋對應復原堆疊最上面那一步,才顯示「復原」(切換設定之類的只是告知)
  const [toast, setToast] = useState<{ text: string; undoable: boolean } | null>(null)
  const toastTimer = useRef(0)
  useEffect(() => () => clearTimeout(toastTimer.current), [])
  const showToast = useCallback((text: string, undoable = true) => {
    setToast({ text, undoable })
    setAnnouncement(text)
    clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4500)
  }, [])
  // 編輯綁定打開當下那張卡的 noteId:存檔只寫那一筆,不管畫面後來換到哪張
  const [editing, setEditing] = useState<EditState | null>(null)
  // 編輯面板自己的錯誤:不掛到複習畫面上,關掉面板就消失
  const [editErr, setEditErr] = useState<string | null>(null)
  const answering = useRef(false)
  // 這次 session 裡跳過的卡片。只存在記憶體,離開複習畫面就重來 —— 跳過是
  // 「現在不想看」,不是 Anki 的 bury,不該寫進資料庫影響排程。
  const skipped = useRef(new Set<string>())
  // 進度條用:記住這次 session 見過的最大待複習數。按「重來」會讓待複習數
  // 回升,取最大值當分母,進度條就不會倒退。
  const [sessionMax, setSessionMax] = useState(0)
  // 「再學 N 張新卡」:今日額度用完後自願加碼。只存在記憶體,離開頁面歸零,
  // 不動牌組設定 —— 明天的額度照舊。
  const bonusNew = useRef(0)
  // 要加碼一輪:下一次 loadNext 拿到今天的紀錄時才算得出要加多少(見 newOverLimit)。
  // 牌組頁「今天完成 · 再學一點」帶 ?more=1:一進來就加碼一輪新卡,不必先經過完成畫面
  const [searchParams] = useSearchParams()
  const wantMore = useRef(searchParams.get('more') === '1')
  const [moreNew, setMoreNew] = useState(0)
  const newPerDayRef = useRef(20)
  // 防連點:上一次換卡、翻面的時間
  const shownAt = useRef(0)
  const flippedAt = useRef(0)
  // 讀螢幕:翻面、評分的結果寫進常駐的 live region(剛插入的 role=status 在 iOS VoiceOver 常常不唸)
  const [announcement, setAnnouncement] = useState('')
  // 剛開始用的人(複習紀錄還很少):評分鍵上方提醒一句。「困難」其實算答對,想不起來卻按它,
  // 那個字會隔更久才出現
  const [newbie, setNewbie] = useState(false)
  useEffect(() => { void db.review_logs.count().then((n) => setNewbie(n < 30)) }, [])
  const wordRef = useRef<HTMLParagraphElement>(null)
  const answerRef = useRef<HTMLDivElement>(null)
  const doneRef = useRef<HTMLHeadingElement>(null)
  // 最近一次是用 Tab 移動焦點(true),還是用滑鼠/手指點的(false),見 keyTarget
  const keyboardNav = useRef(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Tab') keyboardNav.current = true }
    const onPointer = () => { keyboardNav.current = false }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPointer, true)
    }
  }, [])

  const pushUndo = useCallback((entry: UndoEntry) => {
    setUndoStack((s) => [...s.slice(-(UNDO_LIMIT - 1)), entry])
  }, [])

  /** preferCardId:復原時用,讓剛還原的那張卡直接回到眼前,而不是排到佇列尾端 */
  const loadNext = useCallback(async (preferCardId?: string) => {
    let decks: DeckRecord[]
    if (allMode) {
      // 依名稱排:跨牌組時新卡照這個順序一副一副出,不是照隨機 id
      decks = sortDecks(await db.decks.filter((d) => !d.deleted).toArray())
    } else {
      const deck = await db.decks.get(deckId!)
      decks = deck !== undefined && !deck.deleted ? [deck] : []
    }
    if (decks.length === 0) { setMissing(true); return }
    setSessionName(allMode ? '全部牌組' : decks[0].name)
    // 每張卡載入前都重新套一次:設定頁改了目標保持率、或同步拉到別台裝置最佳化的參數,
    // 下一張卡的按鈕與排程就用新的,不必離開複習畫面
    applyFsrsSettings(await getFsrsSettings())
    const liveDeckIds = new Set(decks.map((d) => d.id))
    const cards = allMode
      ? (await db.cards.toArray()).filter((c) => liveDeckIds.has(c.deck_id))
      : await db.cards.where('deck_id').equals(deckId!).toArray()
    const logs = await db.review_logs.where('reviewed_at').aboveOrEqual(startOfToday()).toArray()
    // 「再學 N 張」的單位:單副是它的每日上限;全部時取最大的那副
    newPerDayRef.current = Math.max(...decks.map((d) => d.new_per_day))
    if (wantMore.current) {
      wantMore.current = false
      // 從今天已經超出上限的量往上加:今天之前加碼學過的,不能把這次的份抵掉
      const unit = newPerDayRef.current > 0 ? newPerDayRef.current : 20
      bonusNew.current = Math.max(bonusNew.current, newOverLimit(decks, cards, logs)) + unit
    }
    // 單副:加碼直接加在額度上;全部:各牌組各自的額度,加碼另計(跨牌組共 N 張)
    const built = allMode
      ? buildMultiDeckQueue(decks, cards, logs, Date.now(), bonusNew.current)
      : deckQueue(deckId!, decks[0].new_per_day + bonusNew.current, cards, logs)
    const nextLearningDue = built.nextLearningDue
    let queue = built.queue.filter((c) => !skipped.current.has(c.id))
    // 「跳過,等一下再看」:其他的都做完了,跳過的還沒做的就回來(排在最後)
    if (queue.length === 0 && built.queue.length > 0) {
      skipped.current.clear()
      queue = built.queue
    }
    // 該做的都做完了:20 分鐘內會到期的學習中卡片提前拿來,不讓人在完成畫面乾等
    if (queue.length === 0) {
      const horizon = Date.now() + LEARN_AHEAD
      queue = cards
        .filter((c) => !c.deleted && !c.suspended && !skipped.current.has(c.id)
          && (c.state === State.Learning || c.state === State.Relearning) && c.due <= horizon)
        .sort((a, b) => a.due - b.due)
    }
    // 復原時優先回到那張卡。它可能已不在佇列裡 —— undoReview 會推進 updated_at
    // (LWW 傳播用),新卡按 updated_at 排序就會把它擠出每日上限的切片 ——
    // 這種情況直接把卡撈回來顯示,不然「復原上一張」會跳到別張卡。
    const preferred = preferCardId
      ? queue.find((c) => c.id === preferCardId)
        ?? cards.find((c) => c.id === preferCardId && !c.deleted)
      : undefined
    if (queue.length === 0 && preferred === undefined) {
      // 完成畫面的今日成績:這副牌組今天複習幾張、一次就答對的比例
      const cardIds = new Set(cards.map((c) => c.id))
      const deckLogs = logs.filter((l) => cardIds.has(l.card_id))
      setDoneStats({ count: deckLogs.length, correct: deckLogs.filter((l) => l.rating > 1).length })
      // 額度用完但牌組裡還有新卡 → 完成畫面給「再學一點」的選項
      setMoreNew(cards.filter(
        (c) => !c.deleted && !c.suspended && c.state === State.New && !skipped.current.has(c.id),
      ).length)
      // 單副做完:看看其他牌組還有沒有到期的,完成畫面可以直接接下去
      if (!allMode) {
        const others = await db.decks.filter((d) => !d.deleted && d.id !== deckId).toArray()
        if (others.length > 0) {
          const otherIds = new Set(others.map((d) => d.id))
          const otherCards = (await db.cards.toArray()).filter((c) => otherIds.has(c.deck_id))
          setOthersDue(buildMultiDeckQueue(others, otherCards, logs).queue.length)
        } else setOthersDue(0)
      }
      setCurrent(null)
      setDone(true)
      setNextDue(nextLearningDue)
      setTick(Date.now())
      // 做完了也不立刻推:完成畫面上還能「復原上一次評分」
      requestSync(SYNC_DELAY_MS)
      return
    }
    const card = preferred ?? queue[0]
    const inQueue = queue.some((c) => c.id === card.id)
    const note = await db.notes.get(card.note_id)
    if (!note) {
      setErrMsg('卡片資料缺失')
      setCurrent(null)
      setDone(true)
      return
    }
    setCurrent({ card, note, deckName: allMode ? decks.find((d) => d.id === card.deck_id)?.name ?? null : null })
    const pending = inQueue ? queue : [card, ...queue]
    setCounts(splitCounts(pending))
    setSessionMax((m) => Math.max(m, pending.length))
    setShowBack(false)
    setDone(false)
    setNextDue(null)
    shownAt.current = performance.now()
    window.scrollTo(0, 0)
  }, [deckId, allMode])

  // 換到另一個複習(例如完成後按「繼續複習其他牌組」,同一個畫面換網址):這一輪的進度、
  // 加碼、跳過都從頭算,不然進度條一開始就是 80%、上一副的加碼也會帶過來。復原紀錄保留。
  const sessionDeck = useRef(deckId)
  useEffect(() => {
    if (sessionDeck.current === deckId) return
    sessionDeck.current = deckId
    bonusNew.current = 0
    skipped.current.clear()
    setSessionMax(0)
    setDoneStats(null)
  }, [deckId])

  useEffect(() => { void loadNext() }, [loadNext])

  const flip = useCallback((fromPointer = false) => {
    // 評完一張、下一張剛出現時的第二下點擊,不該直接翻開下一張
    if (fromPointer && performance.now() - shownAt.current < TAP_GUARD_MS) return
    if (!showBack) {
      flippedAt.current = performance.now()
      if (current !== null) setAnnouncement(answerText(current.card, current.note))
    }
    setShowBack(true)
  }, [showBack, current])

  // 焦點跟著卡片走:翻面到答案、換卡到新的字、做完到完成標題。「顯示答案」換成評分鍵時
  // 焦點才不會掉回頁首,讀螢幕也會唸出新內容。選單或編輯面板開著時不搶它們的焦點。
  const cardId = current?.card.id
  useEffect(() => {
    if (menuOpen || editing !== null) return
    if (done) { doneRef.current?.focus({ preventScroll: true }); return }
    if (cardId === undefined) return
    const el = showBack ? answerRef.current : wordRef.current
    el?.focus({ preventScroll: true })
    // 只在換卡、翻面、做完時移動(menuOpen/editing 故意不列):選單關掉時由對話框把焦點還給「⋯」
  }, [cardId, showBack, done])

  // 同步拉到別台對這張卡的改動(那邊複習過、標成已會、刪掉):畫面上的是舊資料,直接換下一張。
  // 自己的評分、復原也會改到這張卡,那段期間 answering 為 true,做完時畫面上已經是新的那份
  const liveCard = useLiveQuery(() => (cardId === undefined ? undefined : db.cards.get(cardId)), [cardId])
  useEffect(() => {
    if (liveCard === undefined || current === null || liveCard.id !== current.card.id) return
    if (answering.current || liveCard.updated_at === current.card.updated_at) return
    answering.current = true
    showToast(`「${current.note.expression}」在其他裝置更新過了，換下一張`, false)
    void loadNext().finally(() => { answering.current = false })
    // 只在這張卡的資料變了時檢查
  }, [liveCard]) // eslint-disable-line react-hooks/exhaustive-deps

  const answer = useCallback(async (rating: RatingValue, fromPointer = false) => {
    if (!current || answering.current) return
    // 「顯示答案」剛按下去,同一個位置冒出來的評分鍵要擋掉連點
    if (fromPointer && performance.now() - flippedAt.current < TAP_GUARD_MS) return
    answering.current = true
    const answered = current.card
    const word = current.note.expression
    try {
      const { fields, log } = rate(answered, rating)
      const logId = await applyReview(answered, fields, log)
      // 評分已儲存成功,先清掉舊錯誤——loadNext 若失敗是另一回事,不代表評分沒存到。
      setErrMsg(null)
      pushUndo({ kind: 'rate', card: answered, logId })
      // 每評一張就排一次同步(15 秒內連續評分會合併成一次):中途被打斷、改到另一台接著背,
      // 才不會又看到同一批卡,兩邊的排程也不會互相蓋掉。不立刻推:評完馬上按「復原」時,
      // 那筆紀錄多半還沒上傳 —— 上傳後就收不回來,別台會多算一次。切到背景時會補推(sync.ts)
      requestSync(SYNC_DELAY_MS)
      // 顯示實際排進去的間隔,不是再算一次的預覽
      showToast(`「${word}」${RATING_LABELS[rating]} · ${formatInterval(fields.due - log.reviewed_at)}後`)
      try {
        await loadNext()
      } catch {
        // 評分已寫入,但下一張沒載到。清掉畫面上這張已作答的卡,
        // 否則評分按鈕還掛著舊狀態,再按一次會用過期資料重複評分。
        setCurrent(null)
        setDone(true)
        setErrMsg('載入下一張失敗，請回列表重新進入')
      }
    } catch (e) {
      if (e instanceof StaleCardError) {
        // 畫面上這張在別台複習過(同步拉下來了):沒有評分,換成資料庫裡現在的佇列
        showToast(`「${word}」在其他裝置更新過了，換下一張`, false)
        await loadNext().catch(() => {})
      } else {
        setErrMsg(`評分未儲存：${e instanceof Error ? e.message : String(e)}`)
      }
    } finally {
      answering.current = false
    }
  }, [current, loadNext, showToast, pushUndo])

  const skip = useCallback(async () => {
    if (!current || answering.current) return
    skipped.current.add(current.card.id)
    pushUndo({ kind: 'skip', cardId: current.card.id })
    showToast(`已跳過「${current.note.expression}」`)
    await loadNext()
  }, [current, loadNext, showToast, pushUndo])

  /**
   * 已經會了(2)/ 先不學(1):整個字的正反兩張卡一起退出佇列,不評分、不寫 review_log。
   * 跟「跳過」不同,這是寫進資料庫、會同步的。存下改動前的值,按「復原」能精確寫回去。
   */
  const markSuspended = useCallback(async (value: 1 | 2) => {
    if (!current || answering.current) return
    answering.current = true
    const word = current.note.expression
    try {
      const prev = await setNoteSuspended(current.note.id, value)
      setErrMsg(null)
      pushUndo({ kind: 'suspend', cardId: current.card.id, prev })
      requestSync(SYNC_DELAY_MS)
      showToast(value === 2 ? `「${word}」已標為會了，不會再出現` : `「${word}」先不學了，牌組頁的「先不學」可以恢復`)
      await loadNext()
    } catch (e) {
      setErrMsg(`標記失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      answering.current = false
    }
  }, [current, loadNext, showToast, pushUndo])

  const openEdit = useCallback(() => {
    if (current === null) return
    setEditErr(null)
    const n = current.note
    setEditing({ noteId: n.id, expression: n.expression, reading: n.reading, meaning: n.meaning, accent: n.accent })
  }, [current])

  const saveEdit = useCallback(async () => {
    if (!editing || answering.current) return
    answering.current = true
    try {
      // 只改文字,不動「反向卡」—— 複習到一半增刪卡片會讓當下的佇列對不上
      const { noteId, ...fields } = editing
      if (!fields.expression.trim() || !fields.meaning.trim()) {
        setEditErr('單字與意思為必填')
        return
      }
      const accent = normalizeAccent(fields.accent)
      if (!isValidAccent(accent)) {
        setEditErr('重音格式錯誤（只能是數字，多重音用逗號分隔，如 0 或 0,3）')
        return
      }
      await updateNote(noteId, { ...fields, accent })
      const fresh = await db.notes.get(noteId)
      if (fresh) setCurrent((c) => (c !== null && c.note.id === noteId ? { ...c, note: fresh } : c))
      setEditing(null)
      setEditErr(null)
    } catch (e) {
      setEditErr(`儲存失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      answering.current = false
    }
  }, [editing])

  const undo = useCallback(async () => {
    const entry = undoStack[undoStack.length - 1]
    if (entry === undefined || answering.current) return
    answering.current = true
    try {
      if (entry.kind === 'rate') await undoReview(entry.card, entry.logId)
      else if (entry.kind === 'suspend') await restoreCardsSuspended(entry.prev)
      else skipped.current.delete(entry.cardId)
      if (entry.kind !== 'skip') requestSync(SYNC_DELAY_MS)
      setUndoStack((s) => s.slice(0, -1))
      setToast(null)
      setErrMsg(null)
      await loadNext(entry.kind === 'rate' ? entry.card.id : entry.cardId)
    } catch (e) {
      setErrMsg(`復原失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      answering.current = false
    }
  }, [undoStack, loadNext])

  /** 離開複習:從 App 裡點進來的就回上一頁(保留捲動與分頁),直接開網址的回牌組 */
  const exit = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate('/', { replace: true })
  }, [navigate])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 選單開著時鍵盤交給選單(Esc 關閉由 dialog 處理),不能在背後翻面或評分
      if (menuOpen) return
      // 按住不放時系統會一直重送同一個鍵:按住空白鍵會「翻面、普通、翻面、普通…」一路刷過去
      if (e.repeat) return
      // 鍵 → 動作的對照表在 reviewKeys.ts(含「帶 Cmd/Ctrl/Alt 不接」的規則),這裡只負責執行
      const action = reviewKeyAction(e, {
        editing: editing !== null, showBack, done, target: keyTarget(e.target, keyboardNav.current),
      })
      if (action === null) return
      switch (action.type) {
        case 'exit': e.preventDefault(); exit(); break
        case 'show': e.preventDefault(); flip(); break
        case 'edit': e.preventDefault(); openEdit(); break
        case 'skip': e.preventDefault(); void skip(); break
        case 'undo': e.preventDefault(); void undo(); break
        case 'known': e.preventDefault(); void markSuspended(2); break
        case 'rate': e.preventDefault(); void answer(action.rating); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showBack, answer, editing, skip, undo, markSuspended, openEdit, menuOpen, exit, flip, done])

  // 翻面自動唸讀音(和設定頁是同一個開關;複習中也能從「⋯」切換)
  const [autoSpeak, setAutoSpeak] = useState(() => readAutoSpeak())
  const autoSpeakRef = useRef(autoSpeak)
  autoSpeakRef.current = autoSpeak
  const toggleAutoSpeak = useCallback(() => {
    const next = !autoSpeakRef.current
    setAutoSpeak(next)
    writeAutoSpeak(next)
    showToast(next ? '翻面時會自動唸讀音' : '已關閉自動唸讀音', false)
  }, [showToast])
  useEffect(() => {
    // 只在翻面(或換卡)時唸;切換開關本身不觸發
    if (showBack && current !== null && autoSpeakRef.current && isSpeechSupported()) {
      speak(current.note.reading || current.note.expression)
    }
  }, [showBack, current])

  // 完成畫面上的等待時間:平常每分鐘更新(「約 X後到期」不會越放越不準),最後 10 分鐘每秒倒數,到期後停
  useEffect(() => {
    if (!done || nextDue === null) return
    let id = 0
    const step = () => {
      const now = Date.now()
      setTick(now)
      const left = nextDue - now
      if (left <= 0) return
      id = window.setTimeout(step, left > AUTO_RESUME_WINDOW ? Math.min(60_000, left - AUTO_RESUME_WINDOW) : 1000)
    }
    step()
    return () => clearTimeout(id)
  }, [done, nextDue])

  // 完成畫面停在背景一陣子再回來:學習中的卡可能已經到期了,重新看一次佇列
  useEffect(() => {
    if (!done) return
    const onVisible = () => { if (document.visibilityState === 'visible') void loadNext() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [done, loadNext])

  // 時間到自動接回複習(完成畫面一直開著也會)。每個 nextDue 只排一次,萬一還是載不到卡也不會空轉。
  useEffect(() => {
    if (!done || nextDue === null) return
    // setTimeout 超過 2^31-1 毫秒會立刻觸發;學習中的卡不會等那麼久,保險起見夾住
    const id = setTimeout(() => { void loadNext() }, Math.min(2 ** 31 - 1, Math.max(0, nextDue - Date.now()) + 200))
    return () => clearTimeout(id)
  }, [done, nextDue, loadNext])

  if (missing) {
    return (
      <div className="review-done">
        <h1>{allMode ? '還沒有牌組' : '找不到這個牌組'}</h1>
        <Link to="/" className="btn lg">回牌組</Link>
      </div>
    )
  }
  if (done) {
    const waitMs = nextDue === null ? null : nextDue - tick
    const moreCount = Math.min(newPerDayRef.current > 0 ? newPerDayRef.current : 20, moreNew)
    return (
      <div className="review-done">
        <p className="visually-hidden" aria-live="polite">{announcement}</p>
        <span className="done-badge"><CheckIcon size={38} /></span>
        <h1 ref={doneRef} tabIndex={-1}>{allMode || sessionName === null ? '今天完成了' : `「${sessionName}」完成了`}</h1>
        {doneStats !== null && doneStats.count > 0 && (
          <p className="done-stats">
            今天複習 <b>{doneStats.count}</b> 次 · 答對率 <b>{Math.round((doneStats.correct / doneStats.count) * 100)}%</b>
          </p>
        )}
        {errMsg && <p className="err" role="alert">{errMsg}</p>}
        {waitMs !== null && (waitMs > AUTO_RESUME_WINDOW ? (
          <p className="done-wait">還有學習中的卡片，約 {formatInterval(waitMs)}後到期</p>
        ) : (
          // 每秒更新的倒數不當 live region:讀螢幕會被一直打斷
          <p className="done-wait">
            還有學習中的卡片，{waitMs > 0 ? `${Math.ceil(waitMs / 1000)} 秒後自動繼續` : '正在繼續…'}
          </p>
        ))}
        <div className="btn-stack">
          {!allMode && othersDue > 0 && (
            <Link to="/review/all" replace className="btn lg">繼續複習其他牌組 · {othersDue}</Link>
          )}
          {moreNew > 0 && (
            <button className="btn lg tinted" onClick={() => {
              wantMore.current = true
              void loadNext()
            }}>
              再學 {moreCount} 張新卡
              {moreNew > moreCount && <span className="btn-note">還有 {moreNew} 張</span>}
            </button>
          )}
          <button className={!allMode && othersDue > 0 ? 'btn lg secondary' : 'btn lg'} onClick={exit}>完成</button>
          {lastAction && (
            <button className="btn plain" onClick={() => void undo()}>
              <UndoIcon size={16} />{lastAction.kind === 'rate' ? '復原上一次評分' : '復原上一個動作'}
            </button>
          )}
        </div>
      </div>
    )
  }
  if (!current) return <Loading />

  const { card, note } = current
  const reverse = card.direction === 'reverse'
  const preview = previewIntervals(card)
  const progress = sessionMax > 0 ? Math.round(((sessionMax - remaining) / sessionMax) * 100) : 0

  // 正向卡:單字從頭到尾固定在同一個位置,答案先佔好位置(看不見),翻面時只淡入答案
  // 讀音和單字一樣(ビザ、どうぞ這類假名的字)又沒有重音可畫,就不再印一次
  const showReading = note.reading !== '' && (note.reading !== note.expression || note.accent !== '')
  const answerBlock = (
    <div ref={answerRef} tabIndex={-1} aria-label="答案" className={`card-answer${showBack ? '' : ' concealed'}`} aria-hidden={!showBack}>
      {(showReading || isSpeechSupported()) && (
        <div className="reading-row">
          {showReading && <PitchAccent reading={note.reading} accent={note.accent} />}
          {isSpeechSupported() && (
            <button
              className="speak-btn"
              aria-label="播放發音"
              tabIndex={showBack ? 0 : -1}
              onClick={(e) => { e.stopPropagation(); speak(note.reading || note.expression) }}
            ><SpeakerIcon size={20} /></button>
          )}
        </div>
      )}
      <div className="card-divider" />
      <p className="meaning">{note.meaning}</p>
    </div>
  )

  return (
    <div className={`review-screen${newbie ? ' with-hint' : ''}`}>
      <p className="visually-hidden" aria-live="polite">{announcement}</p>
      <header className="review-bar">
        <button className="icon-btn" aria-label="結束複習" title="結束複習（Esc）" onClick={exit}><CloseIcon /></button>
        <div className="review-progress" role="progressbar" aria-label="這次的進度"
          aria-valuemin={0} aria-valuemax={sessionMax} aria-valuenow={sessionMax - remaining}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <span className="review-remaining" role="img"
          aria-label={`剩 ${remaining} 張：新卡 ${counts.news}、學習中 ${counts.learn}、待複習 ${counts.rev}`}>
          剩 <b>{remaining}</b>
        </span>
        <button className="icon-btn" aria-label="復原上一步" disabled={lastAction === null}
          onClick={() => void undo()} title="復原上一步（U）"><UndoIcon size={21} /></button>
        <button className="icon-btn" aria-label="更多動作" aria-haspopup="dialog"
          onClick={() => setMenuOpen(true)}><MoreIcon /></button>
      </header>

      {errMsg && <p className="err review-err" role="alert">{errMsg}</p>}

      <div className={`flashcard${showBack ? ' flipped' : ''}`} onClick={() => flip(true)}>
        {current.deckName !== null && <span className="card-deck">{current.deckName}</span>}
        {/* 第一次見到的字標出來:想不起來是正常的,別被嚇到 */}
        {countKind(card) === 'news' && <span className="card-tag">新卡</span>}
        {reverse && !showBack ? (
          // 反向卡的正面是中文意思:提示要想的是日文
          <div className="card-face" key={`${card.id}-front`}>
            <span className="card-prompt">中 → 日</span>
            <p ref={wordRef} tabIndex={-1} className={`expression prompt-text${sizeClass(note.meaning)}`}
              style={charCount(note.meaning)}>{note.meaning}</p>
            <p className="card-hint">日文怎麼說？</p>
          </div>
        ) : (
          <div className="card-face" key={card.id}>
            <p ref={showBack ? undefined : wordRef} tabIndex={-1} className={`expression${sizeClass(note.expression)}`} lang="ja"
              style={charCount(note.expression)}>
              {note.expression}
            </p>
            {answerBlock}
          </div>
        )}
      </div>

      <div className="review-actions">
        {!showBack ? (
          <button className="btn lg show-answer" onClick={() => flip(true)}>
            顯示答案<span className="kbd-hint">空白鍵</span>
          </button>
        ) : (
          <>
          {newbie && <p className="rating-hint">想不起來就按「重來」；只要想起來了，都算答對</p>}
          <div className="ratings">
            {([1, 2, 3, 4] as const).map((r) => (
              <button key={r} className={`rating rating-${r}`} aria-label={`${RATING_LABELS[r]}，${preview[r]}後`}
                onClick={() => void answer(r, true)}>
                <span className="rating-label">{RATING_LABELS[r]}</span>
                <span className="rating-interval">{preview[r]}</span>
                <span className="kbd-hint rating-key">{r}</span>
              </button>
            ))}
          </div>
          </>
        )}
      </div>

      {toast !== null && (!toast.undoable || lastAction !== null) && (
        // 不當 live region:同一句已經寫進上面常駐的 aria-live,兩邊都唸會唸兩次
        <div className="toast review-toast">
          <span>{toast.text}</span>
          {toast.undoable && <button className="link" onClick={() => void undo()}>復原</button>}
        </div>
      )}

      <ActionSheet open={menuOpen} onClose={() => setMenuOpen(false)} actions={[
        { label: '編輯這張', icon: <PencilIcon size={20} />, onSelect: openEdit },
        { label: '跳過，等一下再看', icon: <SkipIcon size={20} />, onSelect: () => void skip() },
        { label: '已經會了，不用再出現', icon: <CheckIcon size={20} />, onSelect: () => void markSuspended(2) },
        { label: '先不學這個字', icon: <ArchiveIcon size={20} />, onSelect: () => void markSuspended(1) },
        ...(isSpeechSupported() ? [{
          label: autoSpeak ? '關閉自動唸讀音' : '翻面時自動唸讀音', icon: <SpeakerIcon size={20} />, onSelect: toggleAutoSpeak,
        }] : []),
      ]} />

      <Sheet open={editing !== null} onClose={() => { setEditing(null); setEditErr(null) }} title="編輯卡片" full
        dirty={editing !== null && (editing.expression !== note.expression || editing.reading !== note.reading
          || editing.meaning !== note.meaning || editing.accent !== note.accent)}
        end={<button className="btn plain strong" onClick={() => void saveEdit()}>儲存</button>}>
        {editing !== null && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void saveEdit() }}>
            {!showBack && <p className="hint">打開編輯就會看到答案，這張等一下建議按「重來」。</p>}
            <label className="field"><span className="field-label">單字</span>
              <input value={editing.expression} lang="ja"
                onChange={(e) => setEditing({ ...editing, expression: e.target.value })} />
            </label>
            <label className="field"><span className="field-label">讀音</span>
              <input value={editing.reading} lang="ja"
                onChange={(e) => setEditing({ ...editing, reading: e.target.value })} />
            </label>
            <label className="field"><span className="field-label">意思</span>
              <input value={editing.meaning}
                onChange={(e) => setEditing({ ...editing, meaning: e.target.value })} />
            </label>
            <label className="field"><span className="field-label">重音</span>
              <input value={editing.accent} placeholder="例如 0 或 0,3" autoCapitalize="off" autoCorrect="off"
                onChange={(e) => setEditing({ ...editing, accent: e.target.value })} />
            </label>
            {editErr && <p className="err" role="alert">{editErr}</p>}
            {/* 讓鍵盤的「前往」也能送出 */}
            <button type="submit" hidden />
          </form>
        )}
      </Sheet>
    </div>
  )
}
