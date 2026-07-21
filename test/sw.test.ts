import { describe, it, expect } from 'vitest'
import { setupServiceWorker, type SwDeps } from '../src/lib/sw'

function harness(hadController: boolean) {
  const listeners: (() => void)[] = []
  const state = { registered: 0, reloads: 0 }
  const deps: SwDeps = {
    hadController,
    register: () => { state.registered += 1 },
    onControllerChange: (fn) => { listeners.push(fn) },
    reload: () => { state.reloads += 1 },
  }
  return { deps, state, fireControllerChange: () => { for (const fn of listeners) fn() } }
}

describe('setupServiceWorker', () => {
  it('第一次安裝時 clientsClaim 也會觸發 controllerchange,那次不重載', () => {
    const { deps, state, fireControllerChange } = harness(false)
    setupServiceWorker(deps)
    fireControllerChange()
    expect(state.registered).toBe(1)
    expect(state.reloads).toBe(0)
  })

  it('已有 SW 在控制時換上新版 → 重載,讓 HTML 與新的 precache 對得上', () => {
    const { deps, state, fireControllerChange } = harness(true)
    setupServiceWorker(deps)
    fireControllerChange()
    expect(state.reloads).toBe(1)
  })

  it('重複觸發只重載一次', () => {
    const { deps, state, fireControllerChange } = harness(true)
    setupServiceWorker(deps)
    fireControllerChange()
    fireControllerChange()
    fireControllerChange()
    expect(state.reloads).toBe(1)
  })
})
