import { useEffect, useState, type ReactNode } from 'react'
import { PageHeader } from '../components/PageHeader'
import { ListSection } from '../components/controls'
import { ChevronDownIcon } from '../components/icons'
import { Loading } from '../components/Loading'
import { loadLicenses, reflow, type LicensesFile, type PackageNotice } from '../lib/licenses'
import './licenses.css'

/**
 * 授權與資料來源:App 裡用到別人的東西都在這裡註明(上架必備)。
 * 套件清單是建置時照實際打包的模組產生的 JSON(見 vite-plugins/thirdPartyLicenses.ts),
 * 跟這一頁一樣按需載入,不進主程式。
 */
export default function LicensesPage() {
  const [state, setState] = useState<{ status: 'loading' | 'error' } | { status: 'ok'; data: LicensesFile }>(
    { status: 'loading' },
  )
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    loadLicenses().then(
      (data) => { if (alive) setState({ status: 'ok', data }) },
      () => { if (alive) setState({ status: 'error' }) },
    )
    return () => { alive = false }
  }, [attempt])
  const retry = () => { setState({ status: 'loading' }); setAttempt((n) => n + 1) }

  return (
    <>
      <PageHeader title="授權與資料來源" back={{ to: '/settings', label: '設定' }} />

      <ListSection header="資料來源">
        <div className="row source-row">
          <span className="row-title">日文重音</span>
          {/* JSX 裡文字中間換行會變成一個空白:中文句子不在文字中間換行,要換就換在標籤旁邊 */}
          <p>
            重音資料來自 <ExternalLink href={KANJIUM_URL}>kanjium</ExternalLink>（作者 Uros&nbsp;O.），以{' '}
            <ExternalLink href={CC_BY_SA_URL}>CC BY-SA 4.0</ExternalLink> 授權。
          </p>
          <p>本 App 把其中的 accents.txt 轉成查詢表（轉換格式、讀音改成平假名、去掉重複和格式不對的資料），用來自動標註卡片的重音。改作後的重音資料同樣以 CC BY-SA 4.0 提供。</p>
          <p lang="en" className="source-quote">
            “The pitch accent notation, verb particle data, phonetics, homonyms and other additions or modifications
            to EDICT, KANJIDIC or KRADFILE were provided by Uros O. through his free database.”
          </p>
          <p>
            kanjium 的詞條大多來自 <ExternalLink href={EDRDG_URL}>EDRDG</ExternalLink> 的 EDICT 字典檔，依 EDRDG 的授權使用。
          </p>
        </div>
        <div className="row source-row">
          <span className="row-title">內建範本</span>
          <p>範本牌組的單字由本 App 自行整理。</p>
        </div>
        <div className="row source-row">
          <span className="row-title">複習排程</span>
          <p>
            用 FSRS 演算法排下次複習的時間，程式來自 <ExternalLink href={FSRS_URL}>Open Spaced Repetition</ExternalLink> 的
            ts-fsrs 與 fsrs-browser，授權條款在下面的套件清單裡。
          </p>
        </div>
      </ListSection>

      <ListSection header="圖示" footer="設定、復原等幾個線條圖示的路徑取自 Feather 與 Lucide。">
        <LicenseItem title="Feather" detail="MIT" url="https://github.com/feathericons/feather" text={FEATHER_LICENSE} />
        <LicenseItem title="Lucide" detail="ISC" url="https://github.com/lucide-icons/lucide" text={LUCIDE_LICENSE} />
      </ListSection>

      <ListSection header="開放原始碼套件" footer={
        state.status === 'ok' && state.data.partial
          ? '開發模式只列出 package.json 的直接相依套件，建置版才會列出完整清單。'
          : '依建置結果列出 App 裡實際用到的套件，點開看授權全文。'
      }>
        {state.status === 'loading' && <Loading />}
        {state.status === 'error' && (
          <div className="row">
            <span className="row-main">
              <span className="row-title">讀不到套件清單</span>
              <span className="row-subtitle">連上網路後再試一次。</span>
            </span>
            <button type="button" className="btn sm tinted" onClick={retry}>再試一次</button>
          </div>
        )}
        {state.status === 'ok' && state.data.packages.map((p) => (
          <LicenseItem key={`${p.name}@${p.version ?? ''}`} title={p.name} detail={packageDetail(p)}
            url={p.url} text={p.text} />
        ))}
      </ListSection>
    </>
  )
}

function packageDetail(p: PackageNotice): string {
  return [p.version, p.license, p.bundledIn && `包在 ${p.bundledIn} 裡`].filter(Boolean).join(' · ')
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="inline-link" href={href} target="_blank" rel="noreferrer">{children}</a>
}

/** 一列可以點開的授權:名稱、版本與授權代號,點開是專案網址與條款全文 */
function LicenseItem({ title, detail, url, text }: { title: string; detail: string; url?: string; text: string }) {
  return (
    <details className="license-item">
      <summary>
        <span className="row">
          <span className="row-main">
            <span className="row-title">{title}</span>
            <span className="row-subtitle">{detail}</span>
          </span>
          <span className="row-chevron"><ChevronDownIcon /></span>
        </span>
      </summary>
      <div className="license-body">
        {url && <ExternalLink href={url}>{url.replace(/^https?:\/\//, '')}</ExternalLink>}
        {text
          ? <pre className="license-text">{reflow(text)}</pre>
          : <p className="hint">套件沒有附上條款全文。</p>}
      </div>
    </details>
  )
}

const KANJIUM_URL = 'https://github.com/mifunetoshiro/kanjium'
const CC_BY_SA_URL = 'https://creativecommons.org/licenses/by-sa/4.0/'
const EDRDG_URL = 'https://www.edrdg.org/edrdg/licence.html'
const FSRS_URL = 'https://github.com/open-spaced-repetition'

// 授權條款原文照抄(圖示不是 npm 套件,建置時收不到,寫在這裡)
const FEATHER_LICENSE = `The MIT License (MIT)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

const LUCIDE_LICENSE = `ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`
