import { describe, it, expect } from 'vitest'
import { setupServiceWorker, type SwDeps, type SwRegistration, type SwWorker } from '../src/lib/sw'

function fakeWorker(state = 'installing'): SwWorker & { fire: () => void; posted: unknown[] } {
  const listeners: (() => void)[] = []
  const posted: unknown[] = []
  return {
    state,
    posted,
    postMessage: (m) => posted.push(m),
    addEventListener: (_t, fn) => listeners.push(fn),
    fire: () => listeners.forEach((l) => l()),
  }
}

function fakeReg(opts: { updateFails?: boolean } = {}): SwRegistration & { fireUpdateFound: () => void; setInstalling: (w: SwWorker | null) => void; setWaiting: (w: SwWorker | null) => void; updateCalls: () => number } {
  const updateFound: (() => void)[] = []
  let updateCalls = 0
  const reg = {
    waiting: null as SwWorker | null,
    installing: null as SwWorker | null,
    update: () => {
      updateCalls += 1
      return opts.updateFails ? Promise.reject(new Error('offline')) : Promise.resolve()
    },
    addEventListener: (_t: 'updatefound', fn: () => void) => updateFound.push(fn),
    fireUpdateFound: () => updateFound.forEach((l) => l()),
    setInstalling: (w: SwWorker | null) => { reg.installing = w },
    setWaiting: (w: SwWorker | null) => { reg.waiting = w },
    updateCalls: () => updateCalls,
  }
  return reg
}

function harness(opts: { hasController: boolean; reg: SwRegistration | null }) {
  const controllerChange: (() => void)[] = []
  const checkTriggers: (() => void)[] = []
  const state = { reloads: 0, updateReadyCalls: 0, apply: null as (() => void) | null }
  const deps: SwDeps = {
    hasController: () => opts.hasController,
    register: () => Promise.resolve(opts.reg),
    onControllerChange: (fn) => controllerChange.push(fn),
    reload: () => { state.reloads += 1 },
    onUpdateReady: (apply) => { state.updateReadyCalls += 1; state.apply = apply },
    onCheckForUpdates: (fn) => checkTriggers.push(fn),
  }
  return {
    deps, state,
    fireControllerChange: () => controllerChange.forEach((l) => l()),
    fireCheck: () => checkTriggers.forEach((l) => l()),
    checkTriggerCount: () => checkTriggers.length,
  }
}

describe('setupServiceWorker(prompt 更新流程)', () => {
  it('第一次安裝時的 controllerchange 不重載', async () => {
    const { deps, state, fireControllerChange } = harness({ hasController: false, reg: fakeReg() })
    await setupServiceWorker(deps)
    fireControllerChange()
    expect(state.reloads).toBe(0)
    expect(state.updateReadyCalls).toBe(0)
  })

  it('開頁時已有等待中的新版 → 通知 UI,尚未重載', async () => {
    const reg = fakeReg()
    reg.setWaiting(fakeWorker('installed'))
    const { deps, state } = harness({ hasController: true, reg })
    await setupServiceWorker(deps)
    expect(state.updateReadyCalls).toBe(1)
    expect(state.reloads).toBe(0)
  })

  it('複習中裝好新版:偵測到等待中的版本並通知,但不打斷', async () => {
    const reg = fakeReg()
    const { deps, state } = harness({ hasController: true, reg })
    await setupServiceWorker(deps)
    expect(state.updateReadyCalls).toBe(0) // 一開始沒有等待中的版本

    const installing = fakeWorker('installing')
    reg.setInstalling(installing)
    reg.fireUpdateFound()
    reg.setWaiting(installing)
    installing.state = 'installed'
    installing.fire() // statechange → installed

    expect(state.updateReadyCalls).toBe(1)
    expect(state.reloads).toBe(0)
  })

  it('使用者套用更新:postMessage(SKIP_WAITING),接手後才重載', async () => {
    const reg = fakeReg()
    const waiting = fakeWorker('installed')
    reg.setWaiting(waiting)
    const { deps, state, fireControllerChange } = harness({ hasController: true, reg })
    await setupServiceWorker(deps)

    expect(state.reloads).toBe(0)
    state.apply!() // 使用者按下「更新」
    expect(waiting.posted).toEqual([{ type: 'SKIP_WAITING' }])
    expect(state.reloads).toBe(0) // 還沒接手

    fireControllerChange() // 新版接手
    expect(state.reloads).toBe(1)
  })

  it('沒有 registration(不支援/註冊失敗)時安靜結束', async () => {
    const { deps, state } = harness({ hasController: false, reg: null })
    await setupServiceWorker(deps)
    expect(state.updateReadyCalls).toBe(0)
    expect(state.reloads).toBe(0)
  })

  // 部署新版後,長時間開著的頁面(手機 PWA 常態)只靠瀏覽器導航時的檢查
  // 永遠等不到更新 —— 環境要能主動喊「檢查一下」,這時得真的去問伺服器。
  it('環境觸發更新檢查時 → 呼叫 registration.update()', async () => {
    const reg = fakeReg()
    const h = harness({ hasController: true, reg })
    await setupServiceWorker(h.deps)
    expect(reg.updateCalls()).toBe(0)
    h.fireCheck()
    expect(reg.updateCalls()).toBe(1)
    h.fireCheck()
    expect(reg.updateCalls()).toBe(2)
  })

  it('update() 失敗(例如離線)不往外拋', async () => {
    const reg = fakeReg({ updateFails: true })
    const h = harness({ hasController: true, reg })
    await setupServiceWorker(h.deps)
    h.fireCheck()
    expect(reg.updateCalls()).toBe(1)
    await new Promise((r) => setTimeout(r, 0)) // 讓 rejection 有機會浮出來;不該有 unhandled
  })

  it('註冊失敗時不註冊更新檢查', async () => {
    const h = harness({ hasController: false, reg: null })
    await setupServiceWorker(h.deps)
    expect(h.checkTriggerCount()).toBe(0)
  })
})
