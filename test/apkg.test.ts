import { describe, it, expect } from 'vitest'
import { zipSync } from 'fflate'
import { zstdCompressSync } from 'node:zlib'
import initSqlJs from 'sql.js'
import { parseApkg } from '../src/lib/apkg'

const SEP = '\u001f'

const loadSql = () => initSqlJs({
  locateFile: (f: string) => new URL(`../node_modules/sql.js/dist/${f}`, import.meta.url).pathname,
})

async function newDb() {
  const SQL = await loadSql()
  return new SQL.Database()
}

/** schema 11:notetype 與 deck 都放在 col 這一列的 JSON 欄位裡 */
async function legacyDbBytes(): Promise<Uint8Array> {
  const db = await newDb()
  db.run(`
    CREATE TABLE col (id integer primary key, crt integer, models text, decks text);
    CREATE TABLE notes (id integer primary key, mid integer, flds text, sfld text);
    CREATE TABLE cards (id integer primary key, nid integer, did integer, odid integer);
  `)
  const models = {
    '1500000000000': { name: '日本語', flds: [{ name: 'Reading', ord: 1 }, { name: 'Expression', ord: 0 }, { name: 'Meaning', ord: 2 }] },
  }
  const decks = { '1600000000000': { name: 'Core::Stage1' } }
  db.run('INSERT INTO col VALUES (1, 0, ?, ?)', [JSON.stringify(models), JSON.stringify(decks)])
  db.run('INSERT INTO notes VALUES (?, ?, ?, ?)', [11, 1500000000000, ['食べる', 'たべる', '吃'].join(SEP), '食べる'])
  db.run('INSERT INTO notes VALUES (?, ?, ?, ?)', [12, 1500000000000, ['飲む', 'のむ', '喝'].join(SEP), '飲む'])
  db.run('INSERT INTO cards VALUES (1, 11, 1600000000000, 0)')
  db.run('INSERT INTO cards VALUES (2, 12, 1600000000000, 0)')
  const bytes = db.export()
  db.close()
  return bytes
}

/** schema 18:notetypes/fields/decks 各自成表,名稱是純文字欄位 */
async function modernDbBytes(): Promise<Uint8Array> {
  const db = await newDb()
  db.run(`
    CREATE TABLE notetypes (id integer primary key, name text, config blob);
    CREATE TABLE fields (ntid integer, ord integer, name text, config blob, primary key (ntid, ord));
    CREATE TABLE decks (id integer primary key, name text, common blob, kind blob);
    CREATE TABLE notes (id integer primary key, mid integer, flds text, sfld text);
    CREATE TABLE cards (id integer primary key, nid integer, did integer, odid integer);
  `)
  db.run("INSERT INTO notetypes VALUES (1500000000000, '日本語', x'00')")
  db.run("INSERT INTO notetypes VALUES (1500000000001, 'Basic', x'00')")
  for (const [ord, name] of [[0, 'Expression'], [1, 'Reading'], [2, 'Meaning']] as [number, string][]) {
    db.run('INSERT INTO fields VALUES (?, ?, ?, ?)', [1500000000000, ord, name, new Uint8Array()])
  }
  db.run('INSERT INTO fields VALUES (?, ?, ?, ?)', [1500000000001, 0, 'Front', new Uint8Array()])
  db.run('INSERT INTO fields VALUES (?, ?, ?, ?)', [1500000000001, 1, 'Back', new Uint8Array()])
  // 新版把巢狀牌組名以 0x1f 相接,不是 ::
  db.run('INSERT INTO decks VALUES (?, ?, ?, ?)', [1600000000000, ['Core', 'Stage1'].join(SEP), new Uint8Array(), new Uint8Array()])
  db.run('INSERT INTO notes VALUES (?, ?, ?, ?)', [11, 1500000000000, ['食べる', 'たべる', '吃'].join(SEP), '食べる'])
  db.run('INSERT INTO notes VALUES (?, ?, ?, ?)', [12, 1500000000000, ['飲む', 'のむ', '喝'].join(SEP), '飲む'])
  db.run('INSERT INTO notes VALUES (?, ?, ?, ?)', [13, 1500000000001, ['A', 'B'].join(SEP), 'A'])
  for (const [id, nid] of [[1, 11], [2, 12], [3, 13]]) {
    db.run('INSERT INTO cards VALUES (?, ?, ?, ?)', [id, nid, 1600000000000, 0])
  }
  const bytes = db.export()
  db.close()
  return bytes
}

