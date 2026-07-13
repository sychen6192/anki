import 'fake-indexeddb/auto'
import { beforeEach, describe, it, expect } from 'vitest'
import { db } from '../src/db/db'
import {
  createDeck, updateDeck, softDeleteDeck,
  createNote, createNotes, updateNote, softDeleteNote, applyReview,
} from '../src/db/repo'
import { rate } from '../src/lib/fsrs'

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('deck', () => {
  it('createDeck 預設值與 dirty 旗標', async () => {
    const deck = await createDeck('日文 N4')
    const row = await db.decks.get(deck.id)
    expect(row).toMatchObject({ name: '日文 N4', new_per_day: 20, deleted: 0, dirty: 1 })
  })

  it('updateDeck 更新欄位並推進 updated_at', async () => {
    const deck = await createDeck('A')
    const before = (await db.decks.get(deck.id))!.updated_at
    await new Promise((r) => setTimeout(r, 2))
    await updateDeck(deck.id, { name: 'B', new_per_day: 5 })
    const row = (await db.decks.get(deck.id))!
    expect(row.name).toBe('B')
    expect(row.new_per_day).toBe(5)
    expect(row.updated_at).toBeGreaterThan(before)
  })

  it('softDeleteDeck 連帶墓碑 notes 與 cards', async () => {
    const deck = await createDeck('A')
    await createNote(deck.id, { expression: '猫', reading: 'ねこ', meaning: '貓', reversed: true })
    await softDeleteDeck(deck.id)
    expect((await db.decks.get(deck.id))!.deleted).toBe(1)
    for (const n of await db.notes.toArray()) expect(n.deleted).toBe(1)
    for (const c of await db.cards.toArray()) expect(c.deleted).toBe(1)
  })
})

describe('note 與卡片生成', () => {
  it('一般 note 產 1 張 forward 卡', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false })
    const cards = await db.cards.where('note_id').equals(note.id).toArray()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ direction: 'forward', deck_id: deck.id, deleted: 0, dirty: 1 })
  })

  it('reversed note 產 forward+reverse 兩張卡', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: true })
    const dirs = (await db.cards.where('note_id').equals(note.id).toArray()).map((c) => c.direction).sort()
    expect(dirs).toEqual(['forward', 'reverse'])
  })

  it('updateNote 開關 reversed 會補卡/墓碑反向卡', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false })
    await updateNote(note.id, { reversed: true })
    let cards = await db.cards.where('note_id').equals(note.id).toArray()
    expect(cards.filter((c) => c.direction === 'reverse' && !c.deleted)).toHaveLength(1)
    await updateNote(note.id, { reversed: false })
    cards = await db.cards.where('note_id').equals(note.id).toArray()
    expect(cards.find((c) => c.direction === 'reverse')!.deleted).toBe(1)
  })

  it('softDeleteNote 墓碑 note 與其卡片', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: true })
    await softDeleteNote(note.id)
    expect((await db.notes.get(note.id))!.deleted).toBe(1)
    for (const c of await db.cards.where('note_id').equals(note.id).toArray()) expect(c.deleted).toBe(1)
  })

  it('createNotes 批次建立 3 筆(1 筆 reversed)→ 3 notes + 4 cards,皆 dirty=1', async () => {
    const deck = await createDeck('A')
    const notes = await createNotes(deck.id, [
      { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false },
      { expression: '猫', reading: 'ねこ', meaning: '貓', reversed: true },
      { expression: '鳥', reading: 'とり', meaning: '鳥', reversed: false },
    ])
    expect(notes).toHaveLength(3)
    for (const n of notes) expect(n).toMatchObject({ deck_id: deck.id, deleted: 0, dirty: 1 })
    const allCards = await db.cards.where('deck_id').equals(deck.id).toArray()
    expect(allCards).toHaveLength(4)
    for (const c of allCards) expect(c.dirty).toBe(1)
  })
})

describe('applyReview', () => {
  it('更新卡片 FSRS 欄位並新增 review_log', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false })
    const card = (await db.cards.where('note_id').equals(note.id).toArray())[0]
    const { fields, log } = rate(card, 3)
    await applyReview(card, fields, log)
    const updated = (await db.cards.get(card.id))!
    expect(updated.reps).toBe(1)
    expect(updated.dirty).toBe(1)
    const logs = await db.review_logs.where('card_id').equals(card.id).toArray()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ rating: 3, dirty: 1 })
  })
})
