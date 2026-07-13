import {
  createEmptyCard, fsrs, generatorParameters, Rating, State,
  type Card as FsrsCard, type Grade,
} from 'ts-fsrs'
import type { CardRecord, ReviewLogRecord } from '../../shared/types'

export { Rating, State }
export type RatingValue = 1 | 2 | 3 | 4

const f = fsrs(generatorParameters({ enable_fuzz: true }))

export type FsrsFields = Pick<CardRecord,
  'due' | 'stability' | 'difficulty' | 'elapsed_days' | 'scheduled_days' |
  'learning_steps' | 'reps' | 'lapses' | 'state' | 'last_review'>

export function newCardFields(now = Date.now()): FsrsFields {
  return fromFsrs(createEmptyCard(new Date(now)))
}

function toFsrs(c: CardRecord): FsrsCard {
  return {
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
