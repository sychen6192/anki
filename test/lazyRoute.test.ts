import { describe, it, expect, vi } from 'vitest'
import { loadChunk, type ReloadDeps } from '../src/lib/lazyRoute'

function fakeDeps(now = 1_000_000, seeded?: string) {
  const store = new Map<string, string>()
  if (seeded !== undefined) store.set('chunk-reload-at', seeded)
  const deps: ReloadDeps & { reloads: number } = {
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v) } },
    reload: () => { deps.reloads += 1 },
    now: () => now,
    reloads: 0,
  }
  return { deps, store }
}

describe('loadChunk', () => {
  it('正常載入時直接回傳,不碰重載', async () => {
    const { deps } = fakeDeps()
    await expect(loadChunk(async () => 'module', deps)).resolves.toBe('module')
    expect(deps.reloads).toBe(0)
  })

  it('chunk 抓不到時重載一次(新版部署後舊檔名已不存在)', async () => {
    const { deps, store } = fakeDeps(1_000_000)
    const load = vi.fn().mockRejectedValue(new Error('Failed to fetch dynamically imported module'))

    // 重載後這個 promise 不該 resolve/reject —— 免得錯誤畫面在換頁前閃一下
    const pending = loadChunk(load, deps)
    const settled = await Promise.race([pending.then(() => 'settled', () => 'settled'), Promise.resolve('pending')])

    expect(deps.reloads).toBe(1)
    expect(settled).toBe('pending')
    expect(store.get('chunk-reload-at')).toBe('1000000')
  })

  it('剛重載過還是失敗時不再重載,把錯誤拋給 ErrorBoundary', async () => {
    // 上次重載發生在 3 秒前(冷卻期內)
    const { deps } = fakeDeps(1_000_000, String(1_000_000 - 3_000))
    const err = new Error('Failed to fetch dynamically imported module')

    await expect(loadChunk(async () => { throw err }, deps)).rejects.toThrow(err)
    expect(deps.reloads).toBe(0)
  })

  it('距離上次重載夠久(例如下一次部署)會再給一次重載機會', async () => {
    const { deps } = fakeDeps(1_000_000, String(1_000_000 - 60_000))
    void loadChunk(async () => { throw new Error('boom') }, deps)
    await Promise.resolve()
    await Promise.resolve()
    expect(deps.reloads).toBe(1)
  })
})
