import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { exportBackup, importBackup } from '../lib/backup'
import { download } from '../lib/download'
import { requestSync, syncNow } from '../lib/sync'
import { generateSyncKey, getSyncSpace, setSyncSpace, clearLocalData } from '../lib/space'
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme'
import { applyFsrsSettings } from '../lib/fsrs'
import { clampRetention, getFsrsSettings, saveFsrsSettings, MAX_RETENTION_PCT, MIN_RETENTION_PCT } from '../lib/fsrsSettings'
import { buildTrainingSet, optimizeParameters, MIN_REVIEWS_TO_OPTIMIZE, RECOMMENDED_REVIEWS } from '../lib/fsrsOptimizer'

const THEME_LABELS: Record<ThemePref, string> = { system: '跟隨系統', light: '淺色', dark: '深色' }
import { useBusy } from '../lib/useBusy'

/** SyncResult 轉人話;skipped 的各種原因分開講 */
function syncMessage(r: { ok: boolean; reason?: string; error?: string }, okText: string): string {
  if (r.ok) return okText
  if (r.reason === 'local-only') return '沒設金鑰,資料只存在這台裝置 —— 按「產生一組」再儲存就會開始同步'
  if (r.reason === 'offline') return '目前離線,已跳過'
  return `同步失敗:${r.error}`
}

