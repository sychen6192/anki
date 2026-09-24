import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { errorText } from '../lib/syncText'
import { db } from '../db/db'
import { sortDecks } from '../lib/deckOrder'
import {
  createNote, enableReverseCards, moveNote, restoreCardsSuspended, restoreNote, setNotesSuspendedUndoable,
  softDeleteDeck, softDeleteNote, updateDeck, updateNote, type NoteInput,
} from '../db/repo'
import { exportCsv, findDuplicateNote } from '../lib/csv'
import { download } from '../lib/download'
import { fillMissingAccents, isValidAccent, lookupAccents, normalizeAccent } from '../lib/accent'
import { PitchAccent } from '../components/PitchAccent'
import { isSpeechSupported, speak } from '../lib/speak'
import { requestSync } from '../lib/sync'
import { createShare, isTouchDevice, shareUrlFor } from '../lib/share'
import { State } from '../lib/fsrs'
import { deckQueue, startOfToday } from '../lib/queue'
import { nextLearningDue, useNow } from '../lib/useNow'
import { useBusy } from '../lib/useBusy'
import { Loading } from '../components/Loading'
import { SpeakerIcon } from '../components/SpeakerIcon'
import { PageHeader } from '../components/PageHeader'
import { ActionSheet, Sheet } from '../components/Sheet'
import { useConfirm } from '../components/Confirm'
import { ListSection, Switch, useToast } from '../components/controls'
import {
  CheckIcon, ChevronRightIcon, DownloadIcon, MoreIcon, PlayIcon, PlusIcon, SearchIcon, SelectIcon, ShareIcon,
  SlidersIcon, SortIcon, SparklesIcon, TrashIcon, CloseIcon, FileIcon,
} from '../components/icons'
import type { CardSuspended, NoteRecord } from '../../shared/types'
import './deck.css'

const EMPTY: NoteInput = { expression: '', reading: '', meaning: '', reversed: false, accent: '' }
// 一次只掛這麼多列到 DOM;捲到底再長出下一批。整副 869 筆全部掛上去時,
// 光是清空搜尋就要重建近千個節點,在手機上看得出頓挫。
const PAGE_SIZE = 60

type SortKey = 'added-desc' | 'added-asc' | 'kana'
// 排序依 updated_at:編輯過的字會移到「最近改動」那一端,所以不叫「匯入順序」
const SORTS: readonly (readonly [SortKey, string])[] = [
  ['added-desc', '最近改動'],
  ['added-asc', '最早改動'],
  ['kana', '五十音'],
]
/** 批次一次改超過這麼多筆,先確認一次(「全選」會選到整副) */
const BATCH_CONFIRM_AT = 50

type NoteStatus = 'active' | 'paused' | 'known'
type CardLite = { state: number; due: number; suspended?: number }

/** 一筆 note 的狀態(彙總它的卡片):任一張已會 → 已會;任一張先不學 → 先不學;否則學習中 */
function noteStatus(cards: CardLite[] | undefined): NoteStatus {
  const s = Math.max(0, ...(cards ?? []).map((c) => c.suspended ?? 0))
  return s === 2 ? 'known' : s === 1 ? 'paused' : 'active'
}

/**
 * 一筆 note 的狀態小標(彙總它的正/反向卡):已會/先不學 > 待複習 > 學習中。
 * 新卡與排程中的不標 —— 範本牌組裡上千筆都是新卡,每列都掛一個「新」只是雜訊。
 */
function noteStateBadge(cards: CardLite[] | undefined, now: number) {
  if (!cards || cards.length === 0) return null
  const status = noteStatus(cards)
  if (status === 'known') return { label: '已會', cls: 'known' }
  if (status === 'paused') return { label: '先不學', cls: 'paused' }
  if (cards.some((c) => c.state !== State.New && c.due <= now)) return { label: '待複習', cls: 'due' }
  if (cards.some((c) => c.state === State.Learning || c.state === State.Relearning)) {
    return { label: '學習中', cls: 'learn' }
  }
  return null
}

// 連不上網路時講人話(不是瀏覽器的「Failed to fetch」)
const errText = errorText

