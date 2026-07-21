import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * 最後一道防線:任何 render 期例外(例如匯入或還原塞進形狀不對的資料)
 * 都不該讓整個 app 變成白畫面。至少要讓使用者看得到錯誤並能重新載入。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('未預期的錯誤', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash">
        <h1>出了點問題</h1>
        <p className="hint">你的資料還在本機,沒有遺失。重新載入通常就能繼續。</p>
        <pre className="crash-detail">{this.state.error.message}</pre>
        <div className="form-actions">
          <button className="btn" onClick={() => window.location.reload()}>重新載入</button>
          <button className="btn secondary" onClick={() => { window.location.href = '/' }}>回牌組列表</button>
        </div>
      </div>
    )
  }
}
