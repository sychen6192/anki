import {
  createEmptyCard, fsrs, generatorParameters, GenSeedStrategyWithCardId, Rating, State, StrategyMode,
  type Card as FsrsCard, type Grade,
} from 'ts-fsrs'
import type { CardRecord, ReviewLogRecord } from '../../shared/types'

export { Rating, State }
export type RatingValue = 1 | 2 | 3 | 4

// fuzz 的亂數種子預設含「評分當下的毫秒時間」。按鈕上的間隔在 render 時算、評分在點擊時
// 再算一次,兩個時間點不同,超過 2.5 天的間隔就會被 fuzz 抖成不同的值 —— 按鈕寫 4 天,
// 實際排 3 天或 5 天,連重新 render 都會讓按鈕上的數字跳動。改用「卡片 id + 第幾次複習」
// 當種子:同一張卡同一天怎麼算都一樣;不同卡片、下一次複習仍各自錯開(fuzz 的本意是分散到期日)。
const f = fsrs(generatorParameters({ enable_fuzz: true }))
  .useStrategy(StrategyMode.SEED, GenSeedStrategyWithCardId('id'))

export type FsrsFields = Pick<CardRecord,
  'due' | 'stability' | 'difficulty' | 'elapsed_days' | 'scheduled_days' |
  'learning_steps' | 'reps' | 'lapses' | 'state' | 'last_review'>

export function newCardFields(now = Date.now()): FsrsFields {
  return fromFsrs(createEmptyCard(new Date(now)))
}

function toFsrs(c: CardRecord): FsrsCard {
  return {
    id: c.id, // ts-fsrs 的 Card 沒這欄;只給上面的 seed 策略讀
    due: new Date(c.due), stability: c.stability, difficulty: c.difficulty,
    elapsed_days: c.elapsed_days, scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps, reps: c.reps, lapses: c.lapses,
    state: c.state as State,
    last_review: c.last_review == null ? undefined : new Date(c.last_review),
  } as FsrsCard
}

function fromFsrs(c: FsrsCard): FsrsFields {
  return {
    due: c.due.getTime(), stability: c.stability, difficulty: c.difficulty,
    elapsed_days: c.elapsed_days, scheduled_days: c.scheduled_days,
    learning_steps: (c as { learning_steps?: number }).learning_steps ?? 0,
    reps: c.reps, lapses: c.lapses, state: c.state,
    last_review: c.last_review ? new Date(c.last_review).getTime() : null,
  }
}

export function rate(card: CardRecord, rating: RatingValue, now = Date.now()):
  { fields: FsrsFields; log: Omit<ReviewLogRecord, 'id' | 'card_id'> } {
  const item = f.repeat(toFsrs(card), new Date(now))[rating as Grade]
  return {
    fields: fromFsrs(item.card),
    log: {
      rating, state: item.log.state, due: item.log.due.getTime(),
      stability: item.log.stability, difficulty: item.log.difficulty,
      elapsed_days: item.log.elapsed_days, last_elapsed_days: item.log.last_elapsed_days,
      scheduled_days: item.log.scheduled_days, reviewed_at: item.log.review.getTime(),
    },
  }
}

export function previewIntervals(card: CardRecord, now = Date.now()): Record<RatingValue, string> {
  const rec = f.repeat(toFsrs(card), new Date(now))
  const out = {} as Record<RatingValue, string>
  for (const r of [1, 2, 3, 4] as const) out[r] = formatInterval(rec[r as Grade].card.due.getTime() - now)
  return out
}

export function formatInterval(ms: number): string {
  const min = ms / 60000
  if (min < 60) return `${Math.max(1, Math.round(min))}分`
  const hr = min / 60
  if (hr < 24) return `${Math.round(hr)}小時`
  const day = hr / 24
  if (day < 31) return `${Math.round(day)}天`
  const mon = day / 30.44
  if (mon < 12) return `${mon.toFixed(1)}月`
  return `${(day / 365.25).toFixed(1)}年`
}
