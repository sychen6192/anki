import { useLiveQuery } from 'dexie-react-hooks'
import {
  Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { db } from '../db/db'
import { State } from '../lib/fsrs'
import { startOfToday } from '../lib/queue'

const DAY = 86400_000

function dayLabel(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export default function StatsPage() {
  const logs = useLiveQuery(() => db.review_logs.toArray(), [])
  const cards = useLiveQuery(() => db.cards.filter((c) => !c.deleted).toArray(), [])
  if (!logs || !cards) return null

  const today = startOfToday()

  const past = Array.from({ length: 30 }, (_, i) => {
    const start = today - (29 - i) * DAY
    return {
      day: dayLabel(start),
      count: logs.filter((l) => l.reviewed_at >= start && l.reviewed_at < start + DAY).length,
    }
  })

  const scheduled = cards.filter((c) => c.state !== State.New)
  const forecast = Array.from({ length: 30 }, (_, i) => {
    const start = today + i * DAY
    return {
      day: dayLabel(start),
      // 已逾期的卡算在今天
      count: scheduled.filter((c) => (i === 0 ? c.due < start + DAY : c.due >= start && c.due < start + DAY)).length,
    }
  })

  const dist = [
    { name: '新卡', value: cards.filter((c) => c.state === State.New).length, color: '#2563eb' },
    { name: '學習中', value: cards.filter((c) => c.state === State.Learning || c.state === State.Relearning).length, color: '#dc2626' },
    { name: '複習中', value: cards.filter((c) => c.state === State.Review).length, color: '#16a34a' },
  ]

  return (
    <div>
      <h1>統計</h1>

      <h2>過去 30 天複習量</h2>
      <div className="chart-block">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={past}>
            <XAxis dataKey="day" interval={6} tickLine={false} />
            <YAxis allowDecimals={false} width={32} tickLine={false} axisLine={false} />
            <Tooltip />
            <Bar dataKey="count" name="複習數" fill="#4f46e5" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <h2>未來 30 天到期預測</h2>
      <div className="chart-block">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={forecast}>
            <XAxis dataKey="day" interval={6} tickLine={false} />
            <YAxis allowDecimals={false} width={32} tickLine={false} axisLine={false} />
            <Tooltip />
            <Bar dataKey="count" name="到期數" fill="#16a34a" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <h2>卡片狀態</h2>
      <div className="chart-block state-dist">
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
      </div>
    </div>
  )
}
