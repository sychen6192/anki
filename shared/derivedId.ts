// 換 id 時的新 id 怎麼算:用戶端(換 id)與伺服器(認出空間裡已經有換過 id 的那一筆)共用,兩邊才算得一樣。

/** bryc 的 cyrb128:簡單的 128 位元字串雜湊(非加密用途),同步算得出來,可以在 Dexie 交易裡用 */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

/**
 * 換 id 時的新 id:由(要進去的空間,舊 id)算出來,不是亂數。好幾台裝置把同一批別的空間的資料
 * (例如同一份備份)帶進同一個空間,換出來的 id 一樣,就會照 updated_at 合併成一份,而不是每台各一份。
 * 伺服器也拿它認出「這一筆在空間裡已經是換過 id 的那一筆」(見 worker 的 findTaken)。
 */
export function derivedId(space: string, oldId: string): string {
  const hex = cyrb128(`${space}\u0000${oldId}`).map((x) => x.toString(16).padStart(8, '0')).join('')
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
