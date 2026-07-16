// 線條喇叭 icon(currentColor,深淺色自動適配)。用於發音按鈕。
export function SpeakerIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9h3l5-4v14l-5-4H4z" fill="currentColor" />
      <path d="M16 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" />
      <path d="M18.5 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" />
    </svg>
  )
}
