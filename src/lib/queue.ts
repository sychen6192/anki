import { State } from './fsrs'
import type { CardRecord, DeckRecord, ReviewLogRecord } from '../../shared/types'

export interface QueueResult {
  queue: CardRecord[]
  nextLearningDue: number | null
  newRemaining: number
}

/**
 * 跟 Anki 一樣,一天從凌晨 4 點開始換日。半夜 1 點還在複習時應該算「昨天」的額度,
 * 而不是一過午夜就重新發一份新卡配額。
 */
export const DAY_START_HOUR = 4

export interface QueueCounts { news: number; learn: number; rev: number }

/** 佇列分成新卡/學習中/待複習三類(首頁與複習畫面的三色計數共用,兩邊才會對得上) */
export function splitCounts(queue: readonly CardRecord[]): QueueCounts {
  let news = 0
  let learn = 0
  for (const c of queue) {
    if (c.state === State.New) news++
    else if (c.state === State.Learning || c.state === State.Relearning) learn++
  }
  return { news, learn, rev: queue.length - news - learn }
}

/** 一張卡算在三類的哪一類 */
export function countKind(card: CardRecord): keyof QueueCounts {
  if (card.state === State.New) return 'news'
  if (card.state === State.Learning || card.state === State.Relearning) return 'learn'
  return 'rev'
}

export function startOfToday(now = Date.now()): number {
  const d = new Date(now)
  if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1)
  d.setHours(DAY_START_HOUR, 0, 0, 0)
  return d.getTime()
}

export function countTodayNew(logs: ReviewLogRecord[], now = Date.now()): number {
  const start = startOfToday(now)
  return logs.filter((l) => l.reviewed_at >= start && l.state === State.New).length
}

/**
 * 從既有的卡片與今日紀錄挑出某副牌組的佇列。
 * DeckList(一次算全部牌組)與 Review(只算一副)共用同一段篩選,
 * 免得兩邊各寫一次、日後改了 buildQueue 的語意只改到一邊。
 */
export function deckQueue(
  deckId: string, newPerDay: number,
  allCards: CardRecord[], todayLogs: ReviewLogRecord[], now = Date.now(),
): QueueResult {
  const cards = allCards.filter((c) => c.deck_id === deckId)
  const ids = new Set(cards.map((c) => c.id))
  return buildQueue(cards, todayLogs.filter((l) => ids.has(l.card_id)), newPerDay, now)
}

/**
 * 同一個字的正反兩面(sibling)不該連著出現:剛看完 勉強 的答案,下一張就是
 * 「讀書、用功」問你 勉強,等於白背。匯入時勾「同時建立反向卡」的兩張卡 updated_at
 * 相同,新卡段依 updated_at 排序就會正反相鄰。
 *
 * 這段時間內看過某一面,另一面就排到該段佇列的最後。佇列每答一張就重算,所以靠
 * 「最近的複習紀錄」判斷而不是靜態排開 —— 靜態排開的下一輪重算又會黏回去。
 * 不是 Anki 的 bury(延到明天):整段只剩這兩張時仍會相鄰,那是不寫進排程的代價。
 */
export const SIBLING_GAP_MS = 20 * 60_000

/** 最近看過的字:note_id → 這段時間內評過分的 card_id 集合 */
function recentlyReviewedNotes(
  cards: CardRecord[], logs: ReviewLogRecord[], now: number,
): Map<string, Set<string>> {
  const noteOf = new Map(cards.map((c) => [c.id, c.note_id]))
  const out = new Map<string, Set<string>>()
  for (const l of logs) {
    if (l.reviewed_at <= now - SIBLING_GAP_MS) continue
    const noteId = noteOf.get(l.card_id)
    if (noteId === undefined) continue
    const seen = out.get(noteId)
    if (seen) seen.add(l.card_id)
    else out.set(noteId, new Set([l.card_id]))
  }
  return out
}

