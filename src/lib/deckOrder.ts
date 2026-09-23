import type { DeckRecord } from '../../shared/types'

const collator = new Intl.Collator('zh-Hant', { numeric: true })

/**
 * 牌組一律依名稱排。主鍵是隨機 id,照資料庫的順序等於亂排:新加的範本可能插在最上面,
 * 跨牌組複習先出哪一副的新卡也跟著亂數走。首頁、下拉選單、跨牌組複習都用這個順序。
 */
export function sortDecks<T extends Pick<DeckRecord, 'name'>>(decks: readonly T[]): T[] {
  return [...decks].sort((a, b) => collator.compare(a.name, b.name))
}
