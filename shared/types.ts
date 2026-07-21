export interface DeckRecord {
  id: string; name: string; new_per_day: number
  updated_at: number; deleted: 0 | 1
}

export interface NoteRecord {
  id: string; deck_id: string
  expression: string; reading: string; meaning: string; reversed: 0 | 1
  accent: string
  updated_at: number; deleted: 0 | 1
}

export interface CardRecord {
  id: string; note_id: string; deck_id: string
  direction: 'forward' | 'reverse'
  due: number; stability: number; difficulty: number
  elapsed_days: number; scheduled_days: number; learning_steps: number
  reps: number; lapses: number; state: number; last_review: number | null
  updated_at: number; deleted: 0 | 1
}

export interface ReviewLogRecord {
  id: string; card_id: string; rating: number; state: number; due: number
  stability: number; difficulty: number
  elapsed_days: number; last_elapsed_days: number; scheduled_days: number
  reviewed_at: number
}

export interface SyncPush {
  decks: DeckRecord[]; notes: NoteRecord[]
  cards: CardRecord[]; review_logs: ReviewLogRecord[]
}

export type SyncPullResponse = SyncPush & { seq: number }

/** skipped:伺服器無法存下的列 id(欄位型別不合法),客戶端據此保留 dirty */
export interface SyncPushResponse { ok: true; skipped: string[] }
