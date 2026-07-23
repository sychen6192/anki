import 'fake-indexeddb/auto'
import { beforeEach, describe, it, expect } from 'vitest'
import { db } from '../src/db/db'
import {
  createDeck, updateDeck, softDeleteDeck,
  createNote, createNotes, updateNote, softDeleteNote, applyReview, undoReview,
  enableReverseCards, moveNote,
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
    await createNote(deck.id, { expression: '猫', reading: 'ねこ', meaning: '貓', reversed: true, accent: '' })
    await softDeleteDeck(deck.id)
    expect((await db.decks.get(deck.id))!.deleted).toBe(1)
    for (const n of await db.notes.toArray()) expect(n.deleted).toBe(1)
    for (const c of await db.cards.toArray()) expect(c.deleted).toBe(1)
  })
})

describe('note 與卡片生成', () => {
  it('一般 note 產 1 張 forward 卡', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' })
    const cards = await db.cards.where('note_id').equals(note.id).toArray()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ direction: 'forward', deck_id: deck.id, deleted: 0, dirty: 1 })
  })

  it('reversed note 產 forward+reverse 兩張卡', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: true, accent: '' })
    const dirs = (await db.cards.where('note_id').equals(note.id).toArray()).map((c) => c.direction).sort()
    expect(dirs).toEqual(['forward', 'reverse'])
  })

  it('updateNote 開關 reversed 會補卡/墓碑反向卡', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' })
    await updateNote(note.id, { reversed: true })
    let cards = await db.cards.where('note_id').equals(note.id).toArray()
    expect(cards.filter((c) => c.direction === 'reverse' && !c.deleted)).toHaveLength(1)
    await updateNote(note.id, { reversed: false })
    cards = await db.cards.where('note_id').equals(note.id).toArray()
    expect(cards.find((c) => c.direction === 'reverse')!.deleted).toBe(1)
  })

  it('softDeleteNote 墓碑 note 與其卡片', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: true, accent: '' })
    await softDeleteNote(note.id)
    expect((await db.notes.get(note.id))!.deleted).toBe(1)
    for (const c of await db.cards.where('note_id').equals(note.id).toArray()) expect(c.deleted).toBe(1)
  })

  it('createNotes 批次建立 3 筆(1 筆 reversed)→ 3 notes + 4 cards,皆 dirty=1', async () => {
    const deck = await createDeck('A')
    const notes = await createNotes(deck.id, [
      { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' },
      { expression: '猫', reading: 'ねこ', meaning: '貓', reversed: true, accent: '' },
      { expression: '鳥', reading: 'とり', meaning: '鳥', reversed: false, accent: '' },
    ])
    expect(notes).toHaveLength(3)
    for (const n of notes) expect(n).toMatchObject({ deck_id: deck.id, deleted: 0, dirty: 1 })
    const allCards = await db.cards.where('deck_id').equals(deck.id).toArray()
    expect(allCards).toHaveLength(4)
    for (const c of allCards) expect(c.dirty).toBe(1)
  })

  it('createNote 儲存 accent;updateNote 可更新 accent', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '食べる', reading: 'たべる', meaning: '吃', reversed: false, accent: '2' })
    expect((await db.notes.get(note.id))!.accent).toBe('2')
    await updateNote(note.id, { accent: '0,3' })
    expect((await db.notes.get(note.id))!.accent).toBe('0,3')
  })
})

describe('applyReview', () => {
  it('更新卡片 FSRS 欄位並新增 review_log', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' })
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

describe('undoReview', () => {
  const firstCard = async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '猫', reading: 'ねこ', meaning: '貓', reversed: false, accent: '' })
    return (await db.cards.where('note_id').equals(note.id).toArray())[0]
  }

  it('還原排程欄位並刪掉那筆 review_log', async () => {
    const card = await firstCard()
    const { fields, log } = rate(card, 1)
    const logId = await applyReview(card, fields, log)
    expect((await db.cards.get(card.id))!.reps).toBe(1)

    await undoReview(card, logId)

    const restored = (await db.cards.get(card.id))!
    expect(restored.reps).toBe(card.reps)
    expect(restored.state).toBe(card.state)
    expect(restored.due).toBe(card.due)
    expect(restored.stability).toBe(card.stability)
    expect(restored.last_review).toBe(card.last_review)
    expect(await db.review_logs.get(logId)).toBeUndefined()
  })

  it('還原後標為 dirty 且 updated_at 前進,讓其他裝置經 LWW 收到還原結果', async () => {
    const card = await firstCard()
    const { fields, log } = rate(card, 3)
    const logId = await applyReview(card, fields, log)
    const afterReview = (await db.cards.get(card.id))!

    await new Promise((r) => setTimeout(r, 2))
    await undoReview(card, logId)

    const restored = (await db.cards.get(card.id))!
    expect(restored.dirty).toBe(1)
    expect(restored.updated_at).toBeGreaterThan(afterReview.updated_at)
  })

  it('連續兩次評分後,復原只回退最後一次', async () => {
    const card = await firstCard()
    const first = rate(card, 3)
    await applyReview(card, first.fields, first.log)
    const afterFirst = (await db.cards.get(card.id))!

    const second = rate(afterFirst, 1)
    const secondLogId = await applyReview(afterFirst, second.fields, second.log)

    await undoReview(afterFirst, secondLogId)

    const restored = (await db.cards.get(card.id))!
    expect(restored.reps).toBe(afterFirst.reps)
    expect(restored.state).toBe(afterFirst.state)
    expect(await db.review_logs.where('card_id').equals(card.id).count()).toBe(1)
  })
})

