import 'fake-indexeddb/auto'
import { beforeEach, describe, it, expect } from 'vitest'
import { db } from '../src/db/db'
import {
  createDeck, updateDeck, softDeleteDeck,
  createNote, createNotes, updateNote, softDeleteNote, applyReview, undoReview,
  enableReverseCards, moveNote, setNoteSuspended, setNotesSuspended, restoreCardsSuspended,
  restoreNote, setNotesSuspendedUndoable, StaleCardError,
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

  it('畫面上的那份已經過期(別台複習過、同步拉下來了)就不寫,丟 StaleCardError', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: false, accent: '' })
    const shown = (await db.cards.where('note_id').equals(note.id).toArray())[0]
    // 同步拉到別台的複習:排程與 updated_at 都變了
    const elsewhere = rate(shown, 4)
    await db.cards.update(shown.id, { ...elsewhere.fields, updated_at: shown.updated_at + 5000 })
    const before = (await db.cards.get(shown.id))!
    const { fields, log } = rate(shown, 1)
    await expect(applyReview(shown, fields, log)).rejects.toBeInstanceOf(StaleCardError)
    expect(await db.cards.get(shown.id)).toEqual(before)
    expect(await db.review_logs.where('card_id').equals(shown.id).count()).toBe(0)
    // 刪掉的卡也一樣
    await db.cards.update(shown.id, { deleted: 1 })
    const fresh = (await db.cards.get(shown.id))!
    await expect(applyReview(fresh, fields, log)).rejects.toBeInstanceOf(StaleCardError)
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

describe('suspended:已經會了 / 暫停', () => {
  const input = { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: true, accent: '' }

  it('新卡片預設 0(學習中)', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, input)
    for (const c of await db.cards.where('note_id').equals(note.id).toArray()) expect(c.suspended).toBe(0)
  })

  it('setNoteSuspended 把整筆 note 的正反兩張卡一起改,標 dirty、推進 updated_at,並回傳改動前的值', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, input)
    const before = (await db.cards.where('note_id').equals(note.id).toArray())[0].updated_at
    await new Promise((r) => setTimeout(r, 2))
    await db.cards.where('note_id').equals(note.id).modify({ dirty: 0 })

    const prev = await setNoteSuspended(note.id, 2)
    expect(prev.map((p) => p.suspended)).toEqual([0, 0])
    const cards = await db.cards.where('note_id').equals(note.id).toArray()
    expect(cards).toHaveLength(2)
    for (const c of cards) {
      expect(c.suspended).toBe(2)
      expect(c.dirty).toBe(1)
      expect(c.updated_at).toBeGreaterThan(before)
    }
  })

  it('restoreCardsSuspended 寫回原值(可以只還原其中一張),並標 dirty', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, input)
    const prev = await setNoteSuspended(note.id, 1)
    await db.cards.where('note_id').equals(note.id).modify({ dirty: 0 })
    await restoreCardsSuspended(prev)
    for (const c of await db.cards.where('note_id').equals(note.id).toArray()) {
      expect(c.suspended).toBe(0)
      expect(c.dirty).toBe(1)
    }
  })

  it('setNotesSuspended 批次處理多筆,只回報真的改到的卡片數;已刪除的不動', async () => {
    const deck = await createDeck('A')
    const a = await createNote(deck.id, input)                          // 2 張
    const b = await createNote(deck.id, { ...input, reversed: false })  // 1 張
    const c = await createNote(deck.id, { ...input, reversed: false })  // 已刪除
    await softDeleteNote(c.id)
    await setNoteSuspended(b.id, 2) // b 已經是 2
    expect(await setNotesSuspended([a.id, b.id, c.id], 2)).toBe(2)
    expect((await db.cards.where('note_id').equals(c.id).first())!.suspended).toBe(0)
    expect(await setNotesSuspended([a.id, b.id], 0)).toBe(3)
  })

  it('setNotesSuspendedUndoable 回傳改動前的狀態,交給 restoreCardsSuspended 就復原', async () => {
    const deck = await createDeck('A')
    const a = await createNote(deck.id, input)                          // 2 張
    const b = await createNote(deck.id, { ...input, reversed: false })  // 1 張,先擱置
    await setNoteSuspended(b.id, 1)
    const prev = await setNotesSuspendedUndoable([a.id, b.id], 2)
    expect(prev).toHaveLength(3)
    expect(prev.filter((p) => p.suspended === 1)).toHaveLength(1)
    await restoreCardsSuspended(prev)
    for (const c of await db.cards.where('note_id').equals(a.id).toArray()) expect(c.suspended).toBe(0)
    expect((await db.cards.where('note_id').equals(b.id).first())!.suspended).toBe(1)
  })

  it('已經會了的字之後才開反向卡:新的反向卡跟著正向卡的狀態,不會跑回佇列', async () => {
    const deck = await createDeck('A')
    const single = await createNote(deck.id, { ...input, reversed: false })
    await setNoteSuspended(single.id, 2)
    await updateNote(single.id, { reversed: true })
    const rev = (await db.cards.where('note_id').equals(single.id).toArray()).find((c) => c.direction === 'reverse')!
    expect(rev.suspended).toBe(2)

    const other = await createNote(deck.id, { ...input, expression: '猫', reversed: false })
    await setNoteSuspended(other.id, 1)
    await enableReverseCards(deck.id)
    const rev2 = (await db.cards.where('note_id').equals(other.id).toArray()).find((c) => c.direction === 'reverse')!
    expect(rev2.suspended).toBe(1)
  })
})