export default function DeckDetail() {
  const { deckId } = useParams()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const toast = useToast()
  // 找不到(舊連結、清空重新下載之後按上一頁)是 null,和「還在讀」的 undefined 分開
  const deck = useLiveQuery(async () => (await db.decks.get(deckId!)) ?? null, [deckId])
  const notes = useLiveQuery(
    () => db.notes.where('deck_id').equals(deckId!).filter((n) => !n.deleted).toArray(), [deckId],
  )
  // 列表每行的狀態標籤要看卡片;搬移牌組的下拉要牌組列表
  const deckCards = useLiveQuery(
    () => db.cards.where('deck_id').equals(deckId!).filter((c) => !c.deleted).toArray(), [deckId],
  )
  const [wakeAt, setWakeAt] = useState<number | null>(null)
  const now = useNow(wakeAt)
  const dayStart = startOfToday(now)
  useEffect(() => { setWakeAt(nextLearningDue(deckCards, now)) }, [deckCards, now])
  const todayLogs = useLiveQuery(
    () => db.review_logs.where('reviewed_at').aboveOrEqual(dayStart).toArray(), [dayStart],
  )
  const allDecks = useLiveQuery(async () => sortDecks(await db.decks.filter((d) => !d.deleted).toArray()), [])
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortKey>('added-desc')
  const [status, setStatus] = useState<'all' | NoteStatus>('all')
  // 批次選取:勾多筆一起標成 已經會了 / 先不學 / 恢復學習(範本牌組裡早就會的字,一次清掉)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [editingId, setEditingId] = useState<string | null>(null) // 'new' = 新增模式
  const [form, setForm] = useState<NoteInput>(EMPTY)
  const [moveTo, setMoveTo] = useState<string | null>(null)
  const [addedLabel, setAddedLabel] = useState<string | null>(null)
  const [deckName, setDeckName] = useState<string | null>(null)
  const [newPerDay, setNewPerDay] = useState<number | null>(null)
  // 牌組設定面板裡的動作結果(為整副開啟反向卡)
  const [settingsNote, setSettingsNote] = useState<string | null>(null)
  const [busy, run] = useBusy()
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const sentinel = useRef<HTMLDivElement | null>(null)
  const firstField = useRef<HTMLInputElement | null>(null)
  const readingField = useRef<HTMLInputElement | null>(null)
  const meaningField = useRef<HTMLInputElement | null>(null)
  const accentField = useRef<HTMLInputElement | null>(null)
  const batchBar = useRef<HTMLDivElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 分享分兩步:先上傳拿到連結,再由使用者按「分享…」或「複製連結」。
  // 手機(尤其 iPhone)要求分享面板與寫剪貼簿必須由點擊直接觸發,中間先等上傳就會被擋
  const [shareOpen, setShareOpen] = useState(false)
  const [shareLink, setShareLink] = useState<string | null>(null)
  const shareInput = useRef<HTMLInputElement | null>(null)

  // 搜尋、排序或狀態篩選變了就從頭算起
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [search, sort, status])

  const cardsByNote = useMemo(() => {
    const m = new Map<string, CardLite[]>()
    for (const c of deckCards ?? []) {
      const list = m.get(c.note_id)
      if (list) list.push(c)
      else m.set(c.note_id, [c])
    }
    return m
  }, [deckCards])

  const sorted = useMemo(() => {
    if (!notes) return []
    const arr: NoteRecord[] = [...notes]
    if (sort === 'added-desc') arr.sort((a, b) => b.updated_at - a.updated_at)
    else if (sort === 'added-asc') arr.sort((a, b) => a.updated_at - b.updated_at)
    else arr.sort((a, b) => (a.reading || a.expression).localeCompare(b.reading || b.expression, 'ja'))
    return arr
  }, [notes, sort])

  // 捲到列表底部就再多顯示一批
  useEffect(() => {
    const el = sentinel.current
    if (el === null || typeof IntersectionObserver !== 'function') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisibleCount((n) => n + PAGE_SIZE)
    }, { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [notes, search])

  // 選取模式底部的動作列會依寬度與已選的數字換行,高度不固定:量出來給提示條讓位(deck.css 的 --batch-h)
  useEffect(() => {
    const bar = batchBar.current
    const page = bar?.closest<HTMLElement>('.page')
    if (!selecting || bar == null || page == null || typeof ResizeObserver !== 'function') return
    const measure = () => page.style.setProperty('--batch-h', `${bar.offsetHeight}px`)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(bar)
    return () => { ro.disconnect(); page.style.removeProperty('--batch-h') }
  }, [selecting])
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [looking, setLooking] = useState(false)
  // 每次查重音編一個號;換表單(新增完一個、打開別筆、關掉面板)就作廢還在路上的查詢
  const lookupSeq = useRef(0)
  // 第幾次分享;關掉分享面板就作廢還在上傳的那次
  const shareAttempt = useRef(0)
  // 失焦自動查重音的結果提示(查無時告訴人可以手動輸入)
  const [accentHint, setAccentHint] = useState('')
  // 重音格式錯誤:寫在重音欄正下方並捲進畫面(寫在表單最下面會被鍵盤蓋住,看起來像按了沒反應)
  const [accentErr, setAccentErr] = useState('')
  const accentErrRef = useRef<HTMLParagraphElement | null>(null)
  useEffect(() => {
    if (accentErr !== '') accentErrRef.current?.scrollIntoView({ block: 'nearest' })
  }, [accentErr])
  // 跑很久的工作(自動標註)進行中的訊息;結果用 toast
  const [progressMsg, setProgressMsg] = useState<string | null>(null)
  const [shareMsg, setShareMsg] = useState<string | null>(null)

  if (deck === undefined || !notes || !todayLogs) return <Loading />
  if (deck === null || deck.deleted) {
    // 這台根本沒有這副(換過金鑰後按上一頁、清空重新下載還沒下載完、從別台複製的網址)不等於被刪了
    const missing = deck === null
    return (
      <>
        <PageHeader title={missing ? '找不到這副牌組' : '牌組已刪除'} back={{ to: '/', label: '牌組' }} />
        <div className="empty-state">
          <p>{missing ? '這台沒有這副牌組：可能還沒同步過來，或在另一組同步金鑰的空間裡。' : '這副牌組已經刪除了。'}</p>
          <Link to="/" className="btn">回牌組</Link>
        </div>
      </>
    )
  }

  const matchesSearch = (n: NoteRecord) => search === '' || [n.expression, n.reading, n.meaning].some((s) => s.includes(search))
  const filtered = sorted.filter((n) =>
    matchesSearch(n) && (status === 'all' || noteStatus(cardsByNote.get(n.id)) === status))
  const shown = filtered.slice(0, visibleCount)
  const listNow = now
  const statusCounts = { known: 0, paused: 0 }
  for (const n of notes) {
    const st = noteStatus(cardsByNote.get(n.id))
    if (st !== 'active') statusCounts[st] += 1
  }
  const hasParked = statusCounts.known + statusCounts.paused > 0
  const queueCount = deckQueue(deck.id, deck.new_per_day, deckCards ?? [], todayLogs, now).queue.length
  const hasNewLeft = (deckCards ?? []).some((c) => !c.deleted && !c.suspended && c.state === State.New)

  const toggleSelected = (id: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const exitSelecting = () => { setSelecting(false); setSelected(new Set()) }

  const applyStatus = (value: CardSuspended) => run(async () => {
    const ids = [...selected].filter((id) => notes.some((n) => n.id === id))
    if (ids.length === 0) return
    const label = value === 2 ? '已經會了' : value === 1 ? '先不學' : '恢復學習'
    if (ids.length > BATCH_CONFIRM_AT && !await confirm({
      title: `把 ${ids.length} 個字標為「${label}」？`,
      message: value === 0 ? '這些字會回到複習裡。' : '這些字之後不會出現在複習裡，隨時可以在這裡恢復。',
      confirmLabel: label,
    })) return
    try {
      const prev = await setNotesSuspendedUndoable(ids, value)
      // 批次鈕在清掉選取後會停用,焦點會掉到頁首:放到「復原」上
      toast.show(`已把 ${ids.length} 個字標為「${label}」`, {
        label: '復原',
        onClick: () => void restoreCardsSuspended(prev).then(() => requestSync()),
      }, { focusAction: true })
      setSelected(new Set())
      setErrMsg(null)
      requestSync()
    } catch (e) {
      setErrMsg(`操作失敗：${errText(e)}`)
    }
  })

  /** 查字典補重音。quiet:讀音欄失焦時自動查,查無或離線只在欄位下方小字提示,不當成錯誤 */
  const lookupOne = async (quiet = false) => {
    if (!form.expression.trim()) { if (!quiet) setErrMsg('請先輸入單字'); return }
    // 查的是哪個字:結果回來時表單可能已經換成下一個字(連續新增、換編輯別筆),
    // 那時就不能填進去 —— 不然下一個字會帶著上一個字的重音存檔
    const q = { expression: form.expression.trim(), reading: form.reading.trim() }
    const seq = ++lookupSeq.current
    const stillSame = (f: NoteInput) => seq === lookupSeq.current
      && f.expression.trim() === q.expression && f.reading.trim() === q.reading
    setLooking(true)
    try {
      const [pitch] = await lookupAccents([q])
      if (seq !== lookupSeq.current) return
      if (pitch != null) {
        setForm((f) => (stillSame(f) && (f.accent.trim() === '' || !quiet) ? { ...f, accent: pitch } : f))
        setAccentHint('')
        setErrMsg(null)
      } else if (quiet) setAccentHint('字典查無，可以手動輸入')
      else setErrMsg('字典查無此字的重音')
    } catch (e) {
      if (!quiet && seq === lookupSeq.current) setErrMsg(`查詢失敗：${errText(e)}`)
    } finally {
      if (seq === lookupSeq.current) setLooking(false)
    }
  }
  const autoLookup = () => {
    if (form.accent.trim() !== '' || form.expression.trim() === '' || looking) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    void lookupOne(true)
  }

  const annotateDeck = () => run(async () => {
    const blanks = notes.filter((n) => !n.accent)
    if (blanks.length === 0) { toast.show('這副牌組沒有待標註的卡片'); return }
    setProgressMsg(`標註重音中…（${blanks.length} 個字）`)
    try {
      const { rows, filled, missed } = await fillMissingAccents(
        blanks.map((n) => ({ id: n.id, expression: n.expression, reading: n.reading, accent: n.accent ?? '' })),
      )
      // 幾百筆各開一個交易會慢到看得出來,包成一個交易寫回
      await db.transaction('rw', [db.notes, db.cards], async () => {
        for (const r of rows) {
          if (r.accent !== '') await updateNote(r.id, { accent: r.accent })
        }
      })
      toast.show(`補上 ${filled} 個字的重音${missed > 0 ? `（${missed} 個查不到）` : ''}`)
      setErrMsg(null)
      requestSync()
    } catch (e) {
      setErrMsg(`自動標註失敗：${errText(e)}`)
    } finally {
      setProgressMsg(null)
    }
  })

  // 在牌組設定面板裡按的:結果寫在面板裡(提示條會被面板蓋住),面板不關,剛改的名稱與上限也還在
  const bulkReverse = () => run(async () => {
    const missing = notes.filter((n) => n.reversed === 0).length
    if (missing === 0) { setSettingsNote('每個字都已經有反向卡了'); return }
    const ok = await confirm({
      title: `為 ${missing} 個字開啟反向卡？`,
      message: '反向卡是看意思想單字。新的反向卡從新卡開始排程。',
      confirmLabel: '開啟',
    })
    if (!ok) return
    try {
      const changed = await enableReverseCards(deck.id)
      setSettingsNote(`已為 ${changed} 個字開啟反向卡`)
      setErrMsg(null)
      requestSync()
    } catch (e) {
      setErrMsg(`開啟反向卡失敗：${errText(e)}`)
    }
  })

  const openNew = () => {
    lookupSeq.current++
    setEditingId('new'); setForm(EMPTY); setMoveTo(null); setAddedLabel(null); setErrMsg(null); setAccentHint(''); setAccentErr(''); setLooking(false)
  }
  const openEdit = (n: NoteRecord) => {
    lookupSeq.current++
    setLooking(false)
    setEditingId(n.id)
    setMoveTo(null)
    setAddedLabel(null)
    setErrMsg(null)
    setAccentHint('')
    setAccentErr('')
    setForm({ expression: n.expression, reading: n.reading, meaning: n.meaning, reversed: n.reversed === 1, accent: n.accent ?? '' })
  }
  /** 單字、讀音欄按 return 跳到下一欄,不是送出;日文輸入法選字時的 Enter 不算 */
  const nextOnEnter = (next: RefObject<HTMLInputElement | null>) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    next.current?.focus()
  }
  const closeNote = () => {
    lookupSeq.current++
    setEditingId(null); setForm(EMPTY); setMoveTo(null); setAddedLabel(null); setErrMsg(null); setAccentErr(''); setLooking(false)
  }

  const saveNote = () => run(async () => {
    if (!form.expression.trim() || !form.meaning.trim()) {
      setErrMsg('單字與意思為必填')
      ;(form.expression.trim() ? meaningField : firstField).current?.focus()
      return
    }
    // 「０、３」「0，3」這類手機上打出來的寫法先統一成「0,3」
    const accent = normalizeAccent(form.accent)
    if (accent !== form.accent) setForm((f) => ({ ...f, accent }))
    const input = { ...form, accent }
    if (!isValidAccent(accent)) {
      setAccentErr('重音格式錯誤：只能是數字，多重音用逗號分隔，例如 0 或 0,3')
      // 焦點留在重音欄(不跳去「單字」),錯誤寫在它正下方
      accentField.current?.focus()
      return
    }
    setAccentErr('')
    // 連續新增:在點下去的當下就把焦點放回「單字」欄。iOS 只有在使用者手勢裡 focus 才會留住鍵盤,
    // 等存完(await 之後)才 focus,每新增一張鍵盤就收起來一次
    if (editingId === 'new') firstField.current?.focus()
    try {
      // 同一副牌組裡「單字+讀音」相同就先問一聲(和匯入去重同一個判準);搬到別副時比對目標牌組
      const targetDeckId = editingId !== 'new' && moveTo !== null ? moveTo : deck.id
      const siblings = targetDeckId === deck.id
        ? notes
        : await db.notes.where('deck_id').equals(targetDeckId).toArray()
      // 編輯時只改意思或重音、也沒搬牌組,就不必再問:牌組裡本來就有的重複,不該每次存檔都跳出來
      const orig = editingId !== 'new' && editingId !== null ? notes.find((n) => n.id === editingId) : undefined
      const keyUnchanged = orig !== undefined && targetDeckId === deck.id
        && orig.expression.trim() === form.expression.trim() && orig.reading.trim() === form.reading.trim()
      const dup = keyUnchanged
        ? undefined
        : findDuplicateNote(siblings, form.expression, form.reading, editingId === 'new' ? undefined : editingId ?? undefined)
      if (dup !== undefined) {
        const label = dup.reading !== '' ? `${dup.expression}(${dup.reading})` : dup.expression
        const where = targetDeckId === deck.id ? '這副牌組' : '要搬去的牌組'
        const ok = await confirm({
          title: `${where}已經有「${label}」了`,
          message: `還要${editingId === 'new' ? '新增' : '儲存'}嗎？`,
          confirmLabel: editingId === 'new' ? '仍要新增' : '仍要儲存',
        })
        if (!ok) return
      }
      if (editingId === 'new') {
        await createNote(deck.id, input)
        // 新增完不關面板:一課的單字通常是一口氣輸入,清空後直接打下一個
        lookupSeq.current++
        setLooking(false)
        setAddedLabel(form.expression.trim())
        setForm({ ...EMPTY, reversed: form.reversed })
        setAccentHint('')
        setErrMsg(null)
        requestSync()
        firstField.current?.focus()
        return
      }
      if (editingId) {
        await updateNote(editingId, input)
        if (moveTo !== null && moveTo !== deck.id) {
          await moveNote(editingId, moveTo)
          const target = allDecks?.find((d) => d.id === moveTo)
          toast.show(`已把「${form.expression}」搬到「${target?.name ?? '另一副牌組'}」`)
        }
      }
      closeNote()
      requestSync()
    } catch (e) {
      setErrMsg(`操作失敗：${errText(e)}`)
    }
  })

  const saveDeck = () => run(async () => {
    try {
      const name = (deckName ?? deck.name).trim()
      if (name === '') {
        setErrMsg('牌組名稱不能是空的')
        return
      }
      const rawLimit = newPerDay ?? deck.new_per_day
      if (Number.isNaN(rawLimit)) {
        setErrMsg('請輸入每日新卡上限')
        return
      }
      const limit = Math.max(0, Math.floor(rawLimit))
      await updateDeck(deck.id, {
        name,
        new_per_day: limit,
      })
      setDeckName(null); setNewPerDay(null)
      setErrMsg(null)
      setSettingsOpen(false)
      toast.show('已儲存牌組設定')
      requestSync()
    } catch (e) {
      setErrMsg(`操作失敗：${errText(e)}`)
    }
  })

  // 系統分享面板只給觸控裝置:桌機的 navigator.share 也存在,但 macOS 的 popover 常沒人注意到
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function' && isTouchDevice()

  /** 第一步:上傳內容拿分享碼。桌機順手複製(剛點完的幾秒內瀏覽器允許),手機等使用者按「分享…」 */
  // 分享另外計:上傳可能很慢,不佔住整頁的 busy(不然編輯、批次的按鈕都會一直不能按)。
  // 面板關掉就放棄這次(shareAttempt 加一):結果回來時不再顯示,也不會事後把剪貼簿改掉
  const shareDeck = async () => {
    const attempt = ++shareAttempt.current
    const live = () => attempt === shareAttempt.current
    setShareLink(null)
    setShareOpen(true)
    try {
      setShareMsg(`上傳 ${notes.length} 個字…`)
      const code = await createShare(deck.name, notes.map((n) => ({
        expression: n.expression, reading: n.reading, meaning: n.meaning, accent: n.accent ?? '',
      })))
      if (!live()) return
      const url = shareUrlFor(location.origin, code)
      setShareLink(url)
      setErrMsg(null)
      if (canNativeShare) { setShareMsg('連結好了，按「分享…」傳給朋友'); return }
      try {
        await navigator.clipboard.writeText(url)
        if (live()) setShareMsg('已複製連結，貼給朋友就好')
      } catch {
        if (live()) setShareMsg('連結好了，按「複製連結」')
      }
    } catch (e) {
      if (live()) setShareMsg(`分享失敗：${errText(e)}`)
    }
  }

  const closeShare = () => { shareAttempt.current++; setShareOpen(false); setShareLink(null); setShareMsg(null) }

  /** 第二步(手機):點擊當下直接開系統分享面板,前面不能先 await 別的東西 */
  const nativeShare = async () => {
    if (shareLink === null) return
    try {
      await navigator.share({ title: `字卡牌組：${deck.name}`, url: shareLink })
      setShareMsg('已分享')
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return // 自己關掉面板
      setShareMsg('系統分享沒有成功，改按「複製連結」')
    }
  }

  const copyShareLink = async () => {
    if (shareLink === null) return
    try {
      await navigator.clipboard.writeText(shareLink)
      setShareMsg('已複製連結，貼給朋友就好')
    } catch {
      shareInput.current?.select()
      setShareMsg('沒辦法自動複製，連結已選取，請手動拷貝')
    }
  }

  const removeDeck = () => run(async () => {
    const ok = await confirm({
      title: `刪除「${deck.name}」？`,
      message: `牌組裡的 ${notes.length} 個字和複習進度會一起刪除。`,
      confirmLabel: '刪除',
      destructive: true,
    })
    if (!ok) return
    try {
      await softDeleteDeck(deck.id)
      setErrMsg(null)
      requestSync()
      navigate('/')
    } catch (e) {
      setErrMsg(`操作失敗：${errText(e)}`)
    }
  })

  const removeNote = () => run(async () => {
    const id = editingId
    if (id === null || id === 'new') return
    const label = notes.find((n) => n.id === id)?.expression ?? form.expression
    const ok = await confirm({ title: `刪除「${label}」？`, message: '這個字和它的複習進度會一起刪除。', confirmLabel: '刪除', destructive: true })
    if (!ok) return
    try {
      await softDeleteNote(id)
      closeNote()
      // 刪掉的那一列不在了,焦點會掉到頁首:放到「復原」上(鍵盤、讀螢幕的人才來得及復原)
      toast.show(`已刪除「${label}」`, {
        label: '復原',
        onClick: () => void restoreNote(id).then(() => requestSync()),
      }, { focusAction: true })
      requestSync()
    } catch (e) {
      setErrMsg(`操作失敗：${errText(e)}`)
    }
  })

  const noteSheetOpen = editingId !== null
  const isNew = editingId === 'new'
  // 面板裡有沒存的東西:新增時任一欄有字;編輯時跟原本那筆不一樣(或選了要搬去別副)
  const editingNote = !isNew && editingId !== null ? notes.find((n) => n.id === editingId) : undefined
  const noteDirty = isNew
    ? [form.expression, form.reading, form.meaning, form.accent].some((v) => v.trim() !== '')
    : editingNote !== undefined && (
      form.expression !== editingNote.expression || form.reading !== editingNote.reading
      || form.meaning !== editingNote.meaning || form.accent !== (editingNote.accent ?? '')
      || form.reversed !== (editingNote.reversed === 1) || (moveTo !== null && moveTo !== deck.id))
  // chip 上的數字跟著搜尋走:不然搜尋時「已會 4」點下去可能是空的
  const chipCounts = { all: 0, active: 0, known: 0, paused: 0 }
  for (const n of notes) {
    if (!matchesSearch(n)) continue
    chipCounts.all += 1
    chipCounts[noteStatus(cardsByNote.get(n.id))] += 1
  }
  const statusChips: readonly (readonly ['all' | NoteStatus, string, number])[] = [
    ['all', '全部', chipCounts.all],
    ['active', '進行中', chipCounts.active],
    ['known', '已會', chipCounts.known],
    ['paused', '先不學', chipCounts.paused],
  ]

  return (
    <>
      <PageHeader
        title={deck.name}
        back={selecting ? undefined : { to: '/', label: '牌組' }}
        leading={selecting ? <button className="btn plain" onClick={exitSelecting}>完成</button> : undefined}
        actions={selecting ? (
          <button className="btn plain" onClick={() => setSelected(new Set(filtered.map((n) => n.id)))}>全選</button>
        ) : (
          <button className="icon-btn" aria-label="更多動作" aria-haspopup="dialog" onClick={() => setMenuOpen(true)}>
            <MoreIcon />
          </button>
        )}
        subtitle={
          <span className="deck-summary">
            {notes.length} 個字
            {statusCounts.known > 0 && <> · 已會 {statusCounts.known}</>}
            {statusCounts.paused > 0 && <> · 先不學 {statusCounts.paused}</>}
          </span>
        }
      />

      {/* 空牌組只留下面的空狀態:不要一邊說「今天完成了」、一邊有兩組「新增」 */}
      {!selecting && notes.length > 0 && (
        <div className="deck-actions">
          {queueCount > 0 ? (
            <Link to={`/review/${deck.id}`} className="btn lg deck-review-btn"><PlayIcon size={13} />開始複習 · {queueCount}</Link>
          ) : hasNewLeft ? (
            // 今天的份做完、牌組裡還有沒學過的字:直接加碼一輪新卡
            <Link to={`/review/${deck.id}?more=1`} className="btn lg secondary deck-review-btn">
              <CheckIcon size={18} />今天完成 · 再學一點
            </Link>
          ) : (
            <span className="btn lg secondary deck-review-btn" aria-disabled="true"><CheckIcon size={18} />今天完成了</span>
          )}
          <button className="btn lg tinted deck-add-btn" onClick={openNew}><PlusIcon size={18} />新增</button>
        </div>
      )}

      {progressMsg && (
        <div className="notice deck-progress" role="status"><span className="spinner" aria-hidden="true" />{progressMsg}</div>
      )}
      {errMsg && !noteSheetOpen && !settingsOpen && (
        <div className="notice error deck-progress" role="alert">
          <span className="notice-text">{errMsg}</span>
          <span className="notice-actions"><button className="link" onClick={() => setErrMsg(null)}>關閉</button></span>
        </div>
      )}

      {notes.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon"><FileIcon size={28} /></span>
          <h2>還沒有卡片</h2>
          <p>一張一張加，或是把整份單字表用 CSV 匯進來。</p>
          <div className="btn-stack">
            <button className="btn lg" onClick={openNew}>新增卡片</button>
            <Link to={`/import?mode=csv&deck=${deck.id}`} className="btn lg secondary">匯入 CSV</Link>
          </div>
        </div>
      ) : (
        <>
          <div className="list-tools">
            <div className="search-field">
              <SearchIcon />
              {/* 按鍵盤的「搜尋」就收起鍵盤,結果才不會被擋住一半 */}
              <input type="search" placeholder="搜尋單字、讀音或意思" value={search} aria-label="搜尋卡片" enterKeyHint="search"
                onChange={(e) => setSearch(e.target.value)}
                // Safari 用 Enter 確定日文選字時,keydown 的 isComposing 已經是 false,只剩 keyCode 229 看得出來
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) e.currentTarget.blur() }} />
              {search !== '' && (
                <button className="search-clear" aria-label="清除搜尋" onClick={() => setSearch('')}><CloseIcon size={16} /></button>
              )}
            </div>
            <button className="icon-btn filled" aria-label={`排序：${SORTS.find(([k]) => k === sort)?.[1]}`}
              onClick={() => setSortOpen(true)}><SortIcon /></button>
          </div>
          {(hasParked || status !== 'all') && (
            <div className="chips" role="radiogroup" aria-label="狀態篩選">
              {statusChips.map(([key, label, count]) => (
                <button key={key} type="button" role="radio" aria-checked={status === key}
                  className={`chip${status === key ? ' active' : ''}`} onClick={() => setStatus(key)}>
                  {label}<span className="chip-count">{count}</span>
                </button>
              ))}
            </div>
          )}

          <ul className="list note-list">
            {shown.map((n) => {
              const badge = noteStateBadge(cardsByNote.get(n.id), listNow)
              const isSel = selected.has(n.id)
              return (
                <li key={n.id}>
                  <button type="button" className={`row note-row${selecting && isSel ? ' selected' : ''}`}
                    aria-pressed={selecting ? isSel : undefined}
                    onClick={() => (selecting ? toggleSelected(n.id) : openEdit(n))}>
                    {selecting && <span className={`select-mark${isSel ? ' on' : ''}`} aria-hidden="true"><CheckIcon size={14} /></span>}
                    <span className="row-main">
                      <span className="note-line1">
                        <span className="note-expr" lang="ja">{n.expression}</span>
                        {badge !== null && <span className={`badge ${badge.cls}`}>{badge.label}</span>}
                      </span>
                      <span className="row-subtitle note-line2">
                        {n.reading && n.reading !== n.expression && <span className="note-reading" lang="ja">{n.reading}</span>}
                        <span className="note-meaning">{n.meaning}</span>
                      </span>
                    </span>
                    {!selecting && <span className="row-chevron"><ChevronRightIcon /></span>}
                  </button>
                </li>
              )
            })}
          </ul>
          {filtered.length === 0 && (
            <div className="list-empty">
              <p>{search !== '' ? `找不到「${search}」` : '這個分類裡沒有卡片'}</p>
              <button className="btn plain" onClick={() => { setSearch(''); setStatus('all') }}>
                {search !== '' ? '清除搜尋' : '顯示全部'}
              </button>
            </div>
          )}
          <div ref={sentinel} />
          <p className="list-count">
            顯示 {shown.length} / {filtered.length} 個字
            {shown.length < filtered.length && (
              <> · <button className="link" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>顯示更多</button></>
            )}
          </p>
        </>
      )}

      {selecting && (
        <div ref={batchBar} className="batch-bar" role="region" aria-label="批次操作">
          <span className="batch-count">已選 <b>{selected.size}</b> 個字</span>
          <div className="batch-actions">
            <button className="btn sm" disabled={busy || selected.size === 0} onClick={() => void applyStatus(2)}>已經會了</button>
            <button className="btn sm secondary" disabled={busy || selected.size === 0} onClick={() => void applyStatus(1)}>先不學</button>
            <button className="btn sm secondary" disabled={busy || selected.size === 0} onClick={() => void applyStatus(0)}>恢復</button>
          </div>
        </div>
      )}

      <ActionSheet open={menuOpen} onClose={() => setMenuOpen(false)} actions={[
        { label: '選取多個字', icon: <SelectIcon />, onSelect: () => setSelecting(true), disabled: notes.length === 0 },
        { label: '匯入單字到這副牌組', icon: <FileIcon />, onSelect: () => navigate(`/import?mode=csv&deck=${deck.id}`) },
        { label: '分享牌組', icon: <ShareIcon />, onSelect: () => void shareDeck(), disabled: notes.length === 0 || busy },
        { label: '自動標註重音', icon: <SparklesIcon />, onSelect: () => void annotateDeck(), disabled: busy },
        { label: '匯出 CSV', icon: <DownloadIcon />, onSelect: () => download(`${deck.name}.csv`, exportCsv(notes)) },
        { label: '牌組設定', icon: <SlidersIcon />, onSelect: () => { setErrMsg(null); setSettingsNote(null); setSettingsOpen(true) } },
        { label: '刪除牌組', icon: <TrashIcon />, destructive: true, onSelect: () => void removeDeck() },
      ]} />

      <ActionSheet open={sortOpen} onClose={() => setSortOpen(false)} title="排序" actions={SORTS.map(([key, label]) => ({
        label: sort === key ? `✓ ${label}` : label, onSelect: () => setSort(key),
      }))} />

      <Sheet open={noteSheetOpen} onClose={closeNote} full title={isNew ? '新增卡片' : '編輯卡片'} dirty={noteDirty}
        cancelLabel={isNew && addedLabel !== null && !noteDirty ? '完成' : '取消'}
        end={<button type="button" className="btn plain strong" disabled={busy} onClick={() => void saveNote()}>{isNew ? '新增' : '儲存'}</button>}>
        <form className="form note-form" onSubmit={(e) => { e.preventDefault(); void saveNote() }}>
          {isNew && addedLabel !== null && (
            <p className="added-line" role="status"><CheckIcon size={16} />已新增「{addedLabel}」，可以繼續輸入下一個</p>
          )}
          <label className="field"><span className="field-label">單字</span>
            <input ref={firstField} lang="ja" placeholder="例如 勉強" value={form.expression} data-autofocus={isNew ? '' : undefined}
              enterKeyHint="next" onKeyDown={nextOnEnter(readingField)}
              onChange={(e) => setForm({ ...form, expression: e.target.value })} />
          </label>
          <div className="field-row">
            <label className="field"><span className="field-label">讀音（可空）</span>
              <input ref={readingField} lang="ja" placeholder="例如 べんきょう" value={form.reading}
                enterKeyHint="next" onKeyDown={nextOnEnter(meaningField)}
                onChange={(e) => setForm({ ...form, reading: e.target.value })} onBlur={autoLookup} />
            </label>
            {isSpeechSupported() && (
              <button type="button" className="speak-btn field-btn" aria-label="播放發音"
                onClick={() => speak(form.reading || form.expression)}><SpeakerIcon size={20} /></button>
            )}
          </div>
          <label className="field"><span className="field-label">意思</span>
            <input ref={meaningField} placeholder="例如 讀書、用功" value={form.meaning} enterKeyHint="done"
              onChange={(e) => setForm({ ...form, meaning: e.target.value })} />
          </label>
          <div className="field-row">
            <label className="field"><span className="field-label">重音（可空）</span>
              {/* 不用 numeric 鍵盤:iPhone 的數字鍵盤打不出「0,3」的逗號 */}
              <input ref={accentField} placeholder="例如 0 或 0,3" value={form.accent} autoCapitalize="off" autoCorrect="off"
                onChange={(e) => { setForm({ ...form, accent: e.target.value }); setAccentHint(''); setAccentErr('') }} />
            </label>
            <button type="button" className="btn secondary field-btn" disabled={looking} onClick={() => void lookupOne()}>
              {looking ? '查詢中…' : '查字典'}
            </button>
          </div>
          {/* 改對了(手打、查字典補上)就不再顯示 */}
          {accentErr !== '' && !isValidAccent(normalizeAccent(form.accent)) && (
            <p ref={accentErrRef} className="err accent-hint" role="alert">{accentErr}</p>
          )}
          {accentHint !== '' && <p className="field-hint accent-hint">{accentHint}</p>}
          {form.reading.trim() !== '' && form.accent.trim() !== '' && isValidAccent(form.accent.trim()) && (
            <div className="accent-preview"><PitchAccent reading={form.reading.trim()} accent={form.accent.trim()} /></div>
          )}
          <ListSection footer="反向卡：看中文意思，想出日文單字。">
            <label className="row">
              <span className="row-main"><span className="row-title">同時建立反向卡</span></span>
              <Switch label="同時建立反向卡" checked={form.reversed} onChange={(v) => setForm({ ...form, reversed: v })} />
            </label>
          </ListSection>
          {!isNew && allDecks !== undefined && allDecks.length > 1 && (
            <label className="field"><span className="field-label">牌組（換一副 = 搬過去，進度保留）</span>
              <select value={moveTo ?? deck.id} onChange={(e) => setMoveTo(e.target.value)}>
                {allDecks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          )}
          {errMsg && <p className="err" role="alert">{errMsg}</p>}
          {!isNew && (
            <button type="button" className="btn danger lg" disabled={busy} onClick={() => void removeNote()}>
              <TrashIcon size={18} />刪除這個字
            </button>
          )}
          <button type="submit" hidden />
        </form>
      </Sheet>

      <Sheet open={settingsOpen} onClose={() => { setDeckName(null); setNewPerDay(null); setErrMsg(null); setSettingsNote(null); setSettingsOpen(false) }}
        title="牌組設定" dirty={(deckName !== null && deckName.trim() !== deck.name) || (newPerDay !== null && newPerDay !== deck.new_per_day)}
        end={<button type="button" className="btn plain strong" disabled={busy} onClick={() => void saveDeck()}>儲存</button>}>
        <form className="form" onSubmit={(e) => { e.preventDefault(); void saveDeck() }}>
          <label className="field"><span className="field-label">名稱</span>
            <input value={deckName ?? deck.name} onChange={(e) => setDeckName(e.target.value)} />
          </label>
          <label className="field"><span className="field-label">每天最多幾張新卡</span>
            <input type="number" min={0} inputMode="numeric"
              value={newPerDay !== null && Number.isNaN(newPerDay) ? '' : newPerDay ?? deck.new_per_day}
              onChange={(e) => setNewPerDay(e.target.value === '' ? NaN : Number(e.target.value))} />
            <span className="field-hint">沒看過的字每天最多出現幾張；複習到期的卡不受限制。</span>
          </label>
          {errMsg && <p className="err" role="alert">{errMsg}</p>}
          <ListSection footer={settingsNote !== null
            ? <span role="status" className="settings-note"><CheckIcon size={14} />{settingsNote}</span>
            : '反向卡：看中文意思，想出日文單字。新的反向卡從新卡開始排程。'}>
            <button type="button" className="row accent" disabled={busy} onClick={() => void bulkReverse()}>為整副開啟反向卡</button>
          </ListSection>
          <ListSection>
            <button type="button" className="row destructive" disabled={busy} onClick={() => void removeDeck()}>刪除牌組</button>
          </ListSection>
          <button type="submit" hidden />
        </form>
      </Sheet>

      <Sheet open={shareOpen} onClose={closeShare} title="分享牌組"
        start={<span />}
        end={<button type="button" className="btn plain strong" onClick={closeShare}>完成</button>}>
        <div className="share-sheet">
          <p className="hint">朋友打開連結就能匯入「{deck.name}」的單字，不含你的複習進度。連結半年後失效。</p>
          {shareLink === null ? (
            <div className="share-uploading" role="status">
              {shareMsg?.startsWith('分享失敗') ? <p className="err">{shareMsg}</p> : <><span className="spinner" aria-hidden="true" />{shareMsg ?? '準備中…'}</>}
            </div>
          ) : (
            <>
              <input ref={shareInput} className="share-link-input" readOnly value={shareLink} aria-label="分享連結"
                onFocus={(e) => e.currentTarget.select()} />
              <div className="btn-stack">
                {canNativeShare && <button className="btn lg" onClick={() => void nativeShare()}><ShareIcon size={18} />分享…</button>}
                <button className={canNativeShare ? 'btn lg tinted' : 'btn lg'} onClick={() => void copyShareLink()}>複製連結</button>
              </div>
              {shareMsg && <p className="hint share-msg" role="status" aria-live="polite">{shareMsg}</p>}
            </>
          )}
        </div>
      </Sheet>

      {toast.node}
    </>
  )
}
