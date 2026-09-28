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

/** 0 = 學習中;1 = 暫停(先不看);2 = 已經會了(不用學)。1 與 2 都不進佇列、不算到期,只差標籤與意圖。 */
export type CardSuspended = 0 | 1 | 2

export interface CardRecord {
  id: string; note_id: string; deck_id: string
  direction: 'forward' | 'reverse'
  due: number; stability: number; difficulty: number
  elapsed_days: number; scheduled_days: number; learning_steps: number
  reps: number; lapses: number; state: number; last_review: number | null
  suspended: CardSuspended
  updated_at: number; deleted: 0 | 1
}

export interface ReviewLogRecord {
  id: string; card_id: string; rating: number; state: number; due: number
  stability: number; difficulty: number
  elapsed_days: number; last_elapsed_days: number; scheduled_days: number
  reviewed_at: number
}

/**
 * 使用者層級的設定(FSRS 參數、目標保持率):id 是設定名稱,value 是 JSON 字串。
 * 跟 decks 一樣走 updated_at 的 LWW —— 排程參數必須在每台裝置一致,否則同一張卡
 * 在手機和電腦上會排出不同的間隔。
 */
export interface SettingRecord {
  id: string; value: string
  updated_at: number; deleted: 0 | 1
}

export interface SyncPush {
  decks: DeckRecord[]; notes: NoteRecord[]
  cards: CardRecord[]; review_logs: ReviewLogRecord[]
  /** 舊 client 不會送;伺服器對缺的表直接略過 */
  settings?: SettingRecord[]
}

export type SyncPullResponse = SyncPush & { settings: SettingRecord[]; seq: number }

/** 會撞到別的空間的資料表(設定表的 id 在伺服器上帶空間前綴,不會撞) */
export type ConflictTable = 'decks' | 'notes' | 'cards' | 'review_logs'

/**
 * skipped:伺服器沒存下的列 id(欄位型別不合法、id 已經是別的空間的、或參照了別的空間的列),客戶端據此保留 dirty。
 * conflicts:id 已經屬於別的空間的列。伺服器不會把它們搬過來,客戶端換一組新 id 再推(見 space.ts rekeyConflicts)。
 * 舊版 worker 不回 conflicts。
 */
export interface SyncPushResponse {
  ok: true
  skipped: string[]
  conflicts?: Partial<Record<ConflictTable, string[]>>
}
