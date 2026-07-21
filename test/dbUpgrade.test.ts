import 'fake-indexeddb/auto'
import { beforeEach, describe, it, expect } from 'vitest'
import Dexie from 'dexie'

const V1_STORES = {
  decks: 'id, dirty',
  notes: 'id, deck_id, dirty',
  cards: 'id, note_id, deck_id, due, dirty',
  review_logs: 'id, card_id, reviewed_at, dirty',
  meta: 'key',
}

/** 建一個 accent 功能之前的舊資料庫(schema v1),裡面的 note 沒有 accent 欄 */
async function seedV1(notes: Record<string, unknown>[]) {
  const v1 = new Dexie('anki-pwa')
  v1.version(1).stores(V1_STORES)
  await v1.open()
  await v1.table('notes').bulkAdd(notes)
  v1.close()
}

beforeEach(async () => {
  await Dexie.delete('anki-pwa')
})

describe('Dexie schema v1 → v2 升級', () => {
  it('舊 note 沒有 accent 欄時補成空字串,其餘欄位原封不動', async () => {
    await seedV1([{
      id: 'n1', deck_id: 'd1', expression: '犬', reading: 'いぬ', meaning: '狗',
      reversed: 0, updated_at: 123, deleted: 0, dirty: 1,
    }])

    const { db } = await import('../src/db/db')
    await db.open()
    const note = await db.notes.get('n1')

    expect(note!.accent).toBe('')
    expect(note!.expression).toBe('犬')
    expect(note!.reading).toBe('いぬ')
    expect(note!.updated_at).toBe(123)
    expect(note!.dirty).toBe(1)
    db.close()
  })

  it('升級當下已經帶 accent 的資料不會被清掉', async () => {
    await seedV1([{
      id: 'n1', deck_id: 'd1', expression: '橋', reading: 'はし', meaning: '橋',
      accent: '2', reversed: 0, updated_at: 1, deleted: 0, dirty: 0,
    }])

    const { db } = await import('../src/db/db')
    await db.open()
    expect((await db.notes.get('n1'))!.accent).toBe('2')
    db.close()
  })
})
