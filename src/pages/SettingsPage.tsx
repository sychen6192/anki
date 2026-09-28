import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import Dexie, { type ObservabilitySet } from 'dexie'
import { db } from '../db/db'
import { describeBackup, exportBackup, importBackup, pruneToBackup, type BackupSummary } from '../lib/backup'
import { download } from '../lib/download'
import { fetchSpaceSummary, probeSyncKey, requestSync, syncNow } from '../lib/sync'
import {
  adoptSyncSpace, clearLocalData, countLocalContents, countUnsynced, generateSyncKey, getSyncSpace,
  hasLocalData, leaveSyncSpace, normalizeSyncKey, setSyncSpace,
} from '../lib/space'
import { errorText, humanizeSyncError, syncMessage } from '../lib/syncText'
import { isTouchDevice } from '../lib/share'
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme'
import { applyFsrsSettings } from '../lib/fsrs'
import { readAutoSpeak, writeAutoSpeak } from '../lib/speak'
import { clampRetention, getFsrsSettings, saveFsrsSettings, MAX_RETENTION_PCT, MIN_RETENTION_PCT } from '../lib/fsrsSettings'
import { buildTrainingSet, optimizeParameters, MIN_REVIEWS_TO_OPTIMIZE, RECOMMENDED_REVIEWS } from '../lib/fsrsOptimizer'
import { useBusy } from '../lib/useBusy'
import { PageHeader } from '../components/PageHeader'
import { ListSection, Segmented, Switch } from '../components/controls'
import { ActionSheet, Sheet } from '../components/Sheet'
import { useConfirm } from '../components/Confirm'
import { BookIcon, ChevronRightIcon, DownloadIcon, SyncIcon, UploadIcon } from '../components/icons'
import './settings.css'

const THEME_OPTIONS = [['system', '跟隨系統'], ['light', '淺色'], ['dark', '深色']] as const

