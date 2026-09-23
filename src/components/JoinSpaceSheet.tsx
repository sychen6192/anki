import { useRef, useState } from 'react'
import { Sheet } from './Sheet'
import { useBusy } from '../lib/useBusy'
import { countLocalContents, normalizeSyncKey, setSyncSpace } from '../lib/space'
import { countSpaceDecks, syncNow } from '../lib/sync'

type Outcome = { kind: 'empty' } | { kind: 'error'; text: string } | null

/**
 * 「在別台用過字卡」:首頁(這台還沒有牌組)直接輸入金鑰,不必繞到設定頁。
 * 先問伺服器那個空間有沒有東西,確認過才換過去並下載:連不上就什麼都不改(不會留下一組沒驗證過的金鑰);
 * 空的多半是打錯一碼(會連進一個全新的空間,看起來像資料全不見了),先提醒。
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
  // 每次連線編號;面板關掉就作廢還在確認中的那次,確認到一半按「取消」不會又連上
  const attempt = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { key, standard } = normalizeSyncKey(input)

  const reset = () => { setInput(''); setOutcome(null) }
  const close = () => { attempt.current++; reset(); onClose() }

  const join = (evenIfEmpty = false) => run(async () => {
    if (key === '') return
    const mine = ++attempt.current
    setOutcome(null)
    if (!evenIfEmpty) {
      const decks = await countSpaceDecks(key)
      if (mine !== attempt.current) return
      if (decks === null) {
        setOutcome({ kind: 'error', text: '連不上伺服器，這台什麼都沒改。連上網路後再按一次「連上」' })
        return
      }
      if (decks === 0) {
        setOutcome({ kind: 'empty' })
        return
      }
    }
    await setSyncSpace(key)
    const r = await syncNow()
    if (!r.ok) {
      // 金鑰已經確認過(空間裡有東西),只是下載沒完成:留著這組,之後的同步會補完
      setOutcome({ kind: 'error', text: '金鑰沒問題，但下載到一半斷線了；連上網路後會自動下載完' })
      return
    }
    const c = await countLocalContents()
    reset()
    onJoined(c.decks > 0 ? `已下載 ${c.decks} 副牌組、${c.words} 個字` : '已連上，之後的牌組會同步到這組金鑰')
  })

  // 空的空間多半是打錯:什麼都還沒改,回到輸入框重打
  const retype = () => {
    setOutcome(null)
    inputRef.current?.focus()
  }

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
            <input ref={inputRef} value={input} data-autofocus placeholder="abcd-efgh-jkmn" enterKeyHint="go"
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
              <button type="button" className="link" disabled={busy} onClick={retype}>重新輸入</button>
              <button type="button" className="link" disabled={busy} onClick={() => void join(true)}>就用這組</button>
            </span>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  )
}
