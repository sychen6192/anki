import { Link } from 'react-router-dom'

/**
 * 給新使用者的說明頁:這個 app 在做什麼、怎麼開始、評分怎麼按。
 * 純靜態內容,句子講人話 —— 排程理論一句帶過,重點放在「你要做什麼」。
 */
export default function GuidePage() {
  return (
    <div>
      <h1>怎麼用</h1>

      <h2>這個 App 在做什麼</h2>
      <div className="settings-block">
        <p>
          它是一副會自己安排進度的單字卡。每張卡你評一次分,它就依你的記憶狀況
          決定下次什麼時候再考你 —— 快忘的字常出現,記熟的字隔很久才出現
          (排程用 FSRS 演算法,不用懂它,誠實評分就好)。
        </p>
        <p>每天打開、把到期的卡看完,就是全部要做的事。</p>
      </div>

      <h2>快速開始</h2>
      <div className="settings-block">
        <ol className="guide-steps">
          <li>
            準備單字:到<Link to="/import?mode=templates" className="link">匯入頁</Link>選一份現成範本、
            貼上自己的 CSV,或讀入 Anki 牌組(.apkg)。
          </li>
          <li>回到「牌組」,按<b>複習</b>。</li>
          <li>看著正面想答案 → 點卡片翻面 → 按下面四顆鈕評分。</li>
        </ol>
      </div>

      <h2>評分怎麼按</h2>
      <div className="settings-block">
        <p>翻面後照實回答「剛才想起來了嗎」:</p>
        <ul className="guide-rates">
          <li><span className="rate-chip rating-1">重來</span>完全想不起來</li>
          <li><span className="rate-chip rating-2">困難</span>想起來了,但很勉強</li>
          <li><span className="rate-chip rating-3">普通</span>想了一下,答對了</li>
          <li><span className="rate-chip rating-4">簡單</span>秒答</li>
        </ul>
        <p className="hint">
          按鈕下的小字是「下次再見到這張卡」的間隔。評錯了沒關係,左上角「復原上一張」可以反悔。
        </p>
      </div>

      <h2>複習中還能做什麼</h2>
      <div className="settings-block">
        <p>卡片下方:<b>編輯這張</b>直接改字(不中斷複習);<b>跳過</b>這次先不看(下次進來還會出現)。</p>
        <p>背面的喇叭鈕會唸給你聽;讀音上的折線是東京腔的高低音(重音)。</p>
        <table className="kbd-table kbd-only">
          <tbody>
            <tr><td><kbd>空白鍵</kbd></td><td>顯示答案</td></tr>
            <tr><td><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></td><td>重來/困難/普通/簡單</td></tr>
            <tr><td><kbd>E</kbd></td><td>編輯這張</td></tr>
            <tr><td><kbd>S</kbd></td><td>跳過</td></tr>
          </tbody>
        </table>
      </div>

      <h2>每天的量</h2>
      <div className="settings-block">
        <p>
          新卡預設每天 20 張,在牌組頁最下面的「牌組設定」可以調。
          覺得負擔太重就調低 —— 每天穩定複習,比一次背一堆有用。
        </p>
        <p className="hint">換日時間是凌晨 4 點(跟 Anki 一樣),半夜複習不會突然多出一天的量。</p>
      </div>

      <h2>多裝置同步與金鑰</h2>
      <div className="settings-block">
        <p>
          資料存在你的裝置上,並自動同步到雲端。<b>建議先到設定頁設一組自己的同步金鑰</b>:
          不設的話你用的是公用的預設空間,和其他沒設金鑰的人共用資料。
        </p>
        <p>
          手機、電腦填同一組金鑰,進度就會同步到一起;把 App 分享給朋友時,
          請對方設一組自己的金鑰,各用各的互不干擾。
        </p>
        <Link to="/settings" className="btn secondary">去設定金鑰</Link>
      </div>
    </div>
  )
}
