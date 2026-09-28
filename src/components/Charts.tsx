import { useState } from 'react'
import { niceTicks } from '../lib/stats'

export interface DayCount { day: string; count: number }

/**
 * 30 天的長條圖(統計頁的「過去 30 天」「未來 30 天」)。
 * 自己用 div 畫,不用圖表函式庫:recharts 掛上去之後會同步重畫好幾次,手機上一進統計頁
 * 就卡幾百毫秒(這段時間點分頁都沒反應),整包也有 100KB。
 * 點一根(滑鼠移過去)在上面浮出那天的數字;圖本身對讀螢幕隱藏,旁邊的 .chart-summary 有文字版。
 */
export function DayBars({ data, color, unit }: { data: DayCount[]; color: string; unit: string }) {
  const [selected, setSelected] = useState<number | null>(null)
  const ticks = niceTicks(Math.max(0, ...data.map((d) => d.count)))
  const top = ticks[ticks.length - 1]
  const pick = selected === null ? null : data[selected]
  // 提示框置中在那根上面,靠邊時往內收,不跑出圖外
  const tipLeft = selected === null ? 0 : Math.min(85, Math.max(15, ((selected + 0.5) / data.length) * 100))
  return (
    <div className="bars" aria-hidden="true"
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') setSelected(null) }}>
      <div className="bars-y">
        {ticks.map((t) => <span key={t} style={{ bottom: `${(t / top) * 100}%` }}>{t}</span>)}
      </div>
      <div className="bars-plot" style={{ gridTemplateColumns: `repeat(${data.length}, 1fr)` }}>
        {data.map((d, i) => (
          <div key={i} className={`bar-slot${selected === i ? ' selected' : ''}`}
            // 滑鼠:移過去就出現;手指:點一下出現、再點一下收起來(拖動捲頁面時是 pointercancel,不會觸發)
            onPointerEnter={(e) => { if (e.pointerType === 'mouse') setSelected(i) }}
            onPointerUp={(e) => { if (e.pointerType !== 'mouse') setSelected((s) => (s === i ? null : i)) }}>
            {d.count > 0 && <span className="bar" style={{ height: `${(d.count / top) * 100}%`, background: color }} />}
          </div>
        ))}
        {pick !== null && (
          <div className="bar-tip" style={{ left: `${tipLeft}%` }}>{pick.day} · <b>{pick.count}</b> {unit}</div>
        )}
      </div>
      <div className="bars-x" style={{ gridTemplateColumns: `repeat(${data.length}, 1fr)` }}>
        {/* 一週標一次日期(從第一天起) */}
        {data.map((d, i) => <span key={i}>{i % 7 === 0 ? d.day : ''}</span>)}
      </div>
    </div>
  )
}

export interface DonutPart { name: string; value: number; color: string }

/** 甜甜圈圖(卡片狀態分布):從 12 點鐘方向順時針排;數字在旁邊的圖例裡 */
export function Donut({ parts, size = 150, thickness = 26 }: { parts: DonutPart[]; size?: number; thickness?: number }) {
  const r = (size - thickness) / 2 - 5
  const circumference = 2 * Math.PI * r
  const total = parts.reduce((a, p) => a + p.value, 0)
  let offset = 0
  return (
    <svg className="donut" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {total > 0 && parts.map((p) => {
          if (p.value <= 0) return null
          const len = (p.value / total) * circumference
          const arc = (
            <circle key={p.name} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={p.color}
              strokeWidth={thickness} strokeDasharray={`${len} ${circumference - len}`} strokeDashoffset={-offset} />
          )
          offset += len
          return arc
        })}
      </g>
    </svg>
  )
}
