import { useLiveQuery } from 'dexie-react-hooks'
import {
  Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { db } from '../db/db'
import { State } from '../lib/fsrs'
import { startOfToday } from '../lib/queue'
import { Loading } from '../components/Loading'

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
  const logs = useLiveQuery(() => db.review_logs.toArray(), [])
  const cards = useLiveQuery(() => db.cards.filter((c) => !c.deleted).toArray(), [])
  if (!logs || !cards) return <Loading />

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

  return (
    <div>
      <h1>統計</h1>

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