/**
 * 「另一面最近看過」的卡片移到最後,其餘順序不動。
 * 只看別張卡的紀錄:卡片自己剛評過分又到期(學習步驟)要照 due 順序回來,不能被推後。
 */
function deferSiblings(cards: CardRecord[], recent: Map<string, Set<string>>): CardRecord[] {
  const kept: CardRecord[] = []
  const deferred: CardRecord[] = []
  for (const c of cards) {
    const seen = recent.get(c.note_id)
    const siblingSeen = seen !== undefined && seen.size > (seen.has(c.id) ? 1 : 0)
    if (siblingSeen) deferred.push(c)
    else kept.push(c)
  }
  return kept.concat(deferred)
}

/** 一個新卡額度的單位:單副牌組就是一個群組,跨牌組時每副牌組一個群組 */
interface QueueGroup { cards: CardRecord[]; logs: ReviewLogRecord[]; newPerDay: number }

/**
 * 單副與跨牌組共用的組裝。到期段跨所有群組依 due 排(先到期先看,不分牌組);
 * 新卡段各群組自己切額度、依群組順序接起來;兩段各自排開 sibling。
 * extraNew 是「再學 N 張」的加碼:跨群組共 N 張,依群組順序先補前面的。
 */
function assembleQueue(groups: QueueGroup[], now: number, extraNew = 0): QueueResult {
  const allCards = groups.flatMap((g) => g.cards)
  const allLogs = groups.flatMap((g) => g.logs)
  // 暫停 / 已經會了的卡不進佇列、不算到期,也不會觸發完成畫面的自動接回
  const isActive = (c: CardRecord) => !c.deleted && !c.suspended
  const active = allCards.filter(isActive)
  const recent = recentlyReviewedNotes(allCards, allLogs, now)
  const due = deferSiblings(active
    .filter((c) => c.state !== State.New && c.due <= now)
    .sort((a, b) => a.due - b.due), recent)

  let newRemaining = 0
  let extraLeft = Math.max(0, extraNew)
  const news: CardRecord[] = []
  for (const g of groups) {
    const fresh = g.cards.filter((c) => isActive(c) && c.state === State.New)
      .sort((a, b) => a.updated_at - b.updated_at) // 建立時間即初始 updated_at;近似 Anki 的建立順序
    const remaining = Math.max(0, g.newPerDay - countTodayNew(g.logs, now))
    const extra = Math.min(extraLeft, Math.max(0, fresh.length - remaining))
    extraLeft -= extra
    news.push(...fresh.slice(0, remaining + extra))
    newRemaining += remaining
  }
  const futureLearning = active.filter(
    (c) => (c.state === State.Learning || c.state === State.Relearning) && c.due > now,
  )
  return {
    // 額度先切再排開:排開只動順序,不改今天學哪幾張
    queue: [...due, ...deferSiblings(news, recent)],
    nextLearningDue: futureLearning.length ? Math.min(...futureLearning.map((c) => c.due)) : null,
    newRemaining,
  }
}

export function buildQueue(
  cards: CardRecord[], logs: ReviewLogRecord[], newPerDay: number, now = Date.now(),
): QueueResult {
  return assembleQueue([{ cards, logs, newPerDay }], now)
}

/**
 * 跨牌組一次複習:所有到期卡合在一起依 due 排,新卡各牌組照自己的每日上限。
 * 只算名單裡的牌組(呼叫端傳未刪除的),別副的卡片與紀錄不會混進來。
 */
export function buildMultiDeckQueue(
  decks: Pick<DeckRecord, 'id' | 'new_per_day'>[], allCards: CardRecord[], todayLogs: ReviewLogRecord[],
  now = Date.now(), extraNew = 0,
): QueueResult {
  const groups = decks.map((d) => {
    const cards = allCards.filter((c) => c.deck_id === d.id)
    const ids = new Set(cards.map((c) => c.id))
    return { cards, logs: todayLogs.filter((l) => ids.has(l.card_id)), newPerDay: d.new_per_day }
  })
  return assembleQueue(groups, now, extraNew)
}
