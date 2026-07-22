import { Link } from 'react-router-dom'

/**
 * 給新使用者的說明頁。字越少越好:一句能講完的不用兩句,
 * 能用條列與色塊示意的不用段落。
 */
export default function GuidePage() {
  return (
    <div>
      <h1>怎麼用</h1>
      <p className="guide-lead">
        這是一副會自己排進度的單字卡:快忘的字常出現,記熟的字隔很久才出現。
        每天把到期的卡看完,就是全部要做的事。
      </p>

      <h2>快速開始</h2>
      <div className="settings-block">
        <ol className="guide-steps">
          <li>到<Link to="/import?mode=templates" className="link">匯入頁</Link>挑一份範本,或匯入自己的 CSV / .apkg</li>
          <li>回「牌組」按<b>複習</b></li>
          <li>想答案 → 點卡片翻面 → 評分</li>
        </ol>
      </div>

      <h2>評分怎麼按</h2>
      <div className="settings-block">
        <ul className="guide-rates">
          <li><span className="rate-chip rating-1">重來</span>完全想不起來</li>
          <li><span className="rate-chip rating-2">困難</span>想起來了,但很勉強</li>
          <li><span className="rate-chip rating-3">普通</span>想了一下,答對了</li>
          <li><span className="rate-chip rating-4">簡單</span>秒答</li>
        </ul>
        <p className="hint">鈕上的小字 = 下次見到的間隔。按錯了點左上「復原上一張」。</p>
      </div>

      <h2>複習中</h2>
      <div className="settings-block">
        <ul className="guide-steps">
          <li><b>編輯這張</b>:當場改字,不中斷複習</li>
          <li><b>跳過</b>:這次先不看,下次還會出現</li>
          <li>喇叭鈕唸給你聽;讀音上的折線是重音(東京腔高低音)</li>
        </ul>
        <table className="kbd-table kbd-only">
          <tbody>
            <tr><td><kbd>空白鍵</kbd></td><td>顯示答案</td></tr>
            <tr><td><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></td><td>評分</td></tr>
            <tr><td><kbd>E</kbd> / <kbd>S</kbd></td><td>編輯 / 跳過</td></tr>
          </tbody>
        </table>
      </div>

      <h2>每天的量</h2>
      <div className="settings-block">
        <p>新卡預設每天 20 張,在牌組頁的「牌組設定」調整;覺得重就調低。</p>
        <p className="hint">換日時間是凌晨 4 點,半夜複習不會突然多出一天的量。</p>
      </div>

      <h2>同步金鑰</h2>
      <div className="settings-block">
        <p>
          多台裝置填同一組金鑰,進度就同步到一起。
          <b>沒設金鑰 = 和其他沒設的人共用預設空間</b>,建議設一組自己的。
        </p>
        <Link to="/settings" className="btn secondary">去設定金鑰</Link>
      </div>
    </div>
  )
}
