import { db, type Local } from './db'
import type { CardRecord, DeckRecord, NoteRecord, ReviewLogRecord } from '../../shared/types'
import { newCardFields, type FsrsFields } from '../lib/fsrs'

export interface NoteInput { expression: string; reading: string; meaning: string; reversed: boolean }

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

function makeCard(note: NoteRecord, direction: CardRecord['direction'], t: number): Local<CardRecord> {
  return {
    id: crypto.randomUUID(), note_id: note.id, deck_id: note.deck_id, direction,
    ...newCardFields(t), updated_at: t, deleted: 0, dirty: 1,
  }
}

export async function createNote(deckId: string, input: NoteInput): Promise<NoteRecord> {
  const t = now()
  const note: Local<NoteRecord> = {
    id: crypto.randomUUID(), deck_id: deckId,
    expression: input.expression.trim(), reading: input.reading.trim(), meaning: input.meaning.trim(),
    reversed: input.reversed ? 1 : 0, updated_at: t, deleted: 0, dirty: 1,
  }
  await db.transaction('rw', [db.notes, db.cards], async () => {
    await db.notes.add(note)
    await db.cards.add(makeCard(note, 'forward', t))
    if (note.reversed) await db.cards.add(makeCard(note, 'reverse', t))
  })
  return note
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
      reversed, updated_at: t, dirty: 1,
    })
    const rev = (await db.cards.where('note_id').equals(id).toArray()).find((c) => c.direction === 'reverse')
    if (reversed && rev?.deleted) {
      await db.cards.update(rev.id, { deleted: 0, updated_at: t, dirty: 1 }) // 復原保留舊複習進度
    } else if (reversed && !rev) {
      await db.cards.add(makeCard({ ...note, reversed }, 'reverse', t))
    } else if (!reversed && rev && !rev.deleted) {
      await db.cards.update(rev.id, { deleted: 1, updated_at: t, dirty: 1 })
    }
  })
}

export async function softDeleteNote(id: string): Promise<void> {
  await db.transaction('rw', [db.notes, db.cards], async () => {
    const t = now()
    await db.notes.update(id, { deleted: 1, updated_at: t, dirty: 1 })
    await db.cards.where('note_id').equals(id).modify({ deleted: 1, updated_at: t, dirty: 1 })
  })
}

export async function applyReview(
  card: CardRecord, fields: FsrsFields, log: Omit<ReviewLogRecord, 'id' | 'card_id'>,
): Promise<void> {
  await db.transaction('rw', [db.cards, db.review_logs], async () => {
    await db.cards.update(card.id, { ...fields, updated_at: now(), dirty: 1 })
    await db.review_logs.add({ id: crypto.randomUUID(), card_id: card.id, ...log, dirty: 1 })
  })
}
