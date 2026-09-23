import { Link } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'
import { MoreIcon, PlusIcon, UndoIcon } from '../components/icons'
import './guide.css'

/** 說明頁。一句能講完的不寫兩句,寫不出具體內容的句子直接刪。 */
export default function GuidePage() {
  return (
    <>
      <PageHeader title="使用說明" back={{ to: '/settings', label: '設定' }} />

      <section className="guide-card card">
        <h2>快速開始</h2>
        <ol className="guide-steps">
          <li>
            在「牌組」按右上的 <span className="inline-icon"><PlusIcon size={15} /></span>,
            <Link to="/import?mode=templates" className="inline-link">挑一份範本</Link>、匯入自己的 CSV / Anki 牌組，
            或貼上朋友的分享連結
          </li>
          <li>回「牌組」按 <b>開始複習</b>；好幾副牌組會一起複習，也可以按每副右邊的小按鈕單獨複習</li>
          <li>先想答案 → 點卡片或「顯示答案」翻面 → 照記得的程度評分</li>
        </ol>
      </section>

      <section className="guide-card card">
        <h2>評分怎麼按</h2>
        <ul className="guide-rates">
          <li><span className="rate-chip rating-1">重來</span>完全想不起來</li>
          <li><span className="rate-chip rating-2">困難</span>想起來了，但很勉強</li>
          <li><span className="rate-chip rating-3">普通</span>想了一下，答對了</li>
          <li><span className="rate-chip rating-4">簡單</span>秒答</li>
        </ul>
        <p className="hint">按鈕上的小字是下次見到的間隔。按錯了按右上的
          <span className="inline-icon"><UndoIcon size={14} /></span>復原，可以連續退好幾步。</p>
      </section>

      <section className="guide-card card">
        <h2>不想再看到某個字</h2>
        <p>複習時按右上的 <span className="inline-icon"><MoreIcon size={15} /></span>:</p>
        <ul className="guide-list">
          <li><b>已經會了</b>：早就會的字，之後不再出現</li>
          <li><b>擱置這個字</b>：先不學，之後想學再恢復</li>
          <li><b>跳過</b>：只是這次先不看，等一下還會出現</li>
        </ul>
        <p className="hint">牌組頁的「⋯」→「選取多張」可以一次處理很多字，也能恢復。</p>
      </section>

      <section className="guide-card card kbd-only">
        <h2>鍵盤快捷鍵</h2>
        <table className="kbd-table">
          <tbody>
            <tr><td><kbd>空白鍵</kbd></td><td>顯示答案；翻面後等於「普通」</td></tr>
            <tr><td><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></td><td>評分</td></tr>
            <tr><td><kbd>E</kbd> / <kbd>S</kbd></td><td>編輯 / 跳過</td></tr>
            <tr><td><kbd>U</kbd></td><td>復原上一步</td></tr>
            <tr><td><kbd>K</kbd></td><td>已經會了</td></tr>
            <tr><td><kbd>Esc</kbd></td><td>結束複習</td></tr>
          </tbody>
        </table>
      </section>

      <section className="guide-card card">
        <h2>同步與備份</h2>
        <p>設一組同步金鑰，手機和電腦的進度就會同步；沒設就只存在這台裝置。</p>
        <p className="hint">金鑰在「設定」→「同步金鑰」。也可以在設定頁下載完整備份。</p>
        <Link to="/settings" className="btn secondary guide-btn">前往設定</Link>
      </section>
    </>
  )
}
