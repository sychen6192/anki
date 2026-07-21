import Dexie, { type Table } from 'dexie'
import type { DeckRecord, NoteRecord, CardRecord, ReviewLogRecord } from '../../shared/types'

export type Local<T> = T & { dirty: 0 | 1 }
export interface MetaRow { key: string; value: number | string }

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
      // 只補沒有的,不覆蓋既有值 —— 這個 upgrade 對每個裝置只會跑一次而且不可逆,
      // 萬一升級當下已經有帶 accent 的資料(例如升級前剛同步進來),不該被清掉。
      await tx.table('notes').toCollection().modify((n: { accent?: string }) => {
        if (typeof n.accent !== 'string') n.accent = ''
      })
    })
  }
}

export const db = new AppDB()
