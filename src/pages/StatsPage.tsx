import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { db } from '../db/db'
import { State } from '../lib/fsrs'
import { startOfToday } from '../lib/queue'
import { lastNDays, streakDays, trueRetention } from '../lib/stats'
import { getFsrsSettings } from '../lib/fsrsSettings'
import { Loading } from '../components/Loading'
import { PageHeader } from '../components/PageHeader'
import { Link } from 'react-router-dom'
import './stats.css'

/** 熱力圖顏色:單一色相由淺到深(0 張另外用底色) */
function heatColor(count: number): string {
  if (count === 0) return 'var(--fill)'
  const pct = count < 5 ? 30 : count < 15 ? 55 : count < 30 ? 78 : 100
  return `color-mix(in srgb, var(--accent) ${pct}%, var(--surface))`
}
const HEAT_WEEKS = 17

const DAY = 86400_000
// 圖表顏色走設計 token,深色模式才有對應的變體(SVG 的 fill 支援 var())
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

function dayLabel(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export default function StatsPage() {
  const allLogs = useLiveQuery(() => db.review_logs.toArray(), [])
  const allCards = useLiveQuery(() => db.cards.toArray(), [])
  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray(), [])
  const fsrsSettings = useLiveQuery(() => getFsrsSettings(), [])
  const [deckFilter, setDeckFilter] = useState('all')
  if (!allLogs || !allCards || !decks || !fsrsSettings) return <Loading />

  // 篩某副牌組:卡片直接看 deck_id;複習紀錄沒有 deck_id,經 card_id 查
  // (對照表含已刪卡片,舊紀錄才不會因為卡片刪了就歸不了戶)
  const cardDeck = new Map(allCards.map((c) => [c.id, c.deck_id]))
  const logs = deckFilter === 'all'
    ? allLogs
    : allLogs.filter((l) => cardDeck.get(l.card_id) === deckFilter)
  const inDeck = allCards.filter((c) => !c.deleted && (deckFilter === 'all' || c.deck_id === deckFilter))
  // 已會 / 擱置的卡不在排程裡:狀態分布與到期預測都不算,另外報數量
  const cards = inDeck.filter((c) => !c.suspended)
  const parked = { known: 0, paused: 0 }
  for (const c of inDeck) {
    if (c.suspended === 2) parked.known += 1
    else if (c.suspended === 1) parked.paused += 1
  }

  const today = startOfToday()

  const pastStart = today - 29 * DAY
  const pastCounts = bucketByDay(logs.map((l) => l.reviewed_at), pastStart, 30)
  const past = pastCounts.map((count, i) => ({ day: dayLabel(pastStart + i * DAY), count }))

  // 已逾期的卡一律算在今天(把 due 夾到今天以後再分桶)
  const scheduled = cards.filter((c) => c.state !== State.New)
  const forecastCounts = bucketByDay(scheduled.map((c) => Math.max(c.due, today)), today, 30)
  const forecast = forecastCounts.map((count, i) => ({ day: dayLabel(today + i * DAY), count }))

  let news = 0, learning = 0, review = 0
  for (const c of cards) {
    if (c.state === State.New) news += 1
    else if (c.state === State.Learning || c.state === State.Relearning) learning += 1
    else if (c.state === State.Review) review += 1
  }
  const dist = [
    { name: '新卡', value: news, color: DIST_COLORS[0] },
    { name: '學習中', value: learning, color: DIST_COLORS[1] },
    { name: '複習中', value: review, color: DIST_COLORS[2] },
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

  const retentionTone = (r: { passed: number; total: number }) => {
    if (r.total === 0) return ''
    const p = (r.passed / r.total) * 100
    return p < targetPct - 5 ? ' low' : p > targetPct + 4 ? ' high' : ''
  }

  return (
    <>
      <PageHeader title="統計" />
      {decks.length > 1 && (
        <div className="stats-filter">
          <select aria-label="篩選牌組" value={deckFilter} onChange={(e) => setDeckFilter(e.target.value)}>
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
          <p className="stat-empty">還沒有資料 —— 卡片畢業、再次到期複習後才開始算</p>
        ) : (
          <>
            <div className="retention-row">
              {retention.map(([label, r]) => (
                <div className={`retention${retentionTone(r)}`} key={label}>
                  <b>{pct(r)}</b><span>{label} · {r.total} 次</span>
                </div>
              ))}
            </div>
            <p className="hint">
              到期時答對的比例。明顯低於目標可以到<Link to="/settings" className="inline-link">設定</Link>用自己的紀錄最佳化參數；
              明顯高於目標可以把目標調低，少複習一點。
            </p>
          </>
        )}
      </section>

      <section className="stat-card card">
        <div className="stat-card-head"><h2>每天複習量</h2><span className="stat-card-note">最近 {HEAT_WEEKS} 週</span></div>
        <div className="heatmap" role="img" aria-label={`過去 ${HEAT_WEEKS} 週每日複習量`}>
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
                    title={`${new Date(d.start).getMonth() + 1}/${new Date(d.start).getDate()}:${d.count} 張`} />
                ))}
            </div>
          ))}
        </div>
        <div className="heat-legend" aria-hidden="true">
          少
          {[0, 3, 8, 20, 40].map((n) => <span key={n} className="heat-cell" style={{ background: heatColor(n) }} />)}
          多
        </div>
      </section>

      <section className="stat-card card">
        <div className="stat-card-head"><h2>過去 30 天</h2><span className="stat-card-note">複習張數</span></div>
        {logs.length === 0 ? (
          <p className="stat-empty">還沒有複習紀錄 —— 完成第一次複習後就會出現</p>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={past} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <XAxis dataKey="day" interval={6} tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} width={36} tickLine={false} axisLine={false} />
              <Tooltip />
              <Bar dataKey="count" name="複習數" fill={C_REVIEWS} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </section>

      <section className="stat-card card">
        <div className="stat-card-head"><h2>未來 30 天</h2><span className="stat-card-note">到期張數</span></div>
        {scheduled.length === 0 ? (
          <p className="stat-empty">還沒有排程的卡片 —— 新卡第一次複習後就會進入排程</p>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={forecast} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <XAxis dataKey="day" interval={6} tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} width={36} tickLine={false} axisLine={false} />
              <Tooltip />
              <Bar dataKey="count" name="到期數" fill={C_DUE} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </section>

      <section className="stat-card card">
        <div className="stat-card-head"><h2>卡片狀態</h2></div>
        {cards.length === 0 ? (
          <p className="stat-empty">還沒有卡片 —— 到「牌組」右上的「+」新增或匯入</p>
        ) : (
          <div className="state-dist">
            <ResponsiveContainer width={150} height={150}>
              <PieChart>
                <Pie data={dist} dataKey="value" nameKey="name" innerRadius={44} outerRadius={70} strokeWidth={0}>
                  {dist.map((d) => <Cell key={d.name} fill={d.color} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
            <ul className="dist-legend">
              {dist.map((d) => (
                <li key={d.name}><span className="dot" style={{ background: d.color }} />{d.name}<b>{d.value}</b></li>
              ))}
            </ul>
          </div>
        )}
        {(parked.known > 0 || parked.paused > 0) && (
          <p className="hint">不含已經會了 {parked.known} 張、擱置 {parked.paused} 張（牌組頁可以恢復）。</p>
        )}
      </section>
    </>
  )
}
