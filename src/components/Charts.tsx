import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { niceTicks } from '../lib/stats'

export interface DayCount { day: string; count: number }

/**
 * 30 天的長條圖(統計頁的「過去 30 天」「未來 30 天」)。
 * 自己用 div 畫,不用圖表函式庫:recharts 掛上去之後會同步重畫好幾次,手機上一進統計頁
 * 就卡幾百毫秒(這段時間點分頁都沒反應),整包也有 100KB。
 * 滑鼠移過去、手指點一下或在圖上左右滑,上面浮出那天的數字。
 * 整張圖是一個 slider:鍵盤左右鍵一天一天看;iPhone 的 VoiceOver 上下滑會被 WebKit 轉成方向鍵。
 * today:今天在哪一頭。日期從今天往回(往後)每 7 天標一次,第一次按方向鍵也先停在今天。
 */
export function DayBars({ data, color, unit, label, today }: {
  data: DayCount[]; color: string; unit: string; label: string; today: 'start' | 'end'
}) {
  const [selected, setSelected] = useState<number | null>(null)
  // 手指按下去的那一格;移到別格就算在滑,放開時不再當成點一下
  const gesture = useRef<{ start: number; moved: boolean } | null>(null)
  const ticks = niceTicks(Math.max(0, ...data.map((d) => d.count)))
  const top = ticks[ticks.length - 1]
  const n = data.length
  const last = n - 1
  const todayIndex = today === 'end' ? last : 0
  const current = selected ?? todayIndex
  const pick = selected === null ? null : data[selected]
  // 提示框置中在那根上面;最靠邊的三根改成貼齊那根的外緣往內長,不會跑出圖外、也不會離那根太遠
  const tip = selected === null ? null
    : selected < 3 ? { left: selected / n, x: '0' }
      : selected > n - 4 ? { left: (selected + 1) / n, x: '-100%' }
        : { left: (selected + 0.5) / n, x: '-50%' }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && selected !== null) { e.preventDefault(); setSelected(null); return }
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
    const next = step !== 0 ? (selected === null ? todayIndex : Math.min(last, Math.max(0, selected + step)))
      : e.key === 'Home' ? 0 : e.key === 'End' ? last : undefined
    if (next === undefined) return
    e.preventDefault()
    setSelected(next)
  }

  // 觸控的事件一律在整張圖上算是哪一格:手指按下去的那格會隱含 capture 之後所有的 move/up,
  // 掛在各格上的話滑到別格、放開時還是算在一開始那格
  const indexAt = (e: PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return Math.min(last, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n)))
  }

  return (
    <div className="bars" onPointerLeave={(e) => { if (e.pointerType === 'mouse') setSelected(null) }}>
      <div className="bars-y" aria-hidden="true">
        {ticks.map((t) => <span key={t} style={{ bottom: `${(t / top) * 100}%` }}>{t}</span>)}
      </div>
      <div className="bars-plot" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}
        tabIndex={0} role="slider" aria-label={label}
        aria-valuemin={1} aria-valuemax={n} aria-valuenow={current + 1}
        aria-valuetext={`${data[current].day}，${data[current].count} ${unit}`}
        onKeyDown={onKeyDown} onBlur={() => setSelected(null)}
        // 手指:點一下出現、再點同一根收起來;左右滑一路換。上下拖是捲頁面,瀏覽器會送 pointercancel
        onPointerDown={(e) => { if (e.pointerType !== 'mouse') gesture.current = { start: indexAt(e), moved: false } }}
        onPointerMove={(e) => {
          const g = gesture.current
          if (!g || e.pointerType === 'mouse') return
          const i = indexAt(e)
          if (i !== g.start) g.moved = true
          if (g.moved) setSelected(i)
        }}
        onPointerUp={(e) => {
          const g = gesture.current
          gesture.current = null
          if (!g || e.pointerType === 'mouse' || g.moved) return
          const i = indexAt(e)
          setSelected((s) => (s === i ? null : i))
        }}
        onPointerCancel={() => { gesture.current = null }}>
        <div className="bars-grid" aria-hidden="true">
          {ticks.slice(1).map((t) => <span key={t} style={{ bottom: `${(t / top) * 100}%` }} />)}
        </div>
        {data.map((d, i) => (
          <div key={i} className={`bar-slot${selected === i ? ' selected' : ''}`} aria-hidden="true"
            onPointerEnter={(e) => { if (e.pointerType === 'mouse') setSelected(i) }}>
            {d.count > 0 && <span className="bar" style={{ height: `${(d.count / top) * 100}%`, background: color }} />}
          </div>
        ))}
        {pick !== null && tip !== null && (
          <div className="bar-tip" aria-hidden="true" style={{ left: `${tip.left * 100}%`, '--tip-x': tip.x } as CSSProperties}>
            {pick.day} · <b>{pick.count}</b> {unit}
          </div>
        )}
      </div>
      <div className="bars-x" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
        {data.map((d, i) => <span key={i}>{(today === 'end' ? last - i : i) % 7 === 0 ? d.day : ''}</span>)}
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
