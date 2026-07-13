import 'fake-indexeddb/auto'
import { beforeEach, describe, it, expect } from 'vitest'
import { db } from '../src/db/db'
import { createDeck, createNote } from '../src/db/repo'
import { exportBackup, importBackup } from '../src/lib/backup'

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('backup', () => {
  it('匯出→清空→還原 roundtrip,還原後全部 dirty=1 且 cursor 歸零', async () => {
    const deck = await createDeck('A')
    await createNote(deck.id, { expression: '犬', reading: 'いぬ', meaning: '狗', reversed: true })
    await db.meta.put({ key: 'sync_cursor', value: 42 })
    const json = await exportBackup()

    await db.delete(); await db.open()
    await importBackup(json)

    expect(await db.decks.count()).toBe(1)
    expect(await db.notes.count()).toBe(1)
    expect(await db.cards.count()).toBe(2)
    for (const c of await db.cards.toArray()) expect(c.dirty).toBe(1)
    expect(await db.meta.get('sync_cursor')).toBeUndefined()
  })

  it('不支援的版本丟錯誤', async () => {
    await expect(importBackup('{"version":99}')).rejects.toThrow('不支援')
  })
})
