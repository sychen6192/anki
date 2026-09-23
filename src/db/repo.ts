import { db, type Local } from './db'
import type { CardRecord, CardSuspended, DeckRecord, NoteRecord, ReviewLogRecord } from '../../shared/types'
import { newCardFields, type FsrsFields } from '../lib/fsrs'

export interface NoteInput { expression: string; reading: string; meaning: string; reversed: boolean; accent: string }

const now = () => Date.now()

export async function createDeck(name: string): Promise<DeckRecord> {
  const deck: Local<DeckRecord> = {
    id: crypto.randomUUID(), name: name.trim(), new_per_day: 20,
    updated_at: now(), deleted: 0, dirty: 1,
  }
  await db.decks.add(deck)
  return deck
}

export async function updateDeck(id: string, patch: Partial<Pick<DeckRecord, 'name' | 'new_per_day'>>): Promise<void> {
  await db.decks.update(id, { ...patch, updated_at: now(), dirty: 1 })
}

export async function softDeleteDeck(id: string): Promise<void> {
  await db.transaction('rw', [db.decks, db.notes, db.cards], async () => {
    const t = now()
    await db.decks.update(id, { deleted: 1, updated_at: t, dirty: 1 })
    await db.notes.where('deck_id').equals(id).modify({ deleted: 1, updated_at: t, dirty: 1 })
    await db.cards.where('deck_id').equals(id).modify({ deleted: 1, updated_at: t, dirty: 1 })
  })
}

function makeCard(
  note: NoteRecord, direction: CardRecord['direction'], t: number, suspended: CardSuspended = 0,
): Local<CardRecord> {
  return {
    id: crypto.randomUUID(), note_id: note.id, deck_id: note.deck_id, direction,
    ...newCardFields(t), suspended, updated_at: t, deleted: 0, dirty: 1,
  }
}

export async function createNote(deckId: string, input: NoteInput): Promise<NoteRecord> {
  const t = now()
  const note: Local<NoteRecord> = {
    id: crypto.randomUUID(), deck_id: deckId,
    expression: input.expression.trim(), reading: input.reading.trim(), meaning: input.meaning.trim(),
    accent: input.accent.trim(),
    reversed: input.reversed ? 1 : 0, updated_at: t, deleted: 0, dirty: 1,
  }
  await db.transaction('rw', [db.notes, db.cards], async () => {
    await db.notes.add(note)
    await db.cards.add(makeCard(note, 'forward', t))
    if (note.reversed) await db.cards.add(makeCard(note, 'reverse', t))
  })
  return note
}

export async function createNotes(deckId: string, inputs: NoteInput[]): Promise<NoteRecord[]> {
  const t = now()
  // updated_at 逐筆 +1ms:同批匯入的 note 才有穩定的先後,列表能還原匯入順序
  const notes: Local<NoteRecord>[] = inputs.map((input, i) => ({
    id: crypto.randomUUID(), deck_id: deckId,
    expression: input.expression.trim(), reading: input.reading.trim(), meaning: input.meaning.trim(),
    accent: input.accent.trim(),
    reversed: input.reversed ? 1 : 0, updated_at: t + i, deleted: 0, dirty: 1,
  }))
  const cards = notes.flatMap((n) => n.reversed
    ? [makeCard(n, 'forward', n.updated_at), makeCard(n, 'reverse', n.updated_at)]
    : [makeCard(n, 'forward', n.updated_at)])
  await db.transaction('rw', [db.notes, db.cards], async () => {
    await db.notes.bulkAdd(notes)
    await db.cards.bulkAdd(cards)
  })
  return notes
}

