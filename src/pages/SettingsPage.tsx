import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { exportBackup, importBackup } from '../lib/backup'
import { download } from '../lib/download'
import { syncNow } from '../lib/sync'
import { getSyncSpace, setSyncSpace, clearLocalData } from '../lib/space'
import { useBusy } from '../lib/useBusy'

export default function SettingsPage() {
  const lastSync = useLiveQuery(() => db.meta.get('last_sync_at'), [])
  const currentSpace = useLiveQuery(() => getSyncSpace(), [])
  const [msg, setMsg] = useState('')
  const [keyInput, setKeyInput] = useState<string | null>(null)
  // 三個動作共用一把鎖:其中兩個會清空本機資料,不該在另一個跑到一半時插隊
  const [busy, run] = useBusy()

  const doSync = () => run(async () => {
    setMsg('同步中…')
    const r = await syncNow()
    setMsg(r.ok ? '✓ 同步完成' : r.skipped ? '目前離線,已跳過' : `同步失敗:${r.error}`)
  })

  const saveKey = () => run(async () => {
    const key = (keyInput ?? currentSpace ?? '').trim()
    if (key !== (currentSpace ?? '') &&
        !confirm('換金鑰會先清空本機資料(雲端不受影響),再以新金鑰重新同步。確定?')) return
    await setSyncSpace(key)
    setKeyInput(null)
    setMsg('金鑰已更新,同步中…')
    const r = await syncNow()
    setMsg(r.ok ? '✓ 已切換空間並同步完成' : r.skipped ? '金鑰已更新(目前離線)' : `同步失敗:${r.error}`)
  })

  const doClearLocal = () => run(async () => {
    if (!confirm('清空本機所有牌組/卡片/複習紀錄(雲端不受影響),之後可用目前金鑰重新同步取回。確定?')) return
    await clearLocalData()
    setMsg('本機已清空,重新同步中…')
    const r = await syncNow()
    setMsg(r.ok ? '✓ 已清空並重新同步' : r.skipped ? '本機已清空(目前離線)' : `同步失敗:${r.error}`)
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
        <button className="btn" disabled={busy} onClick={() => void doSync()}>立即同步</button>
        {msg && <p>{msg}</p>}
      </div>

      <h2>同步金鑰</h2>
      <div className="settings-block">
        <label>金鑰(空白 = 預設空間)
          <input value={keyInput ?? currentSpace ?? ''} placeholder="例如一串不好猜的字"
            onChange={(e) => setKeyInput(e.target.value)} />
        </label>
        <div className="form-actions">
          <button className="btn" disabled={busy} onClick={() => void saveKey()}>儲存金鑰</button>
          <button className="btn danger" disabled={busy} onClick={() => void doClearLocal()}>清空本機資料</button>
        </div>
        <p className="hint">
          不同金鑰 = 不同的獨立資料空間,可分給朋友各自使用。
          金鑰形同該空間的密碼、經公開網路傳送,並非登入驗證 —— 請用不同且不好猜的金鑰。
          換金鑰時會自動先清空本機(雲端不受影響)再重新同步,以確保各空間隔離。
        </p>
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
