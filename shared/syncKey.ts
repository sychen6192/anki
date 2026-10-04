// 同步金鑰的格式,用戶端(產生、正規化)與伺服器(驗證)共用一份,兩邊才不會對「合不合格」看法不同。

/** 金鑰的字母表:拿掉易混淆的 i/l/o/0/1,好唸好抄 */
export const SYNC_KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

const GROUP = `[${SYNC_KEY_ALPHABET}]{4}`
const STANDARD = new RegExp(`^${GROUP}-${GROUP}-${GROUP}$`)

/**
 * 是不是產生器產生的格式(xxxx-xxxx-xxxx,12 字 × 31 種 ≈ 2^59,猜不到)。
 * 舊版可以自訂任意字串(例如 test、1234),那種一猜就中 —— 伺服器只讓它們繼續用已經有資料的空間,
 * 不能再拿來開新空間(見 worker/index.ts 的 checkSpace)。
 */
export function isStandardSyncKey(key: string): boolean {
  return STANDARD.test(key)
}