describe('反向卡復原跟著正向卡的狀態', () => {
  it('先關掉反向卡、把字標成已經會了,再打開反向卡:復原的反向卡也是已經會了', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: true, accent: '' })
    await updateNote(note.id, { reversed: false })
    await setNotesSuspendedUndoable([note.id], 2)
    await updateNote(note.id, { reversed: true })
    const cards = await db.cards.where('note_id').equals(note.id).filter((c) => !c.deleted).toArray()
    expect(cards.map((c) => [c.direction, c.suspended]).sort()).toEqual([['forward', 2], ['reverse', 2]])

    // 整副開啟反向卡也一樣
    await updateNote(note.id, { reversed: false })
    await enableReverseCards(deck.id)
    const again = await db.cards.where('note_id').equals(note.id).filter((c) => !c.deleted).toArray()
    expect(again.every((c) => c.suspended === 2)).toBe(true)
  })
})

describe('restoreNote(刪除後的復原)', () => {
  const word = { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: true, accent: '' }

  it('救回筆記與一起刪掉的卡片,時間戳往前推並標成待同步', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, word)
    await softDeleteNote(note.id)
    const deletedAt = (await db.notes.get(note.id))!.updated_at
    await db.notes.update(note.id, { dirty: 0 })
    await restoreNote(note.id)
    const row = (await db.notes.get(note.id))!
    expect(row.deleted).toBe(0)
    expect(row.dirty).toBe(1)
    expect(row.updated_at).toBeGreaterThan(deletedAt)
    const cards = await db.cards.where('note_id').equals(note.id).toArray()
    expect(cards).toHaveLength(2)
    for (const c of cards) expect(c.deleted).toBe(0)
  })

  it('之前就刪掉的卡(不是這次一起刪的)維持刪除;沒刪的筆記不動', async () => {
    const deck = await createDeck('A')
    const note = await createNote(deck.id, word)
    const rev = (await db.cards.where('note_id').equals(note.id).toArray()).find((c) => c.direction === 'reverse')!
    await db.cards.update(rev.id, { deleted: 1, updated_at: 1 })
    await softDeleteNote(note.id)
    await restoreNote(note.id)
    expect((await db.cards.get(rev.id))!.deleted).toBe(1)

    const other = await createNote(deck.id, { ...word, expression: '猫' })
    const before = (await db.notes.get(other.id))!.updated_at
    await restoreNote(other.id)
    expect((await db.notes.get(other.id))!.updated_at).toBe(before)
  })
})
