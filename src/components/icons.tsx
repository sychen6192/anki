// 線條 icon 集(currentColor,深淺色自動適配),與 SpeakerIcon 同一套筆觸。
// 之前用 ↩ ✎ ⤼ 這類文字符號充當 icon,字型間長相不一、對不齊又醜。

import type { ReactNode } from 'react'

const stroke = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

interface IconProps { size?: number }

function Svg({ size = 16, children }: IconProps & { children: ReactNode }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">{children}</svg>
}

/** 復原:逆時針繞回的箭頭 */
export function UndoIcon({ size = 16 }: IconProps) {
  return <Svg size={size}><path d="M9 14 4 9l5-5" {...stroke} /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" {...stroke} /></Svg>
}

/** 編輯:鉛筆 */
export function PencilIcon({ size = 16 }: IconProps) {
  return <Svg size={size}><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" {...stroke} /></Svg>
}

/** 已經會了:勾 */
export function CheckIcon({ size = 16 }: IconProps) {
  return <Svg size={size}><path d="m5 12.5 4.5 4.5L19 7" {...stroke} /></Svg>
}

/** 跳過:雙箭頭往前 */
export function SkipIcon({ size = 16 }: IconProps) {
  return <Svg size={size}><path d="m6 17 5-5-5-5" {...stroke} /><path d="m13 17 5-5-5-5" {...stroke} /></Svg>
}

/** 分頁列「牌組」:一疊卡片 */
export function DecksIcon({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="7" width="14" height="13" rx="2.5" {...stroke} />
      <path d="M7 4.5h10.5A2.5 2.5 0 0 1 20 7v10.5" {...stroke} />
    </Svg>
  )
}

/** 分頁列「統計」:長條圖 */
export function ChartIcon({ size = 24 }: IconProps) {
  return <Svg size={size}><path d="M5 20V11" {...stroke} /><path d="M12 20V5" {...stroke} /><path d="M19 20v-6" {...stroke} /></Svg>
}

/** 分頁列「設定」:齒輪 */
export function GearIcon({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="3" {...stroke} />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" {...stroke} />
    </Svg>
  )
}

export function PlusIcon({ size = 22 }: IconProps) {
  return <Svg size={size}><path d="M12 5v14" {...stroke} /><path d="M5 12h14" {...stroke} /></Svg>
}

/** 更多動作:橫的三個點 */
export function MoreIcon({ size = 22 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="5.5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1.6" fill="currentColor" />
    </Svg>
  )
}

export function CloseIcon({ size = 22 }: IconProps) {
  return <Svg size={size}><path d="M6 6l12 12" {...stroke} /><path d="M18 6 6 18" {...stroke} /></Svg>
}

export function ChevronLeftIcon({ size = 22 }: IconProps) {
  return <Svg size={size}><path d="m15 5-7 7 7 7" {...stroke} /></Svg>
}

export function ChevronRightIcon({ size = 16 }: IconProps) {
  return <Svg size={size}><path d="m9 5 7 7-7 7" {...stroke} /></Svg>
}

export function ChevronDownIcon({ size = 14 }: IconProps) {
  return <Svg size={size}><path d="m6 9 6 6 6-6" {...stroke} /></Svg>
}

export function SearchIcon({ size = 18 }: IconProps) {
  return <Svg size={size}><circle cx="11" cy="11" r="6.5" {...stroke} /><path d="m20 20-4.2-4.2" {...stroke} /></Svg>
}

/** 分享:方框加向上箭頭(iOS 的分享符號) */
export function ShareIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 3v12" {...stroke} /><path d="m8 7 4-4 4 4" {...stroke} />
      <path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" {...stroke} />
    </Svg>
  )
}

/** 下載 / 匯出 */
export function DownloadIcon({ size = 20 }: IconProps) {
  return <Svg size={size}><path d="M12 4v11" {...stroke} /><path d="m7 10 5 5 5-5" {...stroke} /><path d="M5 20h14" {...stroke} /></Svg>
}