describe('enableReverseCards', () => {
  it('為整副牌組沒有反向卡的 note 補上反向卡', async () => {
    const deck = await createDeck('A')
    await createNotes(deck.id, [
      { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' },
      { expression: '猫', reading: 'ねこ', meaning: '貓', reversed: false, accent: '' },
    ])
    const changed = await enableReverseCards(deck.id)
    expect(changed).toBe(2)
    for (const n of await db.notes.toArray()) expect(n.reversed).toBe(1)
    const reverses = (await db.cards.toArray()).filter((c) => c.direction === 'reverse')
    expect(reverses).toHaveLength(2)
    for (const c of reverses) expect(c).toMatchObject({ deck_id: deck.id, deleted: 0, dirty: 1 })
  })

  it('已有反向卡的 note 不重複建;再跑一次是 no-op', async () => {
    const deck = await createDeck('A')
    await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: true, accent: '' })
    await createNote(deck.id, { expression: '猫', reading: 'ねこ', meaning: '貓', reversed: false, accent: '' })
    expect(await enableReverseCards(deck.id)).toBe(1)
    expect(await enableReverseCards(deck.id)).toBe(0)
    expect((await db.cards.toArray()).filter((c) => c.direction === 'reverse')).toHaveLength(2)
  })

  it('曾勾過又取消的 note:復原原本的反向卡(保留 id 與進度),不另建新卡', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: true, accent: '' })
    const rev = (await db.cards.where('note_id').equals(note.id).toArray()).find((c) => c.direction === 'reverse')!
    await updateNote(note.id, { reversed: false })
    expect(await enableReverseCards(deck.id)).toBe(1)
    const after = (await db.cards.where('note_id').equals(note.id).toArray()).filter((c) => c.direction === 'reverse')
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(rev.id)
    expect(after[0].deleted).toBe(0)
  })

  it('不動已刪除的 note', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' })
    await softDeleteNote(note.id)
    expect(await enableReverseCards(deck.id)).toBe(0)
  })
})

describe('moveNote', () => {
  it('note 與其所有卡片一起搬到目標牌組,並標 dirty', async () => {
    const a = await createDeck('A')
    const b = await createDeck('B')
    const note = await createNote(a.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: true, accent: '' })
    // 清掉 dirty 才能驗證搬移有重新標
    await db.notes.update(note.id, { dirty: 0 })
    await db.cards.where('note_id').equals(note.id).modify({ dirty: 0 })

    await moveNote(note.id, b.id)

    const moved = (await db.notes.get(note.id))!
    expect(moved.deck_id).toBe(b.id)
    expect(moved.dirty).toBe(1)
    const cards = await db.cards.where('note_id').equals(note.id).toArray()
    expect(cards).toHaveLength(2)
    for (const c of cards) {
      expect(c.deck_id).toBe(b.id)
      expect(c.dirty).toBe(1)
    }
  })

  it('搬移保留排程進度(due/state/reps 不變)', async () => {
    const a = await createDeck('A')
    const b = await createDeck('B')
    const note = await createNote(a.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' })
    const card = (await db.cards.where('note_id').equals(note.id).toArray())[0]
    const { fields, log } = rate(card, 3)
    await applyReview(card, fields, log)
    const before = (await db.cards.get(card.id))!

    await moveNote(note.id, b.id)

    const after = (await db.cards.get(card.id))!
    expect(after.due).toBe(before.due)
    expect(after.state).toBe(before.state)
    expect(after.reps).toBe(before.reps)
  })
})

describe('createNotes 匯入順序', () => {
  it('批次建立時 updated_at 逐筆遞增,列表才能還原匯入順序', async () => {
    const deck = await createDeck('A')
    const notes = await createNotes(deck.id, Array.from({ length: 5 }, (_, i) => ({
      expression: `w${i}`, reading: '', meaning: `m${i}`, reversed: false, accent: '',
    })))
    const stamps = notes.map((n) => n.updated_at)
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThan(stamps[i - 1])
  })
})
