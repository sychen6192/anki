import { Component, createRef, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** 這個值變了(換頁)就收掉錯誤畫面重來。不用 key:用 key 的話每次換網址整棵子樹都重建,頁面自己的狀態也跟著不見 */
  resetKey?: string
}
interface State { error: Error | null }

/**
 * 最後一道防線:任何 render 期例外(例如匯入或還原塞進形狀不對的資料)
 * 都不該讓整個 app 變成白畫面。至少要讓使用者看得到錯誤並能重新載入。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }
  // 出錯時焦點移到標題:不然焦點留在 body,讀螢幕什麼都不唸,不知道頁面壞了
  private heading = createRef<HTMLHeadingElement>()

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  // 一打開 app 就出錯時,錯誤畫面是第一次 render,走的是這裡不是 componentDidUpdate
  componentDidMount() {
    if (this.state.error !== null) this.heading.current?.focus()
  }

  componentDidUpdate(prev: Props, prevState: State) {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
    else if (prevState.error === null && this.state.error !== null) this.heading.current?.focus()
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('未預期的錯誤', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash">
        <h1 ref={this.heading} tabIndex={-1}>出了點問題</h1>
        <p className="hint">你的資料還在本機，沒有遺失。重新載入通常就能繼續。</p>
        <div className="btn-stack">
          <button className="btn" onClick={() => window.location.reload()}>重新載入</button>
          <button className="btn secondary" onClick={() => { window.location.href = '/' }}>回牌組</button>
          {/* 牌組頁本身就壞掉時,從這裡去設定頁用「從備份還原」「清空這台並重新下載」 */}
          <button className="btn secondary" onClick={() => { window.location.href = '/settings' }}>前往設定</button>
        </div>
        {/* 英文的錯誤訊息是給回報問題用的:放在按鈕後面,不擋在安撫的話和「重新載入」中間 */}
        <p className="hint crash-detail-label">錯誤內容（回報問題時可以附上）：</p>
        <pre className="crash-detail">{this.state.error.message}</pre>
      </div>
    )
  }
}
