/** 遇到 429 最多再送幾次 */
const MAX_RETRIES = 3
/** Retry-After 沒給或亂給時等多久;給了也不等超過上限(畫面上的「同步中…」不能一直掛著) */
const DEFAULT_WAIT_SEC = 10
const MAX_WAIT_SEC = 30

/**
 * 伺服器依 IP 限流(見 worker/index.ts 的 limit),超過回 429 + Retry-After。
 * 正常使用碰不到;碰到的多半是一次推很多(例如還原幾萬筆紀錄的備份):照它說的等一下再送同一個請求,
 * 而不是整個同步失敗、掛一個紅點。重送 body 是同一個字串,可以安全重送。
 */
export async function fetchWithRetry(
  fetchFn: typeof fetch, input: RequestInfo | URL, init?: RequestInit,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(input, init)
    if (res.status !== 429 || attempt >= MAX_RETRIES) return res
    const asked = Number(res.headers.get('retry-after'))
    const wait = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_WAIT_SEC) : DEFAULT_WAIT_SEC
    await sleep(wait * 1000)
  }
}
