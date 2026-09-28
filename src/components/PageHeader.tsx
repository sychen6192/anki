import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeftIcon } from './icons'

interface Props {
  title: ReactNode
  /** 導覽列中間的小標題(捲動後出現);預設跟大標題一樣 */
  shortTitle?: string
  /** 返回上一層:{ to: '/', label: '牌組' } */
  back?: { to: string; label: string }
  /** 導覽列左側另外放的東西(例如批次選取時的「取消」),有 back 時不顯示 */
  leading?: ReactNode
  /** 導覽列右側的圖示鈕 */
  actions?: ReactNode
  subtitle?: ReactNode
}

/**
 * iOS 樣式的頁首:上面一條黏在頂端的導覽列(返回、動作),下面大標題。
 * 大標題捲到導覽列底下後,導覽列中間才浮出小標題。
 * 回傳 fragment:導覽列要是 .page 的直接子元素,sticky 才黏得住整頁。
 */
export function PageHeader({ title, shortTitle, back, leading, actions, subtitle }: Props) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 34)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <>
      <div className={`nav-bar${scrolled ? ' scrolled' : ''}`}>
        <div className="nav-bar-side">
          {back ? (
            <Link to={back.to} className="back-btn"><ChevronLeftIcon size={24} />{back.label}</Link>
          ) : leading}
        </div>
        <div className="nav-bar-title" aria-hidden="true">{shortTitle ?? (typeof title === 'string' ? title : '')}</div>
        <div className="nav-bar-side end">{actions}</div>
      </div>
      <h1 className="large-title">{title}</h1>
      {subtitle !== undefined && <div className="page-subtitle">{subtitle}</div>}
    </>
  )
}
