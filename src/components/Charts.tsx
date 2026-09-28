import { useState, type KeyboardEvent } from 'react'
import { niceTicks } from '../lib/stats'

export interface DayCount { day: string; count: number }

/**
 * 30 天的長條圖(統計頁的「過去 30 天」「未來 30 天」)。
 * 自己用 div 畫,不用圖表函式庫:recharts 掛上去之後會同步重畫好幾次,手機上一進統計頁
 * 就卡幾百毫秒(這段時間點分頁都沒反應),整包也有 100KB。
 * 點一根(滑鼠移過去)在上面浮出那天的數字;鍵盤 Tab 到圖上,左右鍵一天一天看(讀螢幕會唸出來)。
 */
export function DayBars({ data, color, unit, label }: { data: DayCount[]; color: string; unit: string; label: string }) {
  const [selected, setSelected] = useState<number | null>(null)
  const ticks = niceTicks(Math.max(0, ...data.map((d) => d.count)))
  const top = ticks[ticks.length - 1]
  const pick = selected === null ? null : data[selected]
  // 提示框置中在那根上面,靠邊時往內收,不跑出圖外
  const tipLeft = selected === null ? 0 : Math.min(85, Math.max(15, ((selected + 0.5) / data.length) * 100))
  const onKeyDown = (e: KeyboardEvent) => {
    const last = data.length - 1
    const cur = selected ?? last + 1
    const next = e.key === 'ArrowLeft' ? Math.max(0, cur - 1)
      : e.key === 'ArrowRight' ? Math.min(last, selected === null ? last : cur + 1)
        : e.key === 'Home' ? 0 : e.key === 'End' ? last : undefined
    if (e.key === 'Escape' && selected !== null) { e.preventDefault(); setSelected(null); return }
    if (next === undefined) return
    e.preventDefault()
    setSelected(next)
  }
  return (
    <div className="bars" onPointerLeave={(e) => { if (e.pointerType === 'mouse') setSelected(null) }}>
      <div className="bars-y" aria-hidden="true">
        {ticks.map((t) => <span key={t} style={{ bottom: `${(t / top) * 100}%` }}>{t}</span>)}
      </div>
      <div className="bars-plot" style={{ gridTemplateColumns: `repeat(${data.length}, 1fr)` }}
        tabIndex={0} role="group" aria-label={`${label}，用左右鍵一天一天看`}
        onKeyDown={onKeyDown} onBlur={() => setSelected(null)}>
        {data.map((d, i) => (
          <div key={i} className={`bar-slot${selected === i ? ' selected' : ''}`} aria-hidden="true"
            // 滑鼠:移過去就出現;手指:點一下出現、再點一下收起來(拖動捲頁面時是 pointercancel,不會觸發)
            onPointerEnter={(e) => { if (e.pointerType === 'mouse') setSelected(i) }}
            onPointerUp={(e) => { if (e.pointerType !== 'mouse') setSelected((s) => (s === i ? null : i)) }}>
            {d.count > 0 && <span className="bar" style={{ height: `${(d.count / top) * 100}%`, background: color }} />}
          </div>
        ))}
        {pick !== null && (
          <div className="bar-tip" aria-hidden="true" style={{ left: `${tipLeft}%` }}>{pick.day} · <b>{pick.count}</b> {unit}</div>
        )}
        <span className="visually-hidden" aria-live="polite">{pick === null ? '' : `${pick.day}，${pick.count} ${unit}`}</span>
      </div>
      <div className="bars-x" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${data.length}, 1fr)` }}>
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
