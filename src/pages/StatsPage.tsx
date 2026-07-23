import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { db } from '../db/db'
import { State } from '../lib/fsrs'
import { startOfToday } from '../lib/queue'
import { lastNDays, streakDays } from '../lib/stats'
import { Loading } from '../components/Loading'

/** 熱力圖顏色:單一色相由淺到深(0 張另外用底色) */
function heatColor(count: number): string {
  if (count === 0) return 'var(--surface-2)'
  const pct = count < 5 ? 30 : count < 15 ? 55 : count < 30 ? 78 : 100
  return `color-mix(in srgb, var(--primary) ${pct}%, var(--surface))`
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
  const [deckFilter, setDeckFilter] = useState('all')
  if (!allLogs || !allCards || !decks) return <Loading />

  // 篩某副牌組:卡片直接看 deck_id;複習紀錄沒有 deck_id,經 card_id 查
  // (對照表含已刪卡片,舊紀錄才不會因為卡片刪了就歸不了戶)
  const cardDeck = new Map(allCards.map((c) => [c.id, c.deck_id]))
  const logs = deckFilter === 'all'
    ? allLogs
    : allLogs.filter((l) => cardDeck.get(l.card_id) === deckFilter)
  const cards = allCards.filter((c) => !c.deleted && (deckFilter === 'all' || c.deck_id === deckFilter))

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

  return (
    <div>
      <h1>統計</h1>

      {decks.length > 1 && (
        <select className="sort-select stats-deck-filter" aria-label="篩選牌組"
          value={deckFilter} onChange={(e) => setDeckFilter(e.target.value)}>
          <option value="all">全部牌組</option>
          {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      )}

      <div className="stat-row">
        <div className="stat-tile"><b>{todayCount}</b><span>今日複習</span></div>
        <div className="stat-tile"><b>{streak}</b><span>連續天數</span></div>
        <div className="stat-tile"><b>{logs.length}</b><span>累計複習</span></div>
      </div>

      <h2>複習熱力圖</h2>
      <div className="chart-block">
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
      </div>

      <h2>過去 30 天複習量</h2>
      <div className="chart-block">
        {logs.length === 0 ? (
          <p className="empty">還沒有複習紀錄 —— 完成第一次複習後就會出現</p>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={past}>
              <XAxis dataKey="day" interval={6} tickLine={false} />
              <YAxis allowDecimals={false} width={32} tickLine={false} axisLine={false} />
              <Tooltip />
              <Bar dataKey="count" name="複習數" fill={C_REVIEWS} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <h2>未來 30 天到期預測</h2>
      <div className="chart-block">
        {scheduled.length === 0 ? (
          <p className="empty">沒有已排程的卡片 —— 新卡完成第一次複習後就會進入排程</p>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={forecast}>
              <XAxis dataKey="day" interval={6} tickLine={false} />
              <YAxis allowDecimals={false} width={32} tickLine={false} axisLine={false} />
              <Tooltip />
              <Bar dataKey="count" name="到期數" fill={C_DUE} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <h2>卡片狀態</h2>
      <div className="chart-block state-dist">
        {cards.length === 0 ? (
          <p className="empty">還沒有卡片 —— 到匯入頁或牌組頁新增</p>
        ) : (
          <>
            <ResponsiveContainer width={200} height={200}>
              <PieChart>
                <Pie data={dist} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80}>
                  {dist.map((d) => <Cell key={d.name} fill={d.color} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
            <ul className="dist-legend">
              {dist.map((d) => (
                <li key={d.name}><span className="dot" style={{ background: d.color }} />{d.name}:{d.value}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
