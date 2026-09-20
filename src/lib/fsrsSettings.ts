import { db, type Local } from '../db/db'
import type { SettingRecord } from '../../shared/types'

export const FSRS_SETTINGS_ID = 'fsrs'
/** 目標保持率的合理範圍:低於 70% 記不住、高於 97% 複習量會爆炸(與 Anki 的 0.70–0.97 一致) */
export const MIN_RETENTION_PCT = 70
export const MAX_RETENTION_PCT = 97
// 從整數推:0.7 * 100 在 JS 是 70.00000000000001,畫面與 <input min> 都不能拿它來用
export const MIN_RETENTION = MIN_RETENTION_PCT / 100
export const MAX_RETENTION = MAX_RETENTION_PCT / 100

export interface FsrsSettings {
  /** FSRS 參數;null = 用 ts-fsrs 的預設參數 */
  w: number[] | null
  /** 目標保持率,排程會把間隔調到「到期時大約記得這個比例」 */
  desired_retention: number
  /** 上次最佳化的時間,沒做過為 null */
  optimized_at: number | null
  /** 上次最佳化用了幾筆複習紀錄 */
  optimized_reviews: number
}

export const DEFAULT_FSRS_SETTINGS: FsrsSettings = {
  w: null, desired_retention: 0.9, optimized_at: null, optimized_reviews: 0,
}

/** ts-fsrs 認得 17(FSRS-4.5)/19(FSRS-5)/21(FSRS-6)個參數,其餘長度會被它換回預設 */
export function isValidW(w: unknown): w is number[] {
  return Array.isArray(w) && [17, 19, 21].includes(w.length)
    && w.every((x) => typeof x === 'number' && Number.isFinite(x))
}

export function clampRetention(r: number): number {
  return Math.min(MAX_RETENTION, Math.max(MIN_RETENTION, r))
}

/**
 * 容錯解析。這筆 JSON 是同步進來的,可能出自更新或更舊的版本、甚至被手動改過:
 * 認得而且合法的欄位才收,其餘一律用預設,絕不讓一筆壞設定把排程弄成 NaN。
 */
export function parseFsrsSettings(value: string | undefined): FsrsSettings {
  if (value === undefined) return { ...DEFAULT_FSRS_SETTINGS }
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch {
    return { ...DEFAULT_FSRS_SETTINGS }
  }
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_FSRS_SETTINGS }
  const o = raw as Record<string, unknown>
  const dr = typeof o.desired_retention === 'number' && Number.isFinite(o.desired_retention)
    ? clampRetention(o.desired_retention) : DEFAULT_FSRS_SETTINGS.desired_retention
  return {
    w: isValidW(o.w) ? [...o.w] : null,
    desired_retention: dr,
    optimized_at: typeof o.optimized_at === 'number' && Number.isFinite(o.optimized_at) ? o.optimized_at : null,
    optimized_reviews: typeof o.optimized_reviews === 'number' && Number.isFinite(o.optimized_reviews)
      ? o.optimized_reviews : 0,
  }
}

export async function getFsrsSettings(): Promise<FsrsSettings> {
  const row = await db.settings.get(FSRS_SETTINGS_ID)
  return parseFsrsSettings(row !== undefined && !row.deleted ? row.value : undefined)
}

/** 存檔並標 dirty;呼叫端記得 requestSync() 推上去、applyFsrsSettings() 讓排程立刻用新值 */
export async function saveFsrsSettings(s: FsrsSettings): Promise<void> {
  const row: Local<SettingRecord> = {
    id: FSRS_SETTINGS_ID, value: JSON.stringify(s), updated_at: Date.now(), deleted: 0, dirty: 1,
  }
  await db.settings.put(row)
}
