import { splitMorae, pitchPattern } from '../lib/pitch'

interface Props { reading: string; accent: string }

/**
 * 顯示読み + 重音。accent 為空/undefined → 只顯示純 reading(維持既有外觀)。
 * accent 非空 → 依第一個重音數字畫高低線,並在後面列出 [全部數字]。
 * 多重音(如 "0,3")只畫第一個的線,數字全列。pattern 非法時退回純 reading + 數字。
 */
export function PitchAccent({ reading, accent }: Props) {
  if (!accent) return <span className="reading">{reading}</span>

  const morae = splitMorae(reading)
  const primary = Number.parseInt(accent.split(',')[0] ?? '', 10)
  const pattern = Number.isNaN(primary) ? null : pitchPattern(morae.length, primary)

  return (
    <span className="pitch reading">
      {pattern ? (
        <span className="pitch-morae">
          {morae.map((m, i) => (
            <span
              key={i}
              className={
                'mora' + (pattern.high[i] ? ' high' : '') + (pattern.dropAfter === i + 1 ? ' drop' : '')
              }
            >
              {m}
            </span>
          ))}
        </span>
      ) : (
        <span>{reading}</span>
      )}
      <span className="pitch-num">[{accent}]</span>
    </span>
  )
}