export default function SettingsPage() {
  const lastSync = useLiveQuery(() => db.meta.get('last_sync_at'), [])
  const syncError = useLiveQuery(() => db.meta.get('sync_error'), [])
  const currentSpace = useLiveQuery(() => getSyncSpace(), [])
  const [msg, setMsg] = useState('')
  const [keyInput, setKeyInput] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [autoSpeak, setAutoSpeak] = useState(() => localStorage.getItem('auto-speak') === '1')
  const [theme, setTheme] = useState<ThemePref>(() => getThemePref())
  const fsrs = useLiveQuery(() => getFsrsSettings(), [])
  const logCount = useLiveQuery(() => db.review_logs.count(), [])
  const [retentionInput, setRetentionInput] = useState<string | null>(null)
  const [fsrsMsg, setFsrsMsg] = useState('')
  // 這頁的動作共用一把鎖:清空本機、還原備份、最佳化參數都跑得久,不該在另一個跑到一半時插隊
  const [busy, run] = useBusy()

  const saveRetention = () => run(async () => {
    if (fsrs === undefined) return
    const pct = Number(retentionInput ?? Math.round(fsrs.desired_retention * 100))
    if (!Number.isFinite(pct)) { setFsrsMsg(`請輸入 ${MIN_RETENTION_PCT}–${MAX_RETENTION_PCT} 的數字`); return }
    const next = { ...fsrs, desired_retention: clampRetention(pct / 100) }
    await saveFsrsSettings(next)
    applyFsrsSettings(next)
    setRetentionInput(null)
    setFsrsMsg(`✓ 目標保持率已設為 ${Math.round(next.desired_retention * 100)}%`)
    requestSync()
  })

  const optimize = () => run(async () => {
    if (fsrs === undefined) return
    try {
      setFsrsMsg('整理複習紀錄…')
      const set = buildTrainingSet(await db.review_logs.toArray())
      if (set.items === 0) { setFsrsMsg('紀錄裡還沒有跨天的複習,沒東西可以學'); return }
      setFsrsMsg('最佳化中…')
      const w = await optimizeParameters(set, (done, total) => {
        if (total > 0) setFsrsMsg(`最佳化中… ${Math.min(100, Math.round((done / total) * 100))}%`)
      })
      const next = { ...fsrs, w, optimized_at: Date.now(), optimized_reviews: set.reviews }
      await saveFsrsSettings(next)
      applyFsrsSettings(next)
      setFsrsMsg(`✓ 完成:用了 ${set.reviews} 筆紀錄、${set.items} 個樣本,新參數已存檔並同步`)
      requestSync()
    } catch (e) {
      setFsrsMsg(`最佳化失敗:${e instanceof Error ? e.message : String(e)}`)
    }
  })

  const resetParams = () => run(async () => {
    if (fsrs === undefined || !confirm('換回預設參數?之後隨時可以再最佳化。')) return
    const next = { ...fsrs, w: null, optimized_at: null, optimized_reviews: 0 }
    await saveFsrsSettings(next)
    applyFsrsSettings(next)
    setFsrsMsg('已換回預設參數')
    requestSync()
  })

  const doSync = () => run(async () => {
    setMsg('同步中…')
    const r = await syncNow()
    setMsg(syncMessage(r, '✓ 同步完成'))
  })

  const saveKey = () => run(async () => {
    const key = (keyInput ?? currentSpace ?? '').trim()
    if (key !== (currentSpace ?? '') &&
        !confirm('換金鑰會先清空本機資料(雲端不受影響),再以新金鑰重新同步。確定?')) return
    await setSyncSpace(key)
    setKeyInput(null)
    setMsg('金鑰已更新,同步中…')
    const r = await syncNow()
    setMsg(r.ok ? '✓ 已切換空間並同步完成'
      : r.reason === 'offline' ? '金鑰已更新(目前離線)' : syncMessage(r, ''))
  })

  const doClearLocal = () => run(async () => {
    if (!confirm('清空本機所有牌組/卡片/複習紀錄(雲端不受影響),之後可用目前金鑰重新同步取回。確定?')) return
    await clearLocalData()
    setMsg('本機已清空,重新同步中…')
    const r = await syncNow()
    setMsg(r.ok ? '✓ 已清空並重新同步'
      : r.reason === 'offline' ? '本機已清空(目前離線)' : syncMessage(r, ''))
  })

  const restoreBackup = (file: File) => run(async () => {
    if (!confirm('還原會清空本機資料,並在下次同步時以備份內容覆蓋雲端與其他裝置,確定?')) return
    try {
      await importBackup(await file.text())
      setMsg('✓ 還原完成,建議立即同步')
    } catch (err) {
      setMsg(`還原失敗:${err instanceof Error ? err.message : String(err)}`)
    }
  })

  return (
    <div>
      <h1>設定</h1>
      <h2>同步</h2>
      <div className="settings-block">
        <p className="hint">
          上次同步:{lastSync ? new Date(lastSync.value).toLocaleString('zh-TW') : '從未'}
        </p>
        {syncError !== undefined && (
          <p className="err" role="alert">上次同步失敗:{String(syncError.value)}</p>
        )}
        <button className="btn" disabled={busy} onClick={() => void doSync()}>立即同步</button>
        {msg && <p role="status" aria-live="polite">{msg}</p>}
      </div>

      <h2>同步金鑰</h2>
      <div className="settings-block">
        {currentSpace === '' && (
          <p className="notice">
            目前<b>只存在這台裝置</b>,不會同步到雲端。按「產生一組」再儲存,就有自己的空間。
          </p>
        )}
        <label>金鑰(空白 = 只存本機,不同步)
          <span className="key-field">
            <input type={showKey ? 'text' : 'password'} autoComplete="off"
              value={keyInput ?? currentSpace ?? ''} placeholder="例如一串不好猜的字"
              onChange={(e) => setKeyInput(e.target.value)} />
            <button type="button" className="link" onClick={() => setShowKey(!showKey)}>
              {showKey ? '隱藏' : '顯示'}
            </button>
          </span>
        </label>
        <div className="form-actions">
          <button type="button" className="btn secondary" disabled={busy}
            onClick={() => { setKeyInput(generateSyncKey()); setShowKey(true) }}>產生一組</button>
          <button className="btn" disabled={busy} onClick={() => void saveKey()}>儲存金鑰</button>
          <button className="btn danger" disabled={busy} onClick={() => void doClearLocal()}>清空本機資料</button>
        </div>
        <p className="hint">
          一組金鑰 = 一個獨立空間;多台裝置填同一組會同步到一起,記得抄下來。
          金鑰就是這個空間的密碼,別用好猜的。換金鑰會先清空本機(雲端不動)再重新同步。
          清成空白則回到只存本機,雲端那份不會被刪,填回同一組金鑰就能取回。
        </p>
      </div>

      <h2>外觀</h2>
      <div className="settings-block">
        <div className="tabs">
          {(['system', 'light', 'dark'] as const).map((p) => (
            <button key={p} className={`tab${theme === p ? ' active' : ''}`}
              onClick={() => { setThemePref(p); setTheme(p) }}>{THEME_LABELS[p]}</button>
          ))}
        </div>
      </div>

      <h2>複習</h2>
      <div className="settings-block">
        <label className="check-row">
          <input type="checkbox" checked={autoSpeak} onChange={(e) => {
            setAutoSpeak(e.target.checked)
            localStorage.setItem('auto-speak', e.target.checked ? '1' : '0')
          }} /> 翻面自動唸讀音
        </label>
      </div>

      <h2>FSRS 排程</h2>
      <div className="settings-block">
        <label>目標保持率(到期時大約記得的比例)
          <span className="key-field">
            <input type="number" min={MIN_RETENTION_PCT} max={MAX_RETENTION_PCT} step={1} inputMode="numeric"
              value={retentionInput ?? (fsrs === undefined ? '' : Math.round(fsrs.desired_retention * 100))}
              onChange={(e) => setRetentionInput(e.target.value)} />
            <span>%</span>
            <button className="btn" disabled={busy || fsrs === undefined} onClick={() => void saveRetention()}>儲存</button>
          </span>
        </label>
        <p className="hint">
          預設 90%。調高:複習更頻繁、忘得少;調低:複習量少、忘得多。統計頁的「真實保持率」可以對照有沒有達到。
        </p>
        <p className="hint">
          參數:{fsrs === undefined ? '…' : fsrs.w === null
            ? '預設(還沒用自己的紀錄最佳化過)'
            : `已最佳化 · ${fsrs.optimized_at === null ? '' : new Date(fsrs.optimized_at).toLocaleDateString('zh-TW')} · 基於 ${fsrs.optimized_reviews} 筆複習`}
        </p>
        <div className="form-actions">
          <button className="btn" disabled={busy || fsrs === undefined || (logCount ?? 0) < MIN_REVIEWS_TO_OPTIMIZE}
            onClick={() => void optimize()}>用我的複習紀錄最佳化參數</button>
          {fsrs !== undefined && fsrs.w !== null && (
            <button className="btn secondary" disabled={busy} onClick={() => void resetParams()}>還原預設參數</button>
          )}
        </div>
        <p className="hint">
          目前 {logCount ?? 0} 筆複習紀錄。至少 {MIN_REVIEWS_TO_OPTIMIZE} 筆才能跑,{RECOMMENDED_REVIEWS} 筆以上結果比較穩;
          之後每累積一陣子再跑一次。會在背景佔滿 CPU 幾秒到一分鐘,參數存好會同步到其他裝置。
        </p>
        {fsrsMsg && <p role="status" aria-live="polite">{fsrsMsg}</p>}
      </div>

      <h2>備份</h2>
      <div className="settings-block">
        <button className="btn secondary" onClick={async () =>
          download(`字卡備份-${new Date().toISOString().slice(0, 10)}.json`, await exportBackup(), 'application/json')
        }>下載完整備份(JSON)</button>
        <label>還原備份:
          <input type="file" accept="application/json" disabled={busy} onChange={(e) => {
            const f = e.target.files?.[0]
            // 清掉選檔紀錄,否則選同一個檔案第二次不會觸發 change
            e.target.value = ''
            if (f) void restoreBackup(f)
          }} />
        </label>
      </div>
    </div>
  )
}