function formatWhen(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const time = d.toLocaleTimeString('zh-TW', { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return `今天 ${time}`
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

const maskKey = (key: string) => key.replace(/[^-]/g, '•')

export default function SettingsPage() {
  const lastSync = useLiveQuery(() => db.meta.get('last_sync_at'), [])
  const syncError = useLiveQuery(() => db.meta.get('sync_error'), [])
  const currentSpace = useLiveQuery(() => getSyncSpace(), [])
  const [msg, setMsg] = useState('')
  const [keyOpen, setKeyOpen] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [keyCopied, setKeyCopied] = useState(false)
  // 純本機的人輸入別台的金鑰:本機又有資料時,要問「帶過去」還是「捨棄」
  const [adoptChoice, setAdoptChoice] = useState<string | null>(null)
  const [autoSpeak, setAutoSpeak] = useState(readAutoSpeak)
  const [theme, setTheme] = useState<ThemePref>(() => getThemePref())
  const fsrs = useLiveQuery(() => getFsrsSettings(), [])
  const logCount = useLiveQuery(() => db.review_logs.count(), [])
  const [fsrsMsg, setFsrsMsg] = useState('')
  // 結果寫在按下去的那一區:同步區在頁面最上面,還原備份、清空本機在下面,寫到同步區會捲出畫面外看不到
  const [backupMsg, setBackupMsg] = useState('')
  // 觸控裝置的備份分兩步:iPhone 的分享面板要在點擊的當下叫出來,先等資料庫整理完備份再叫會被擋
  // (主畫面 App 又沒有一般下載可以退),所以先準備好檔案,再讓人按「儲存備份檔」
  const [backupFile, setBackupFile] = useState<{ name: string; text: string; kb: number; at: number } | null>(null)
  const [resetMsg, setResetMsg] = useState('')
  // 這頁的動作共用一把鎖:清空本機、還原備份、最佳化參數都跑得久,不該在另一個跑到一半時插隊
  const [busy, run] = useBusy()
  const confirm = useConfirm()

  // 首頁提示的「已經有金鑰」帶 ?key=1:直接打開金鑰面板
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    if (searchParams.get('key') !== '1') return
    setKeyOpen(true)
    setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams])

  const localOnly = currentSpace === ''
  // 打的就是目前這組(照正規化或照原樣比:舊版自訂的金鑰是原樣存的)
  const isCurrentKey = (input: string) => input.trim() !== ''
    && (normalizeSyncKey(input).key === currentSpace || input.trim() === currentSpace)
  // 手打的金鑰不像產生器的格式(可能打錯,也可能是舊版自訂的):提醒但不擋
  const keyLooksOff = keyInput.trim() !== '' && !normalizeSyncKey(keyInput).standard
  const closeKeySheet = () => setKeyOpen(false)
  const retentionPct = fsrs === undefined ? null : Math.round(fsrs.desired_retention * 100)

  const saveRetention = (pct: number) => run(async () => {
    if (fsrs === undefined) return
    const next = { ...fsrs, desired_retention: clampRetention(pct / 100) }
    await saveFsrsSettings(next)
    applyFsrsSettings(next)
    setFsrsMsg('')
    requestSync()
  })

  const optimize = () => run(async () => {
    if (fsrs === undefined) return
    try {
      setFsrsMsg('整理複習紀錄…')
      const set = buildTrainingSet(await db.review_logs.toArray())
      if (set.items === 0) { setFsrsMsg('紀錄裡還沒有跨天的複習，沒東西可以學'); return }
      setFsrsMsg('最佳化中…')
      const w = await optimizeParameters(set, (done, total) => {
        if (total > 0) setFsrsMsg(`最佳化中… ${Math.min(100, Math.round((done / total) * 100))}%`)
      })
      const next = { ...fsrs, w, optimized_at: Date.now(), optimized_reviews: set.reviews }
      await saveFsrsSettings(next)
      applyFsrsSettings(next)
      setFsrsMsg(`✓ 完成：用了 ${set.reviews} 次複習紀錄，新參數已存檔並同步`)
      requestSync()
    } catch (e) {
      setFsrsMsg(`最佳化失敗：${e instanceof Error ? e.message : String(e)}`)
    }
  })

  const resetParams = () => run(async () => {
    if (fsrs === undefined) return
    if (!await confirm({ title: '換回預設參數？', message: '之後隨時可以再用自己的紀錄最佳化。', confirmLabel: '換回預設' })) return
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

  /** 本機還有沒推上去的東西時,先試著推;推不上去就明講會遺失幾筆,讓人決定 */
  const safeToLeaveSpace = async (action: string): Promise<boolean> => {
    if (await countUnsynced() > 0) await syncNow()
    const left = await countUnsynced()
    if (left === 0) return true
    return confirm({
      title: `還有 ${left} 項變更沒同步上去`,
      message: `目前連不上雲端。現在${action}，這些還沒上傳的變更（例如剛複習的紀錄）會遺失。`,
      confirmLabel: `仍要${action}`,
      destructive: true,
    })
  }

  /** 純本機 → 產生新金鑰:本機資料整份帶過去 */
  const startNewSync = () => run(async () => {
    const key = generateSyncKey()
    await adoptSyncSpace(key)
    setShowKey(true)
    setMsg('已開始同步，上傳中…')
    const r = await syncNow()
    setMsg(syncMessage(r, '✓ 已開始同步。先把上面的金鑰抄下來，換裝置時要用'))
  })

  /**
   * 連上一組金鑰之前先看那個空間:連不上就什麼都不改(不會清掉這台、也不會留下一組沒確認過的金鑰);
   * 是空的多半是打錯一碼(會連進一個全新的空間,看起來像資料全不見),先問。
   * 回傳要用的金鑰(舊版自訂的金鑰可能照原樣,見 probeSyncKey)與那個空間的牌組數;null = 不要繼續。
   */
  const checkSpace = async (input: string): Promise<{ key: string; decks: number } | null> => {
    const { key } = normalizeSyncKey(input)
    if (key === '') return null
    setMsg('確認金鑰…')
    const probe = await probeSyncKey(input, key)
    if (probe === null) {
      setMsg('連不上伺服器，這台什麼都沒改；連上網路後再試一次')
      return null
    }
    setMsg('')
    if (probe.decks > 0) return probe
    const ok = await confirm({
      title: '這組金鑰的空間是空的',
      message: `確定沒打錯嗎？打錯一碼會連到一個全新的空間。\n${probe.key}`,
      confirmLabel: '就用這組',
      cancelLabel: '重新輸入',
      // 打錯的人多半會再按一次 Enter:預設停在「重新輸入」
      focusCancel: true,
    })
    return ok ? probe : null
  }

  /** 換到別的空間之後下載,回報拿到什麼 */
  const reportJoined = async () => {
    const r = await syncNow()
    if (!r.ok) { setMsg(syncMessage(r, '')); return }
    const c = await countLocalContents()
    setMsg(c.decks > 0 ? `✓ 已連上，下載了 ${c.decks} 副牌組、${c.words} 個字` : '✓ 已連上，之後的牌組會同步到這組金鑰')
  }

  /**
   * 這台的資料帶進那個空間(空間裡原本有的照 updated_at 合併)。同步完之後,這台新帶進去的牌組併進同名的那副
   * (兩台都從同一份範本開始的話,不併每個字都會有兩份);這次同步沒成功的話,之後第一次成功的同步會補做。
   */
  const mergeInto = async (key: string) => {
    setMsg('同步中…')
    // 空間認得哪些牌組:那些不是這台新帶進去的,不拿去併(停止同步後回到同一個空間時,共用的那副不能被併掉)
    const summary = await fetchSpaceSummary(key)
    if (summary === null) { setMsg('連不上伺服器，這台什麼都沒改；連上網路後再試一次'); return }
    setKeyInput('')
    await adoptSyncSpace(key, summary.ids === null ? undefined : new Set(summary.ids))
    const r = await syncNow()
    setMsg(syncMessage(r, r.folded
      ? `✓ 已把這台的資料合併進這個空間；同名的 ${r.folded} 副牌組併成一副，重複的字只留一份（進度留多的那份）`
      : '✓ 已把這台的資料合併進這個空間'))
  }

  /** 純本機 → 輸入別台的金鑰。本機有資料就先問要帶過去還是捨棄(空的空間就直接帶過去,沒有東西可以改用) */
  const useExistingKey = () => run(async () => {
    const probe = await checkSpace(keyInput)
    if (probe === null) return
    const { key } = probe
    if (await hasLocalData()) {
      if (probe.decks === 0) await mergeInto(key)
      else setAdoptChoice(key)
      return
    }
    await setSyncSpace(key)
    setKeyInput('')
    setMsg('同步中…')
    await reportJoined()
  })

  const finishAdopt = (key: string, keepLocal: boolean) => run(async () => {
    if (keepLocal) { await mergeInto(key); return }
    if (!await confirm({
      title: '捨棄這台的資料？',
      message: '這台的牌組與複習紀錄會清掉，改用那個空間裡的資料。沒同步過的東西救不回來。',
      confirmLabel: '捨棄並改用雲端',
      destructive: true,
    })) return
    setKeyInput('')
    setMsg('同步中…')
    await setSyncSpace(key)
    await reportJoined()
  })

  /** 已經在同步 → 換到另一個空間:這台清空,再下載新空間(舊空間的資料留在雲端) */
  const switchKey = () => run(async () => {
    const previous = currentSpace ?? ''
    if (isCurrentKey(keyInput)) return
    const probe = await checkSpace(keyInput)
    if (probe === null || probe.key === previous) return
    const { key } = probe
    if (!await safeToLeaveSpace('換金鑰')) return
    // 換完這台只剩新金鑰:確認框先把目前這組秀出來,沒抄過的人才回得去
    if (!await confirm({
      title: '換成另一組金鑰？',
      message: `換之前先記下目前的金鑰：\n${previous}\n\n這台會先清空，再下載新空間的資料；目前空間的資料留在雲端，之後輸入這組就能取回。`,
      confirmLabel: '換金鑰',
      destructive: true,
    })) return
    await setSyncSpace(key)
    setKeyInput('')
    setShowKey(false)
    setMsg('金鑰已更新，同步中…')
    await reportJoined()
  })

  /** 停止同步:這台的資料留著(之後再開同步會一起帶上去),雲端那份也還在 */
  const stopSync = () => run(async () => {
    if (!await confirm({
      title: '停止同步？',
      message: '這台的資料留著，之後的變更只存在這台；雲端那份也還在，之後輸入同一組金鑰就能再同步。',
      confirmLabel: '停止同步',
    })) return
    await leaveSyncSpace()
    setMsg('已停止同步，資料只存在這台')
    setKeyOpen(false)
  })

  const doClearLocal = () => run(async () => {
    if (!await safeToLeaveSpace('清空')) return
    if (!await confirm({
      title: '清空這台的資料？',
      message: '牌組、卡片與複習紀錄會從這台刪除，再用目前的金鑰從雲端重新下載。',
      confirmLabel: '清空並重新下載',
      destructive: true,
    })) return
    await clearLocalData()
    setResetMsg('本機已清空，重新同步中…')
    const r = await syncNow()
    setResetMsg(r.ok ? '✓ 已清空並重新同步'
      : r.reason === 'offline' ? '本機已清空（目前離線）' : syncMessage(r, ''))
  })

  const restoreBackup = (file: File) => run(async () => {
    // 先讀檔、看內容對不對,再問要不要還原:選錯檔案不必走到確認那一步,
    // 確認框也能寫出這份備份是哪一天、有多少東西,免得拿舊備份蓋掉新資料
    let json: string
    let info: BackupSummary
    try {
      json = await file.text()
      info = describeBackup(json)
    } catch (err) {
      setBackupMsg(`無法還原：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const when = info.exportedAt === null ? '' : `備份時間：${new Date(info.exportedAt).toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' })}\n`
    if (!await confirm({
      title: '還原這份備份？',
      message: `${when}內容：${info.decks} 副牌組、${info.words} 個字、${info.reviews} 次複習紀錄\n\n`
        + (localOnly ? '這台的資料會變回備份時的樣子。'
          : '這台、雲端和其他裝置都會變回備份時的樣子：備份之後新增的牌組和字會刪掉，之後的複習進度也會不見。'),
      confirmLabel: '還原',
      destructive: true,
    })) return
    try {
      await importBackup(json)
      setBackupMsg(localOnly ? '✓ 還原完成' : '✓ 還原完成，同步中…')
      if (!localOnly) {
        // 先同步一次:備份推上去,雲端上備份之後才有的東西也會拉回來;再把那些標成刪除推上去
        const r = await syncNow()
        if (!r.ok) {
          setBackupMsg(`這台已經還原，但沒連上雲端（${syncMessage(r, '')}）。雲端上備份之後新增的東西可能會同步回來，連上網路後再還原一次。`)
          return
        }
        const pruned = await pruneToBackup(json)
        const r2 = pruned > 0 ? await syncNow() : r
        setBackupMsg(syncMessage(r2, '✓ 還原完成，雲端和其他裝置也會變回備份時的樣子'))
      }
    } catch (err) {
      setBackupMsg(`還原失敗：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  const prepareBackup = () => run(async () => {
    try {
      setBackupMsg('準備備份…')
      const at = Date.now()
      const text = await exportBackup(at)
      const name = `字卡備份-${new Date(at).toISOString().slice(0, 10)}.json`
      if (isTouchDevice()) {
        setBackupFile({ name, text, at, kb: Math.max(1, Math.round(new Blob([text]).size / 1024)) })
        // 同一塊播報區換字(不是清掉):讀螢幕才會唸,知道還要再按一下
        setBackupMsg('備份檔準備好了，按「儲存備份檔」存到「檔案」或傳給其他 App')
      } else {
        await download(name, text, 'application/json')
        setBackupMsg('✓ 已下載備份檔')
      }
    } catch (err) {
      setBackupMsg(`備份失敗：${errorText(err)}`)
    }
  })

  /** 第二步:在這一下點擊裡叫出分享面板。存好(或下載)了這份就用掉了;自己關掉面板的話留著,可以再按 */
  const saveBackup = async (file: { name: string; text: string }) => {
    const how = await download(file.name, file.text, 'application/json')
    if (how === 'cancelled') return
    // 分享面板叫不出來、退回一般下載:主畫面 App 裡可能什麼都沒發生,檔案留著讓人再按一次
    if (how === 'fallback') { setBackupMsg('沒有跳出存檔畫面的話，再按一次「儲存備份檔」'); return }
    setBackupFile(null)
    setBackupMsg(how === 'shared' ? '✓ 已存好備份檔' : '✓ 已下載備份檔')
  }

  // 準備好之後資料又變了(同步拉到別台的改動、還原、在別的分頁改了):那份檔案已經不是現在的樣子,收回來重新準備。
  // 用同一個時間重新匯出來比 —— 同步推上去只會清掉「待上傳」的標記,備份內容沒變,不用重來
  useEffect(() => {
    if (backupFile === null) return
    let off = false
    let timer = 0
    const check = async () => {
      const now = await exportBackup(backupFile.at)
      if (off || now === backupFile.text) return
      setBackupFile(null)
      setBackupMsg('資料有變動，按「下載完整備份」重新準備')
    }
    const onChange = (parts: ObservabilitySet) => {
      if (!Object.keys(parts).some((k) => /\/(decks|notes|cards|review_logs|settings)\//.test(k))) return
      clearTimeout(timer)
      timer = window.setTimeout(() => void check(), 300)
    }
    Dexie.on.storagemutated.subscribe(onChange)
    return () => { off = true; clearTimeout(timer); Dexie.on.storagemutated.unsubscribe(onChange) }
  }, [backupFile])

  const copyKey = () => {
    if (!currentSpace) return
    void navigator.clipboard?.writeText(currentSpace).then(() => setKeyCopied(true), () => setShowKey(true))
  }

  return (
    <>
      <PageHeader title="設定" />

      {/* 同步放最前面:換裝置、看金鑰、確認有沒有同步,是最常來設定頁做的事 */}
      <ListSection header="同步" withIcons footer={msg ? <span role="status" aria-live="polite">{msg}</span> : undefined}>
        <div className="row">
          <span className="row-icon"><SyncIcon size={17} /></span>
          <span className="row-main">
            <span className="row-title">{localOnly ? '只存在這台裝置' : '同步已開啟'}</span>
            <span className="row-subtitle">
              {localOnly ? '換手機或清掉瀏覽器資料就沒了'
                : lastSync ? `上次同步：${formatWhen(Number(lastSync.value))}` : '還沒同步過'}
            </span>
          </span>
          {!localOnly && (
            <button type="button" className="btn sm tinted" disabled={busy} onClick={() => void doSync()}>立即同步</button>
          )}
        </div>
        {syncError !== undefined && (
          <div className="row"><span className="row-icon danger" aria-hidden="true">!</span>
            <span className="row-main"><span className="row-subtitle err">上次同步沒成功：{humanizeSyncError(String(syncError.value))}</span></span>
          </div>
        )}
        <button type="button" className="row" onClick={() => { setKeyInput(''); setAdoptChoice(null); setKeyOpen(true) }}>
          <span className="row-icon"><span aria-hidden="true">🔑</span></span>
          <span className="row-main"><span className="row-title">同步金鑰</span></span>
          <span className="row-value">{localOnly ? '未設定' : currentSpace ? maskKey(currentSpace) : '…'}</span>
          <span className="row-chevron"><ChevronRightIcon /></span>
        </button>
      </ListSection>

      <ListSection header="學習" footer={
        <>調高保持率：複習變頻繁、比較不會忘；調低：複習量少、忘得多。預設 90%，可以對照
          <Link to="/stats" className="inline-link">統計頁</Link>的「真實保持率」。</>
      }>
        <div className="row">
          <span className="row-main">
            <span className="row-title">目標保持率</span>
            <span className="row-subtitle">到期時大約還記得的比例</span>
          </span>
          <span className="stepper" role="group" aria-label="目標保持率">
            <button type="button" aria-label="降低"
              disabled={busy || retentionPct === null || retentionPct <= MIN_RETENTION_PCT}
              onClick={() => retentionPct !== null && void saveRetention(retentionPct - 1)}>−</button>
            <output aria-live="polite">{retentionPct === null ? '…' : `${retentionPct}%`}</output>
            <button type="button" aria-label="提高"
              disabled={busy || retentionPct === null || retentionPct >= MAX_RETENTION_PCT}
              onClick={() => retentionPct !== null && void saveRetention(retentionPct + 1)}>+</button>
          </span>
        </div>
        <label className="row">
          <span className="row-main"><span className="row-title">翻面自動唸讀音</span></span>
          <Switch label="翻面自動唸讀音" checked={autoSpeak} onChange={(v) => {
            setAutoSpeak(v)
            writeAutoSpeak(v)
          }} />
        </label>
      </ListSection>

      <ListSection header="排程參數" footer={
        <>
          用自己的複習紀錄調整排程，複習 {RECOMMENDED_REVIEWS} 次以上比較準；之後每累積一陣子再跑一次。跑的時候會佔滿 CPU 幾秒到一分鐘。
          {fsrsMsg && <span className="footer-status" role="status" aria-live="polite">{fsrsMsg}</span>}
        </>
      }>
        <div className="row">
          <span className="row-main"><span className="row-title">目前參數</span></span>
          <span className="row-value">
            {fsrs === undefined ? '…' : fsrs.w === null
              ? '預設'
              : `已最佳化 · ${fsrs.optimized_at === null ? '' : new Date(fsrs.optimized_at).toLocaleDateString('zh-TW')}`}
          </span>
        </div>
        <button type="button" className="row accent" onClick={() => void optimize()}
          disabled={busy || fsrs === undefined || (logCount ?? 0) < MIN_REVIEWS_TO_OPTIMIZE}>
          <span className="row-main">
            <span className="row-title">用我的複習紀錄最佳化</span>
            <span className="row-subtitle">
              {(logCount ?? 0) < MIN_REVIEWS_TO_OPTIMIZE
                ? `再複習 ${MIN_REVIEWS_TO_OPTIMIZE - (logCount ?? 0)} 次後可以用`
                : `目前複習過 ${logCount} 次`}
            </span>
          </span>
        </button>
        {fsrs !== undefined && fsrs.w !== null && (
          <button type="button" className="row accent" disabled={busy} onClick={() => void resetParams()}>還原預設參數</button>
        )}
      </ListSection>

      <ListSection header="外觀">
        <div className="row">
          <Segmented label="外觀" value={theme} options={THEME_OPTIONS}
            onChange={(p) => { setThemePref(p); setTheme(p) }} />
        </div>
      </ListSection>

      <ListSection header="備份" withIcons footer={
        <>
          備份是一個 JSON 檔，包含所有牌組、卡片和複習紀錄。
          {backupMsg && <span className="footer-status" role="status" aria-live="polite">{backupMsg}</span>}
        </>
      }>
        {backupFile === null ? (
          // aria-disabled 而不是 disabled:停用正在按的按鈕,鍵盤與讀螢幕的焦點會掉到頁首
          <button type="button" className="row accent" aria-disabled={busy || undefined}
            onClick={() => { if (!busy) void prepareBackup() }}>
            <span className="row-icon"><DownloadIcon size={17} /></span>下載完整備份
          </button>
        ) : (
          // 同一次點擊裡叫出分享面板(存到「檔案」、AirDrop、傳給別的 App)
          <button type="button" className="row accent" aria-disabled={busy || undefined}
            onClick={() => { if (!busy) void saveBackup(backupFile) }}>
            <span className="row-icon"><DownloadIcon size={17} /></span>
            <span className="row-main">
              <span className="row-title">儲存備份檔</span>
              <span className="row-subtitle">{backupFile.name} · {backupFile.kb} KB</span>
            </span>
          </button>
        )}
        <label className={`row accent${busy ? ' disabled' : ''}`}>
          <span className="row-icon"><UploadIcon size={17} /></span>從備份還原…
          <input type="file" accept="application/json" className="visually-hidden" disabled={busy} onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void restoreBackup(f)
          }} />
        </label>
      </ListSection>

      <ListSection header="說明" withIcons>
        <Link to="/guide" className="row">
          <span className="row-icon"><BookIcon size={17} /></span>
          <span className="row-main"><span className="row-title">使用說明</span></span>
          <span className="row-chevron"><ChevronRightIcon /></span>
        </Link>
      </ListSection>

      {!localOnly && (
        <ListSection header="進階" footer={
          <>
            資料怪怪的時候用：清掉這台，再用目前的金鑰從雲端重新下載。
            {resetMsg && <span className="footer-status" role="status" aria-live="polite">{resetMsg}</span>}
          </>
        }>
          <button type="button" className="row destructive" disabled={busy} onClick={() => void doClearLocal()}>
            清空這台並重新下載
          </button>
        </ListSection>
      )}

      <Sheet open={keyOpen} onClose={closeKeySheet} title="同步金鑰" full
        start={<span />}
        end={<button type="button" className="btn plain strong" onClick={closeKeySheet}>完成</button>}>
        {localOnly ? (
          <div className="key-sheet">
            <p className="key-intro">
              資料目前只存在這台。開始同步後，這台的牌組與紀錄會上傳到你的私人空間；其他裝置輸入同一組金鑰就會同步在一起，不用註冊帳號。
            </p>
            <button type="button" className="btn lg" disabled={busy} onClick={() => void startNewSync()}>
              產生新金鑰並開始同步
            </button>
            <div className="key-or"><span>或輸入在別台用的金鑰</span></div>
            <form className="form" onSubmit={(e) => { e.preventDefault(); void useExistingKey() }}>
              <input value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="例如 abcd-efgh-jkmn"
                autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="已有的同步金鑰" />
              {keyLooksOff && <p className="field-hint">這不像字卡產生的金鑰，確定沒打錯？</p>}
              <button type="submit" className="btn lg tinted" disabled={busy || keyInput.trim() === ''}>使用這組金鑰</button>
            </form>
            {msg && <p className="hint" role="status">{msg}</p>}
          </div>
        ) : (
          <div className="key-sheet">
            <ListSection header="目前的金鑰" footer="換手機或在電腦上用時，輸入這組金鑰。它就是你空間的密碼，別給別人。">
              <div className="row key-row">
                <code className="key-code">{showKey ? currentSpace : maskKey(currentSpace ?? '')}</code>
                <button type="button" className="link" onClick={() => setShowKey(!showKey)}>{showKey ? '隱藏' : '顯示'}</button>
                <button type="button" className="link" onClick={copyKey}>{keyCopied ? '已複製' : '複製'}</button>
              </div>
            </ListSection>
            {msg && <p className="hint key-msg" role="status">{msg}</p>}
            <ListSection header="換成另一組金鑰" footer="這台會先清空，再下載那個空間的資料；目前空間的資料留在雲端。">
              <div className="row">
                <input value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="輸入另一組金鑰"
                  autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="另一組同步金鑰" />
              </div>
              {keyLooksOff && <div className="row"><span className="row-subtitle">這不像字卡產生的金鑰，確定沒打錯？</span></div>}
              <button type="button" className="row accent"
                disabled={busy || keyInput.trim() === '' || isCurrentKey(keyInput)}
                onClick={() => void switchKey()}>換成這組</button>
            </ListSection>
            <ListSection footer="停止後這台的資料留著，只是不再同步；雲端那份也還在。">
              <button type="button" className="row destructive" disabled={busy} onClick={() => void stopSync()}>停止同步</button>
            </ListSection>
          </div>
        )}
      </Sheet>

      <ActionSheet open={adoptChoice !== null} onClose={() => setAdoptChoice(null)}
        title="這台已經有牌組了" message="要把這台的資料一起帶進那個空間嗎？"
        actions={adoptChoice === null ? [] : [
          { label: '一起帶過去（合併）', onSelect: () => void finishAdopt(adoptChoice, true) },
          { label: '捨棄這台，改用雲端的', destructive: true, onSelect: () => void finishAdopt(adoptChoice, false) },
        ]} />
    </>
  )
}