export async function updateNote(id: string, patch: Partial<NoteInput>): Promise<void> {
  await db.transaction('rw', [db.notes, db.cards], async () => {
    const note = await db.notes.get(id)
    if (!note) return
    const t = now()
    const reversed: 0 | 1 = patch.reversed === undefined ? note.reversed : patch.reversed ? 1 : 0
    await db.notes.update(id, {
      expression: (patch.expression ?? note.expression).trim(),
      reading: (patch.reading ?? note.reading).trim(),
      meaning: (patch.meaning ?? note.meaning).trim(),
      accent: (patch.accent ?? note.accent).trim(),
      reversed, updated_at: t, dirty: 1,
    })
    const cardsOfNote = await db.cards.where('note_id').equals(id).toArray()
    const rev = cardsOfNote.find((c) => c.direction === 'reverse')
    // 新建的反向卡跟著正向卡的狀態:已經會了的字,開反向卡也不該跑回佇列
    const inherited = cardsOfNote.find((c) => c.direction === 'forward' && !c.deleted)?.suspended ?? 0
    if (reversed && rev?.deleted) {
      // 復原保留舊複習進度;狀態跟著正向卡(已經會了/先不學的字,復原的反向卡也不該跑回佇列)
      await db.cards.update(rev.id, { deleted: 0, suspended: inherited, updated_at: t, dirty: 1 })
    } else if (reversed && !rev) {
      await db.cards.add(makeCard({ ...note, reversed }, 'reverse', t, inherited))
    } else if (!reversed && rev && !rev.deleted) {
      await db.cards.update(rev.id, { deleted: 1, updated_at: t, dirty: 1 })
    }
  })
}

/**
 * 為整副牌組還沒有反向卡的 note 批次開啟反向卡。
 * 曾勾過又取消的 note 復原原本那張(保留 id 與複習進度),與 updateNote 同一套規則。
 * 回傳實際開啟的 note 數。
 */
export async function enableReverseCards(deckId: string): Promise<number> {
  let changed = 0
  await db.transaction('rw', [db.notes, db.cards], async () => {
    const t = now()
    const targets = await db.notes.where('deck_id').equals(deckId)
      .filter((n) => !n.deleted && n.reversed === 0).toArray()
    for (const note of targets) {
      await db.notes.update(note.id, { reversed: 1, updated_at: t, dirty: 1 })
      const cardsOfNote = await db.cards.where('note_id').equals(note.id).toArray()
      const rev = cardsOfNote.find((c) => c.direction === 'reverse')
      const inherited = cardsOfNote.find((c) => c.direction === 'forward' && !c.deleted)?.suspended ?? 0
      if (rev && rev.deleted) await db.cards.update(rev.id, { deleted: 0, suspended: inherited, updated_at: t, dirty: 1 })
      else if (!rev) await db.cards.add(makeCard({ ...note, reversed: 1 }, 'reverse', t, inherited))
      changed++
    }
  })
  return changed
}

/** 把 note 連同底下所有卡片搬到另一副牌組;排程進度不動。 */
export async function moveNote(id: string, deckId: string): Promise<void> {
  await db.transaction('rw', [db.notes, db.cards], async () => {
    const t = now()
    await db.notes.update(id, { deck_id: deckId, updated_at: t, dirty: 1 })
    await db.cards.where('note_id').equals(id).modify({ deck_id: deckId, updated_at: t, dirty: 1 })
  })
}

export async function softDeleteNote(id: string): Promise<void> {
  await db.transaction('rw', [db.notes, db.cards], async () => {
    const t = now()
    await db.notes.update(id, { deleted: 1, updated_at: t, dirty: 1 })
    // 已經刪掉的卡不再蓋章:保留原本的刪除時間,restoreNote 才分得出哪些是這次一起刪的
    await db.cards.where('note_id').equals(id).filter((c) => !c.deleted)
      .modify({ deleted: 1, updated_at: t, dirty: 1 })
  })
}

/**
 * 復原剛刪掉的筆記:筆記與「跟著它一起刪」的卡片(同一個時間戳)改回未刪除,時間戳往前推讓 LWW 傳播。
 * 在這之前就刪掉的卡(例如先前關掉的反向卡)維持刪除。
 */
export async function restoreNote(id: string): Promise<void> {
  await db.transaction('rw', [db.notes, db.cards], async () => {
    const note = await db.notes.get(id)
    if (note === undefined || note.deleted !== 1) return
    const deletedAt = note.updated_at
    const t = Math.max(now(), deletedAt + 1)
    await db.notes.update(id, { deleted: 0, updated_at: t, dirty: 1 })
    await db.cards.where('note_id').equals(id)
      .filter((c) => c.deleted === 1 && c.updated_at === deletedAt)
      .modify({ deleted: 0, updated_at: t, dirty: 1 })
  })
}

