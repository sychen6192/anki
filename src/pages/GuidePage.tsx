import { Link } from "react-router-dom";

/** 說明頁。一句能講完的不寫兩句,寫不出具體內容的句子直接刪。 */
export default function GuidePage() {
  return (
    <div>
      <h1>怎麼用</h1>
      <h2>快速開始</h2>
      <div className="settings-block">
        <ol className="guide-steps">
          <li>
            到
            <Link to="/import?mode=templates" className="link">
              匯入頁
            </Link>
            挑一份範本,或丟自己的 CSV / .apkg
          </li>
          <li>
            回「牌組」按<b>複習</b>
          </li>
          <li>想答案 → 點卡片翻面 → 評分</li>
        </ol>
      </div>

      <h2>評分怎麼按</h2>
      <div className="settings-block">
        <ul className="guide-rates">
          <li>
            <span className="rate-chip rating-1">重來</span>完全想不起來
          </li>
          <li>
            <span className="rate-chip rating-2">困難</span>想起來了,但很勉強
          </li>
          <li>
            <span className="rate-chip rating-3">普通</span>想了一下,答對了
          </li>
          <li>
            <span className="rate-chip rating-4">簡單</span>秒答
          </li>
        </ul>
        <p className="hint">
          小字是下次見到的間隔。按錯了點左上「復原上一張」。
        </p>
      </div>

      <h2>快捷鍵</h2>
      <div className="settings-block">
        <table className="kbd-table kbd-only">
          <tbody>
            <tr>
              <td>
                <kbd>空白鍵</kbd>
              </td>
              <td>顯示答案</td>
            </tr>
            <tr>
              <td>
                <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd>
              </td>
              <td>評分</td>
            </tr>
            <tr>
              <td>
                <kbd>E</kbd> / <kbd>S</kbd>
              </td>
              <td>編輯 / 跳過</td>
            </tr>
            <tr>
              <td>
                <kbd>U</kbd>
              </td>
              <td>復原上一張</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2>同步金鑰</h2>
      <div className="settings-block">
        <p>設定金鑰進度才能同步到雲端。沒設就只存在這台裝置。</p>
        <Link to="/settings" className="btn secondary">
          去設定金鑰
        </Link>
      </div>
    </div>
  );
}
