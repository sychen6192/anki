import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { exportBackup, importBackup } from '../lib/backup'
import { download } from '../lib/download'
import { syncNow } from '../lib/sync'

export default function SettingsPage() {
  const lastSync = useLiveQuery(() => db.meta.get('last_sync_at'), [])
  const [msg, setMsg] = useState('')

  const doSync = async () => {
    setMsg('同步中…')
    const r = await syncNow()
    setMsg(r.ok ? '✓ 同步完成' : r.skipped ? '目前離線,已跳過' : `同步失敗:${r.error}`)
  }

  return (
    <div>
      <h1>設定</h1>
      <h2>同步</h2>
      <div className="settings-block">
        <p className="hint">
          上次同步:{lastSync ? new Date(lastSync.value).toLocaleString('zh-TW') : '從未'}
        </p>
        <button className="btn" onClick={doSync}>立即同步</button>
        {msg && <p>{msg}</p>}
      </div>
      <h2>備份</h2>
      <div className="settings-block">
        <button className="btn secondary" onClick={async () =>
          download(`字卡備份-${new Date().toISOString().slice(0, 10)}.json`, await exportBackup(), 'application/json')
        }>下載完整備份(JSON)</button>
        <label>還原備份:
          <input type="file" accept="application/json" onChange={async (e) => {
            const f = e.target.files?.[0]
            if (!f) return
            if (!confirm('還原會清空本機現有資料再寫入備份內容,確定?')) return
            try {
              await importBackup(await f.text())
              setMsg('✓ 還原完成,建議立即同步')
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              setMsg(`還原失敗:${message}`)
            }
          }} />
        </label>
      </div>
    </div>
  )
}
