/** 捲動的動畫:使用者開了「減少動態效果」就直接跳過去(CSS 的設定管不到 JS 的 smooth 捲動) */
export function scrollBehavior(): ScrollBehavior {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}
