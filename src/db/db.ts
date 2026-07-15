import Dexie, { type Table } from 'dexie'
import type { DeckRecord, NoteRecord, CardRecord, ReviewLogRecord } from '../../shared/types'

export type Local<T> = T & { dirty: 0 | 1 }
export interface MetaRow { key: string; value: number }

export class AppDB extends Dexie {
  decks!: Table<Local<DeckRecord>, string>
  notes!: Table<Local<NoteRecord>, string>
  cards!: Table<Local<CardRecord>, string>
  review_logs!: Table<Local<ReviewLogRecord>, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('anki-pwa')
    this.version(1).stores({
      decks: 'id, dirty',
      notes: 'id, deck_id, dirty',
      cards: 'id, note_id, deck_id, due, dirty',
      review_logs: 'id, card_id, reviewed_at, dirty',
      meta: 'key',
    })
    this.version(2).stores({
      decks: 'id, dirty',
      notes: 'id, deck_id, dirty',
      cards: 'id, note_id, deck_id, due, dirty',
      review_logs: 'id, card_id, reviewed_at, dirty',
      meta: 'key',
    }).upgrade(async (tx) => {
      await tx.table('notes').toCollection().modify((n: { accent?: string }) => { n.accent = '' })
    })
  }
}

export const db = new AppDB()
