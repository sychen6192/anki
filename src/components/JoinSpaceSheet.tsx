import { useState } from 'react'
import { Sheet } from './Sheet'
import { useBusy } from '../lib/useBusy'
import { countLocalContents, leaveSyncSpace, normalizeSyncKey, setSyncSpace } from '../lib/space'
import { syncNow } from '../lib/sync'
import { syncMessage } from '../lib/syncText'

type Outcome = { kind: 'empty' } | { kind: 'error'; text: string } | null

/**
 * 「在別台用過字卡」:首頁(這台還沒有牌組)直接輸入金鑰,不必繞到設定頁。
 * 這台是空的,直接換成那個空間並下載;下載完回報拿到什麼,空的就提醒可能打錯,
 * 不然打錯一碼會連進一個全新的空間,看起來像資料全不見了。
 */
export function JoinSpaceSheet({ open, onClose, onJoined }: {
  open: boolean
  onClose: () => void
  /** 連上之後(message:下載了什麼) */
  onJoined: (message: string) => void
}) {
  const [input, setInput] = useState('')
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [busy, run] = useBusy()
  const { key, standard } = normalizeSyncKey(input)

  const reset = () => { setInput(''); setOutcome(null) }
  const close = () => { reset(); onClose() }

  const join = () => run(async () => {
    if (key === '') return
    setOutcome(null)
    await setSyncSpace(key)
    const r = await syncNow()
    if (!r.ok) {
      setOutcome({ kind: 'error', text: syncMessage(r, '') })
      return
    }
    const c = await countLocalContents()
    if (c.decks === 0) {
      setOutcome({ kind: 'empty' })
      return
    }
    reset()
    onJoined(`已下載 ${c.decks} 副牌組、${c.words} 個字`)
  })

  // 空的空間多半是打錯:回到只存這台,讓人重打
  const retype = () => run(async () => {
    await leaveSyncSpace()
    setOutcome(null)
  })

  const canPaste = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'
  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (text !== '') { setInput(text); setOutcome(null) }
    } catch {
      // 沒給權限就算了,手動貼
    }
  }

  return (
    <Sheet open={open} onClose={close} title="輸入同步金鑰"
      end={<button type="button" className="btn plain strong" disabled={busy || key === '' || outcome?.kind === 'empty'}
        onClick={() => void join()}>{busy ? '連線中…' : '連上'}</button>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (outcome?.kind !== 'empty') void join() }}>
        <p className="hint">在另一台裝置的「設定」→「同步金鑰」可以看到，格式像 abcd-efgh-jkmn。</p>
        <div className="field-row">
          <label className="field"><span className="field-label">同步金鑰</span>
            <input value={input} data-autofocus placeholder="abcd-efgh-jkmn" enterKeyHint="go"
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              onChange={(e) => { setInput(e.target.value); setOutcome(null) }} />
          </label>
          {canPaste && <button type="button" className="btn secondary field-btn" onClick={() => void paste()}>貼上</button>}
        </div>
        {input.trim() !== '' && !standard && (
          <p className="field-hint">這不像字卡產生的金鑰，確定沒打錯？</p>
        )}
        {outcome?.kind === 'error' && <p className="err" role="alert">{outcome.text}</p>}
        {outcome?.kind === 'empty' && (
          <div className="notice" role="alert">
            <span className="notice-text">這組金鑰的空間是空的，確定沒打錯嗎？</span>
            <span className="notice-actions">
              <button type="button" className="link" disabled={busy} onClick={() => void retype()}>重新輸入</button>
              <button type="button" className="link" disabled={busy}
                onClick={() => { reset(); onJoined('已連上，之後的牌組會同步到這組金鑰') }}>就用這組</button>
            </span>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  )
}