/** 回傳新增的 review_log id,讓呼叫端可以復原這次評分。 */
export async function applyReview(
  card: CardRecord, fields: FsrsFields, log: Omit<ReviewLogRecord, 'id' | 'card_id'>,
): Promise<string> {
  const logId = crypto.randomUUID()
  await db.transaction('rw', [db.cards, db.review_logs], async () => {
    await db.cards.update(card.id, { ...fields, updated_at: now(), dirty: 1 })
    await db.review_logs.add({ id: logId, card_id: card.id, ...log, dirty: 1 })
  })
  return logId
}

/**
 * 復原一次評分:把卡片的排程欄位還原成 `card` 的內容,並刪掉那筆 review_log。
 * 還原用的是新的 updated_at,所以其他裝置會透過 LWW 收到「還原後」的狀態。
 * 注意:review_logs 在伺服器端是 append-only(無墓碑),若這筆 log 已經推送過,
 * 伺服器上的那一列會留著 — 對單人使用只影響「今日新卡數」的統計,不影響排程。
 */
export async function undoReview(card: CardRecord, logId: string): Promise<void> {
  await db.transaction('rw', [db.cards, db.review_logs], async () => {
    await db.cards.update(card.id, {
      due: card.due, stability: card.stability, difficulty: card.difficulty,
      elapsed_days: card.elapsed_days, scheduled_days: card.scheduled_days,
      learning_steps: card.learning_steps, reps: card.reps, lapses: card.lapses,
      state: card.state, last_review: card.last_review,
      updated_at: now(), dirty: 1,
    })
    await db.review_logs.delete(logId)
  })
}

export interface SuspendedSnapshot { id: string; suspended: CardSuspended }

/**
 * 把一筆 note 底下所有(未刪除)卡片一起設成某個狀態:0 學習中、1 暫停、2 已經會了。
 * 動作以「字」為單位是刻意的:使用者看到的是單字,不是正反兩張卡。
 * 回傳改動前每張卡的值,讓複習頁的「復原」可以精確寫回去。
 */
export async function setNoteSuspended(noteId: string, value: CardSuspended): Promise<SuspendedSnapshot[]> {
  const prev: SuspendedSnapshot[] = []
  await db.transaction('rw', [db.cards], async () => {
    const t = now()
    const cards = await db.cards.where('note_id').equals(noteId).filter((c) => !c.deleted).toArray()
    for (const c of cards) {
      prev.push({ id: c.id, suspended: c.suspended ?? 0 })
      if ((c.suspended ?? 0) !== value) await db.cards.update(c.id, { suspended: value, updated_at: t, dirty: 1 })
    }
  })
  return prev
}

/** 批次版(牌組頁勾選多筆)。回傳實際改到的卡片數,已經是該狀態的不動。 */
export async function setNotesSuspended(noteIds: string[], value: CardSuspended): Promise<number> {
  return (await setNotesSuspendedUndoable(noteIds, value)).length
}

/** 同 setNotesSuspended,回傳改動前的狀態:交給 restoreCardsSuspended 就能復原 */
export async function setNotesSuspendedUndoable(noteIds: string[], value: CardSuspended): Promise<SuspendedSnapshot[]> {
  const prev: SuspendedSnapshot[] = []
  await db.transaction('rw', [db.cards], async () => {
    const t = now()
    await db.cards.where('note_id').anyOf(noteIds)
      .filter((c) => !c.deleted && (c.suspended ?? 0) !== value)
      .modify((c) => {
        prev.push({ id: c.id, suspended: (c.suspended ?? 0) as CardSuspended })
        c.suspended = value; c.updated_at = t; c.dirty = 1
      })
  })
  return prev
}

/** 復原 setNoteSuspended:逐張寫回原值。用新的 updated_at,其他裝置才會經 LWW 收到復原結果。 */
export async function restoreCardsSuspended(prev: SuspendedSnapshot[]): Promise<void> {
  await db.transaction('rw', [db.cards], async () => {
    const t = now()
    for (const p of prev) await db.cards.update(p.id, { suspended: p.suspended, updated_at: t, dirty: 1 })
  })
}
