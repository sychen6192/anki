import { useState, type CSSProperties } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { sortDecks } from '../lib/deckOrder'
import { State } from '../lib/fsrs'
import { startOfToday } from '../lib/queue'
import { useNow } from '../lib/useNow'
import { lastNDays, streakDays, trueRetention } from '../lib/stats'
import { getFsrsSettings } from '../lib/fsrsSettings'
import { MIN_REVIEWS_TO_OPTIMIZE } from '../lib/fsrsOptimizer'
import { Loading } from '../components/Loading'
import { DayBars, Donut } from '../components/Charts'
import { ChartIcon } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { Link } from 'react-router-dom'
import './stats.css'

/** 真實保持率至少要幾次才標偏高偏低、給調整建議 */
const MIN_TONE_SAMPLE = 30

/** 熱力圖顏色:單一色相由淺到深(0 張另外用底色)。
 * 最淺一級從 30% 提到 40%:30% 跟沒複習的灰格只差 1.30:1(深色)、1.34:1(淺色),螢幕調暗就分不出來;
 * 現在相鄰兩級在兩種主題都至少 1.35:1 */
function heatColor(count: number): string {
  if (count === 0) return 'var(--fill)'
  const pct = count < 5 ? 40 : count < 15 ? 62 : count < 30 ? 82 : 100
  return `color-mix(in srgb, var(--accent) ${pct}%, var(--surface))`
}
const HEAT_WEEKS = 17

// 放不下時(不支援 cqi 的 iOS 15、字級放大)先捲到最右邊:一打開先看到這週,往左捲才是比較舊的。
// 放在元件外面,ref 才不會每次重畫都換一個、又把使用者捲到的位置拉回去
function showLatestWeek(el: HTMLDivElement | null) {
  if (el) el.scrollLeft = el.scrollWidth
}

// 上次看的牌組:只存在這台裝置,隱私模式讀寫會丟錯就當作沒有
const DECK_FILTER_KEY = 'stats-deck'
function readDeckFilter(): string {
  try {
    return localStorage.getItem(DECK_FILTER_KEY) ?? 'all'
  } catch {
    return 'all'
  }
}
function writeDeckFilter(id: string): void {
  try {
    localStorage.setItem(DECK_FILTER_KEY, id)
  } catch {
    // 存不起來就只在這次有效
  }
}

const DAY = 86400_000
// 圖表顏色走設計 token,深色模式才有對應的變體
const C_REVIEWS = 'var(--chart-reviews)'
const C_DUE = 'var(--chart-due)'
const DIST_COLORS = ['var(--c-new)', 'var(--c-learn)', 'var(--c-due-count)']

/** 把資料一次分桶,不要每天各掃一遍全部紀錄(30 天 × 全部紀錄) */
function bucketByDay(timestamps: number[], firstDayStart: number, days: number): number[] {
  const counts = new Array<number>(days).fill(0)
  for (const ts of timestamps) {
    const i = Math.floor((ts - firstDayStart) / DAY)
    if (i >= 0 && i < days) counts[i] += 1
  }
  return counts
}