/** Anki 每次匯出都會附一份只有提示訊息的假 collection.anki2 */
async function dummyAnki2Bytes(): Promise<Uint8Array> {
  const db = await newDb()
  db.run(`
    CREATE TABLE col (id integer primary key, crt integer, models text, decks text);
    CREATE TABLE notes (id integer primary key, mid integer, flds text, sfld text);
    CREATE TABLE cards (id integer primary key, nid integer, did integer, odid integer);
  `)
  const models = { '1': { name: 'Basic', flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }] } }
  db.run('INSERT INTO col VALUES (1, 0, ?, ?)', [JSON.stringify(models), '{}'])
  db.run('INSERT INTO notes VALUES (?, ?, ?, ?)', [1, 1, ['Please update Anki', ''].join(SEP), 'Please update Anki'])
  const bytes = db.export()
  db.close()
  return bytes
}

describe('parseApkg', () => {
  it('讀得出舊版 collection.anki2 的欄位名(依 ord 排序)與 notes', async () => {
    const apkg = zipSync({ 'collection.anki2': await legacyDbBytes(), media: new Uint8Array() })
    const parsed = await parseApkg(apkg, loadSql)

    expect(parsed.notetypes).toHaveLength(1)
    expect(parsed.notetypes[0].name).toBe('日本語')
    expect(parsed.notetypes[0].fieldNames).toEqual(['Expression', 'Reading', 'Meaning'])
    expect(parsed.notetypes[0].noteCount).toBe(2)
    expect(parsed.notes.map((n) => n.fields)).toEqual([
      ['食べる', 'たべる', '吃'],
      ['飲む', 'のむ', '喝'],
    ])
    expect(parsed.deckName).toBe('Core::Stage1')
  })

  it('讀新版 collection.anki21b(zstd)而不是同一包裡的假 collection.anki2', async () => {
    const apkg = zipSync({
      'collection.anki21b': zstdCompressSync(await modernDbBytes()),
      'collection.anki2': await dummyAnki2Bytes(),
      meta: new Uint8Array([8, 3]),
    })
    const parsed = await parseApkg(apkg, loadSql)

    expect(parsed.notes).toHaveLength(3)
    expect(parsed.notes.some((n) => n.fields[0] === 'Please update Anki')).toBe(false)
    expect(parsed.notetypes.map((t) => [t.name, t.noteCount])).toEqual([['日本語', 2], ['Basic', 1]])
    expect(parsed.notetypes[0].fieldNames).toEqual(['Expression', 'Reading', 'Meaning'])
  })

  it('新版牌組名的 0x1f 分隔符轉成 ::', async () => {
    const apkg = zipSync({
      'collection.anki21b': zstdCompressSync(await modernDbBytes()),
      'collection.anki2': await dummyAnki2Bytes(),
    })
    expect((await parseApkg(apkg, loadSql)).deckName).toBe('Core::Stage1')
  })

  it('勾了「支援舊版」時讀 collection.anki21,不讀假的 collection.anki2', async () => {
    const apkg = zipSync({
      'collection.anki21': await legacyDbBytes(),
      'collection.anki2': await dummyAnki2Bytes(),
    })
    const parsed = await parseApkg(apkg, loadSql)
    expect(parsed.notes).toHaveLength(2)
    expect(parsed.notetypes[0].name).toBe('日本語')
  })

  it('note 欄位數多於 notetype 定義時,以序號補上欄位名', async () => {
    const db = await newDb()
    db.run(`
      CREATE TABLE col (id integer primary key, crt integer, models text, decks text);
      CREATE TABLE notes (id integer primary key, mid integer, flds text, sfld text);
    `)
    db.run('INSERT INTO col VALUES (1, 0, ?, ?)', [
      JSON.stringify({ '7': { name: 'Old', flds: [{ name: 'Front', ord: 0 }] } }), '{}',
    ])
    db.run('INSERT INTO notes VALUES (?, ?, ?, ?)', [1, 7, ['a', 'b', 'c'].join(SEP), 'a'])
    const bytes = db.export()
    db.close()

    const parsed = await parseApkg(zipSync({ 'collection.anki2': bytes }), loadSql)
    expect(parsed.notetypes[0].fieldNames).toEqual(['Front', '欄位 2', '欄位 3'])
  })

  it('沒有 collection 檔時給明確錯誤', async () => {
    const apkg = zipSync({ media: new Uint8Array([1, 2, 3]) })
    await expect(parseApkg(apkg, loadSql)).rejects.toThrow('找不到 collection 資料')
  })

  it('不是 zip 時給明確錯誤', async () => {
    await expect(parseApkg(new Uint8Array([1, 2, 3, 4, 5]), loadSql)).rejects.toThrow('無法解開壓縮檔')
  })
})
