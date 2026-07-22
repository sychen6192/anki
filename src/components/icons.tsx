// 線條 icon 集(currentColor,深淺色自動適配),與 SpeakerIcon 同一套筆觸。
// 之前用 ↩ ✎ ⤼ 這類文字符號充當 icon,字型間長相不一、對不齊又醜。

const stroke = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

/** 復原:逆時針繞回的箭頭 */
export function UndoIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 14 4 9l5-5" {...stroke} />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" {...stroke} />
    </svg>
  )
}

/** 編輯:鉛筆 */
export function PencilIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" {...stroke} />
    </svg>
  )
}

/** 跳過:雙箭頭往前 */
export function SkipIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 17 5-5-5-5" {...stroke} />
      <path d="m13 17 5-5-5-5" {...stroke} />
    </svg>
  )
}