const TODAY = '今天'
function dayLabel(ts: number, today: number): string {
  if (ts === today) return TODAY
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
/** 句子裡的日期:數字前後空一格,「今天」不用 */
const inSentence = (day: string) => (day === TODAY ? day : ` ${day} `)

export default function StatsPage() {
  const allLogs = useLiveQuery(() => db.review_logs.toArray(), [])
  const allCards = useLiveQuery(() => db.cards.toArray(), [])
  const decks = useLiveQuery(async () => sortDecks(await db.decks.filter((d) => !d.deleted).toArray()), [])
  const fsrsSettings = useLiveQuery(() => getFsrsSettings(), [])
  const [deckFilter, setDeckFilter] = useState(readDeckFilter)
  const now = useNow()
  if (!allLogs || !allCards || !decks || !fsrsSettings) return <Loading />

  // 第一次用:一頁的 0 和空圖表沒有用,直接說下一步
  if (allLogs.length === 0 && allCards.every((c) => c.deleted)) {
    return (
      <>
        <PageHeader title="統計" />
        <div className="empty-state">
          <span className="empty-icon"><ChartIcon size={30} /></span>
          <h2>還沒有複習紀錄</h2>
          {/* 分兩段:要做的事自己一行;寫成一段的話 balance 會把「複習」拆在兩行 */}
          <p>先到「牌組」新增或匯入卡片。</p>
          <p>複習幾天之後，這裡就會畫出每天的複習量和接下來要複習的張數。</p>
          <Link to="/" className="btn">去牌組</Link>
        </div>
      </>
    )
  }

  // 記住的牌組已經刪了(可能是別台刪的),或只剩一副、篩選選單不出現時,一律看全部:
  // 不然畫面停在某副牌組、卻沒有選單可以換回來
  const activeDeck = decks.length > 1 && decks.some((d) => d.id === deckFilter) ? deckFilter : 'all'

  // 篩某副牌組:卡片直接看 deck_id;複習紀錄沒有 deck_id,經 card_id 查
  // (對照表含已刪卡片,舊紀錄才不會因為卡片刪了就歸不了戶)
  const cardDeck = new Map(allCards.map((c) => [c.id, c.deck_id]))
  const logs = activeDeck === 'all'
    ? allLogs
    : allLogs.filter((l) => cardDeck.get(l.card_id) === activeDeck)
  const inDeck = allCards.filter((c) => !c.deleted && (activeDeck === 'all' || c.deck_id === activeDeck))
  // 已會 / 先不學的卡不在排程裡:狀態分布與到期預測都不算,另外報數量
  const cards = inDeck.filter((c) => !c.suspended)
  const parked = { known: 0, paused: 0 }
  for (const c of inDeck) {
    if (c.suspended === 2) parked.known += 1
    else if (c.suspended === 1) parked.paused += 1
  }

  const today = startOfToday(now)

  const pastStart = today - 29 * DAY
  const pastCounts = bucketByDay(logs.map((l) => l.reviewed_at), pastStart, 30)
  const past = pastCounts.map((count, i) => ({ day: dayLabel(pastStart + i * DAY, today), count }))

  // 已逾期的卡一律算在今天(把 due 夾到今天以後再分桶)
  const scheduled = cards.filter((c) => c.state !== State.New)
  const forecastCounts = bucketByDay(scheduled.map((c) => Math.max(c.due, today)), today, 30)
  const forecast = forecastCounts.map((count, i) => ({ day: dayLabel(today + i * DAY, today), count }))
  const overdue = scheduled.filter((c) => c.due < today).length

  let news = 0, learning = 0, review = 0
  for (const c of cards) {
    if (c.state === State.New) news += 1
    else if (c.state === State.Learning || c.state === State.Relearning) learning += 1
    else if (c.state === State.Review) review += 1
  }
  const dist = [
    { name: '新卡', value: news, color: DIST_COLORS[0] },
    { name: '學習中', value: learning, color: DIST_COLORS[1] },
    { name: '已學過', value: review, color: DIST_COLORS[2] },
  ]

  // 真實保持率:三個區間各算一次;篩牌組時 logs 已經是該牌組的
  const retentionAll = trueRetention(logs)
  const retention = [
    ['7 天', trueRetention(logs, today - 6 * DAY)],
    ['30 天', trueRetention(logs, today - 29 * DAY)],
    ['全部', retentionAll],
  ] as const
  const pct = (r: { passed: number; total: number }) =>
    r.total === 0 ? '—' : `${Math.round((r.passed / r.total) * 100)}%`
  const targetPct = Math.round(fsrsSettings.desired_retention * 100)

  const stamps = logs.map((l) => l.reviewed_at)
  const todayCount = stamps.filter((ts) => ts >= today).length
  const streak = streakDays(stamps, today)
  const heatDays = lastNDays(stamps, today, HEAT_WEEKS * 7)
  // 讓格子照星期對齊:第一天不是週日就先塞空格,再切成一週一欄
  const heatPad = new Date(heatDays[0].start).getDay()
  const cells: ({ start: number; count: number } | null)[] =
    [...Array<null>(heatPad).fill(null), ...heatDays]
  const weeks: (typeof cells)[] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  // 每欄第一天所在的月份,和前一欄不同才標(第一欄一定標)
  const monthOf = (w: (typeof cells)) => {
    const first = w.find((d) => d !== null)
    return first === undefined ? -1 : new Date(first.start).getMonth()
  }

  // 次數太少時的百分比跳動很大(答對 2 次就是 100%):不標偏高偏低、不給調整建議
  const retentionTone = (r: { passed: number; total: number }): '' | 'low' | 'high' => {
    if (r.total < MIN_TONE_SAMPLE) return ''
    const p = (r.passed / r.total) * 100
    return p < targetPct - 5 ? 'low' : p > targetPct + 4 ? 'high' : ''
  }
  const overallTone = retentionTone(retentionAll)
  // 最佳化用的是全部的複習紀錄(設定頁也是數全部):只看篩選的這副牌組,會叫人等一個其實已經能按的按鈕
  const canOptimize = allLogs.length >= MIN_REVIEWS_TO_OPTIMIZE

  // 圖表的文字摘要:讀螢幕拿得到數字,手機上也不必一格一格點
  const heatTotal = heatDays.reduce((a, d) => a + d.count, 0)
  const heatActive = heatDays.filter((d) => d.count > 0).length
  const pastTotal = pastCounts.reduce((a, b) => a + b, 0)
  const pastMax = Math.max(...pastCounts)
  const pastMaxDay = past[pastCounts.indexOf(pastMax)]?.day
  const week = forecastCounts.slice(0, 7).reduce((a, b) => a + b, 0)
  const forecastMax = Math.max(...forecastCounts)
  const forecastMaxDay = forecast[forecastCounts.indexOf(forecastMax)]?.day

  return (
    <>
      <PageHeader title="統計" />
      {decks.length > 1 && (
        <div className="stats-filter">
          <select aria-label="篩選牌組" value={activeDeck}
            onChange={(e) => { setDeckFilter(e.target.value); writeDeckFilter(e.target.value) }}>
            <option value="all">全部牌組</option>
            {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat card"><b>{todayCount}</b><span>今天複習</span></div>
        <div className="stat card"><b>{streak}</b><span>連續天數</span></div>
        <div className="stat card"><b>{logs.length}</b><span>累計複習</span></div>
      </div>

      <section className="stat-card card">
        <div className="stat-card-head">
          <h2>真實保持率</h2>
          <span className="stat-card-note">目標 {targetPct}%</span>
        </div>
        {retentionAll.total === 0 ? (
          <p className="stat-empty">學過的字到期、再答一次之後才開始算。</p>
        ) : (
          <>
            <div className="retention-row">
              {retention.map(([label, r]) => {
                const tone = retentionTone(r)
                return (
                  <div className={`retention${tone ? ` ${tone}` : ''}`} key={label}>
                    {/* 偏低/偏高不只靠顏色:數字旁邊寫出來 */}
                    <b>{pct(r)}{tone && <small>{tone === 'low' ? '偏低' : '偏高'}</small>}</b>
                    <span>{label} · {r.total} 次</span>
                  </div>
                )
              })}
            </div>
            <p className="hint">
              到期時答對的比例，只算學過的字到期時的那一次（共 {retentionAll.total} 次）。
              {retentionAll.total < MIN_TONE_SAMPLE
                ? `次數還少，至少 ${MIN_TONE_SAMPLE} 次比較準，先不用照這個調整。`
                : overallTone === 'low'
                  ? canOptimize
                    ? <>比目標低：可以到<Link to="/settings" className="inline-link">設定</Link>用自己的紀錄最佳化排程。</>
                    : '比目標低：照常複習就好，紀錄多了之後可以到設定用自己的紀錄最佳化排程。'
                  : overallTone === 'high' ? '比目標高：可以把目標調低，少複習一點。' : '在目標附近，不用調整。'}
            </p>
          </>
        )}
      </section>

      <section className="stat-card card heat-card">
        <div className="stat-card-head"><h2>每天複習量</h2><span className="stat-card-note">最近 {HEAT_WEEKS} 週</span></div>
        {/* 摘要直接顯示(和底下兩張長條圖一樣),格子本身就不用再給讀螢幕唸一次 */}
        <p className="chart-summary">
          {heatActive === 0 ? `過去 ${HEAT_WEEKS} 週沒有複習` : `過去 ${HEAT_WEEKS} 週有 ${heatActive} 天複習，共 ${heatTotal} 次`}
        </p>
        <div className="heat-wrap">
          <div className="heatmap" aria-hidden="true" ref={showLatestWeek}
            style={{ '--weeks': weeks.length } as CSSProperties}>
            {weeks.map((w, i) => (
              <div className="heat-week" key={i}>
                <span className="heat-month">
                  {(i === 0 || monthOf(w) !== monthOf(weeks[i - 1])) && monthOf(w) >= 0
                    ? `${monthOf(w) + 1}月` : ''}
                </span>
                {w.map((d, j) => d === null
                  ? <span key={j} className="heat-cell pad" />
                  : (
                    <span key={j} className="heat-cell" style={{ background: heatColor(d.count) }}
                      title={`${new Date(d.start).getMonth() + 1}/${new Date(d.start).getDate()} · ${d.count} 次`} />
                  ))}
              </div>
            ))}
          </div>
          {logs.length > 0 && (
            <div className="heat-legend" aria-hidden="true">
              0 次
              {[0, 3, 8, 20, 40].map((n) => <span key={n} className="heat-cell" style={{ background: heatColor(n) }} />)}
              30 次以上
            </div>
          )}
        </div>
      </section>

      <section className="stat-card card">
        <div className="stat-card-head"><h2>過去 30 天</h2><span className="stat-card-note">複習次數</span></div>
        {logs.length === 0 ? (
          <p className="stat-empty">還沒有複習紀錄。完成第一次複習之後就會出現。</p>
        ) : (
          <>
          <p className="chart-summary">共 {pastTotal} 次，平均每天 {Math.round(pastTotal / 30)} 次
            {pastMax > 0 && pastMaxDay !== undefined && `，最多是${inSentence(pastMaxDay)}的 ${pastMax} 次`}</p>
          <DayBars data={past} color={C_REVIEWS} unit="次" label="過去 30 天每天的複習次數" today="end" />
          </>
        )}
      </section>

      <section className="stat-card card">
        <div className="stat-card-head"><h2>未來 30 天</h2><span className="stat-card-note">到期張數</span></div>
        {scheduled.length === 0 ? (
          <p className="stat-empty">還沒有排程的卡片。新卡複習過一次之後就會排進來。</p>
        ) : (
          <>
          <p className="chart-summary">未來 7 天有 {week} 張到期
            {forecastMax > 0 && forecastMaxDay !== undefined && `，最多是${inSentence(forecastMaxDay)}的 ${forecastMax} 張`}
            {/* 第一根常常特別高:之前沒複習完的都算在今天,講一聲 */}
            {forecastMaxDay === TODAY && overdue > 0 && <span className="nowrap">（含逾期的 {overdue} 張）</span>}</p>
          <DayBars data={forecast} color={C_DUE} unit="張" label="未來 30 天每天到期的張數" today="start" />
          </>
        )}
      </section>

      <section className="stat-card card">
        <div className="stat-card-head"><h2>卡片狀態</h2></div>
        {inDeck.length === 0 ? (
          <p className="stat-empty">還沒有卡片。到「牌組」右上角的「＋」新增或匯入。</p>
        ) : cards.length === 0 ? (
          <p className="stat-empty">每張卡都標成已經會了或先不學了。</p>
        ) : (
          <div className="state-dist">
            <Donut parts={dist} />
            <ul className="dist-legend">
              {dist.map((d) => (
                <li key={d.name}><span className="dot" style={{ background: d.color }} />{d.name}<b>{d.value}</b></li>
              ))}
            </ul>
          </div>
        )}
        {(parked.known > 0 || parked.paused > 0) && (
          <p className="hint">
            不含{[parked.known > 0 && `已經會了 ${parked.known} 張`, parked.paused > 0 && `先不學 ${parked.paused} 張`]
              .filter(Boolean).join('、')}（牌組頁可以恢復）。
          </p>
        )}
      </section>
    </>
  )
}