/** 上傳 / 匯入檔案 */
export function UploadIcon({ size = 20 }: IconProps) {
  return <Svg size={size}><path d="M12 15V4" {...stroke} /><path d="m7 9 5-5 5 5" {...stroke} /><path d="M5 20h14" {...stroke} /></Svg>
}

export function TrashIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 7h16" {...stroke} /><path d="M9 7V4.5h6V7" {...stroke} />
      <path d="M6.5 7 7.5 20h9l1-13" {...stroke} /><path d="M10 11v5.5" {...stroke} /><path d="M14 11v5.5" {...stroke} />
    </Svg>
  )
}

/** 自動標註重音:閃光 */
export function SparklesIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M10 3.5 11.6 8.4 16.5 10l-4.9 1.6L10 16.5l-1.6-4.9L3.5 10l4.9-1.6Z" {...stroke} />
      <path d="M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z" {...stroke} />
    </Svg>
  )
}

/** 選取多張:圈起來的勾 */
export function SelectIcon({ size = 20 }: IconProps) {
  return <Svg size={size}><circle cx="12" cy="12" r="8.5" {...stroke} /><path d="m8.5 12.3 2.4 2.4 4.8-5" {...stroke} /></Svg>
}

/** 牌組設定:滑桿 */
export function SlidersIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 7h9" {...stroke} /><path d="M17 7h3" {...stroke} /><circle cx="15" cy="7" r="2" {...stroke} />
      <path d="M4 17h3" {...stroke} /><path d="M11 17h9" {...stroke} /><circle cx="9" cy="17" r="2" {...stroke} />
    </Svg>
  )
}

/** 說明:打開的書 */
export function BookIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 6.5C10.5 5 8 4.5 4 4.5v14c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-14c-4 0-6.5.5-8 2Z" {...stroke} />
      <path d="M12 6.5v14" {...stroke} />
    </Svg>
  )
}

/** 分享連結:兩個扣環 */
export function LinkIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" {...stroke} />
      <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" {...stroke} />
    </Svg>
  )
}

/** 範本:疊起來的層 */
export function LayersIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m12 3 9 5-9 5-9-5Z" {...stroke} /><path d="m3 12.5 9 5 9-5" {...stroke} /><path d="m3 17 9 5 9-5" {...stroke} />
    </Svg>
  )
}

/** 檔案(CSV / Anki 牌組) */
export function FileIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" {...stroke} /><path d="M14 3v5h5" {...stroke} />
    </Svg>
  )
}

/** 新增牌組:一張卡片加號 */
export function NewDeckIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="4" y="4" width="16" height="16" rx="3" {...stroke} /><path d="M12 8.5v7" {...stroke} /><path d="M8.5 12h7" {...stroke} />
    </Svg>
  )
}

/** 同步:兩個繞圈箭頭 */
export function SyncIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" {...stroke} /><path d="M4 4v4h4" {...stroke} />
      <path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" {...stroke} /><path d="M20 20v-4h-4" {...stroke} />
    </Svg>
  )
}

/** 排序:上下箭頭 */
export function SortIcon({ size = 18 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M8 4v16" {...stroke} /><path d="m4 8 4-4 4 4" {...stroke} />
      <path d="M16 20V4" {...stroke} /><path d="m12 16 4 4 4-4" {...stroke} />
    </Svg>
  )
}

/** 開始複習:實心三角 */
export function PlayIcon({ size = 14 }: IconProps) {
  return <Svg size={size}><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z" fill="currentColor" /></Svg>
}

/** 連續天數:火焰 */
export function FlameIcon({ size = 16 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 21c-3.9 0-7-2.8-7-6.6 0-3.3 2.2-5.4 3.8-7.3.4 1.9 1.4 3.2 2.7 3.9C11.4 7.5 12.6 5 14.7 3c.5 3 4.3 5.6 4.3 11.1C19 18 15.9 21 12 21Z" {...stroke} />
    </Svg>
  )
}

/** 擱置:收進盒子(不是「暫停播放」的兩條直線) */
export function ArchiveIcon({ size = 20 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="5" rx="1.5" {...stroke} />
      <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" {...stroke} /><path d="M10 13h4" {...stroke} />
    </Svg>
  )
}
