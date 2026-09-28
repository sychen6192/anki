// 產生 App 的所有圖示(PWA、主畫面、網頁小圖示)。來源 scripts/icon-source.webp 是一張白底、
// 中間一個藍色圓角方塊的圖;這裡把白底去掉、各平台需要的樣子各做一份:
//   apple-touch-icon-180x180.png  滿版方塊(iPhone 會自己裁圓角;留著白角會在圓角裡露出白邊)
//   maskable-icon-512x512.png     滿版方塊,圖案縮到中間的安全區(Android 會裁成圓形或各種形狀)
//   pwa-64/192/512、favicon-48    圓角方塊、四角透明
// 用法:node scripts/build-icons.mjs [輸出資料夾,預設 public]
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.join(root, 'scripts/icon-source.webp')
const OUT = path.resolve(process.argv[2] ?? path.join(root, 'public'))

const { data, info } = await sharp(SRC).removeAlpha().raw().toBuffer({ resolveWithObject: true })
const W = info.width, H = info.height
const at = (x, y, c) => data[(y * W + x) * 3 + c]
const isBlue = (x, y) => at(x, y, 2) > 150 && at(x, y, 2) - at(x, y, 0) > 60

// 圓角方塊的範圍:每一列最左/最右、每一欄最上/最下的藍色像素
const rowL = new Int32Array(H).fill(-1), rowR = new Int32Array(H).fill(-1)
const colT = new Int32Array(W).fill(-1), colB = new Int32Array(W).fill(-1)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!isBlue(x, y)) continue
    if (rowL[y] < 0) rowL[y] = x
    rowR[y] = x
    if (colT[x] < 0) colT[x] = y
    colB[x] = y
  }
}
let minX = W, maxX = 0, minY = H, maxY = 0
for (let y = 0; y < H; y++) if (rowL[y] >= 0) { minX = Math.min(minX, rowL[y]); maxX = Math.max(maxX, rowR[y]); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
const cx = (minX + maxX + 1) / 2, cy = (minY + maxY + 1) / 2
const S = maxX - minX + 1 // 方塊的邊長(寬;高差不到 2%)

/** 到圓角方塊邊緣的距離(像素,裡面為正、外面為負);列與欄兩個方向取近的,邊緣附近本來就只有背景,近似就夠 */
function edgeDist(x, y) {
  const xi = Math.round(x), yi = Math.round(y)
  if (xi < 0 || yi < 0 || xi >= W || yi >= H || rowL[yi] < 0 || colT[xi] < 0) {
    return -Math.max(minX - x, x - maxX, minY - y, y - maxY, 1)
  }
  return Math.min(xi - rowL[yi], rowR[yi] - xi, yi - colT[xi], colB[xi] - yi)
}

// 背景漸層:方塊裡靠邊的一圈(卡片碰不到)做最小平方擬合,c = 二次多項式(u, v)
const basis = (x, y) => { const u = (x - cx) / (S / 2), v = (y - cy) / (S / 2); return [1, u, v, u * u, v * v, u * v] }
const K = 6
const model = [0, 1, 2].map((c) => {
  const A = Array.from({ length: K }, () => new Float64Array(K)), b = new Float64Array(K)
  for (let y = minY; y <= maxY; y += 2) {
    for (let x = minX; x <= maxX; x += 2) {
      const d = edgeDist(x, y)
      if (d < 12 || d > 70 || !isBlue(x, y)) continue
      const f = basis(x, y), val = at(x, y, c)
      for (let i = 0; i < K; i++) { b[i] += f[i] * val; for (let j = 0; j < K; j++) A[i][j] += f[i] * f[j] }
    }
  }
  // 高斯消去
  for (let i = 0; i < K; i++) {
    let p = i
    for (let r = i + 1; r < K; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r
    ;[A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]]
    for (let r = i + 1; r < K; r++) {
      const m = A[r][i] / A[i][i]
      for (let j = i; j < K; j++) A[r][j] -= m * A[i][j]
      b[r] -= m * b[i]
    }
  }
  const coef = new Float64Array(K)
  for (let i = K - 1; i >= 0; i--) {
    let s = b[i]
    for (let j = i + 1; j < K; j++) s -= A[i][j] * coef[j]
    coef[i] = s / A[i][i]
  }
  return coef
})
const bg = (x, y, c) => { const f = basis(x, y); let s = 0; for (let i = 0; i < K; i++) s += model[c][i] * f[i]; return s }

const sample = (x, y, c) => {
  const fx = Math.min(Math.max(x - 0.5, 0), W - 1), fy = Math.min(Math.max(y - 0.5, 0), H - 1)
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1)
  const tx = fx - x0, ty = fy - y0
  return (at(x0, y0, c) * (1 - tx) + at(x1, y0, c) * tx) * (1 - ty) + (at(x0, y1, c) * (1 - tx) + at(x1, y1, c) * tx) * ty
}
const smooth = (t) => { const k = Math.min(Math.max(t, 0), 1); return k * k * (3 - 2 * k) }

/**
 * 畫一張 N×N:toSrc 把畫布座標換成來源座標。背景一律用擬合的漸層(方塊外也延伸得出去),
 * 方塊裡用原圖、靠邊的地方淡入漸層 —— 原本的白角、邊緣的白邊都不會留下來。
 * rounded:四角透明,輪廓照原圖的圓角(邊緣的半透明從原圖算,外面淡淡的陰影不要)。
 */
function render(N, toSrc, rounded) {
  const ch = rounded ? 4 : 3
  const out = Buffer.alloc(N * N * ch)
  for (let Y = 0; Y < N; Y++) {
    for (let X = 0; X < N; X++) {
      const [x, y] = toSrc(X + 0.5, Y + 0.5)
      const d = edgeDist(x, y)
      const w = smooth((d - 8) / 10)
      const i = (Y * N + X) * ch
      for (let c = 0; c < 3; c++) {
        const v = w > 0 ? w * sample(x, y, c) + (1 - w) * bg(x, y, c) : bg(x, y, c)
        out[i + c] = Math.round(Math.min(Math.max(v, 0), 255))
      }
      if (rounded) {
        let a = 1
        if (d < 2) {
          // 原圖邊緣是藍色和白底混出來的:照紅色通道算出藍色佔幾成
          a = (255 - sample(x, y, 0)) / Math.max(1, 255 - bg(x, y, 0))
          a = Math.min(Math.max(a, 0), 1)
          if (d < 0 && a < 0.12) a = 0
          if (d < -3) a = 0
        }
        out[i + 3] = Math.round(a * 255)
      }
    }
  }
  return sharp(out, { raw: { width: N, height: N, channels: ch } })
}

// 圖案(卡片、星星)離中心最遠多遠:maskable 要整個放進中間半徑 40% 的安全區
let reach = 0
for (let y = minY; y <= maxY; y += 2) {
  for (let x = minX; x <= maxX; x += 2) {
    if (edgeDist(x, y) < 12) continue
    let diff = 0
    for (let c = 0; c < 3; c++) diff += Math.abs(at(x, y, c) - bg(x, y, c))
    if (diff > 45) reach = Math.max(reach, Math.hypot(x - cx, y - cy) / (S / 2))
  }
}

let residual = 0, count = 0
for (let y = minY; y <= maxY; y += 4) for (let x = minX; x <= maxX; x += 4) {
  const d = edgeDist(x, y)
  if (d < 12 || d > 70) continue
  for (let c = 0; c < 3; c++) { residual += (at(x, y, c) - bg(x, y, c)) ** 2; count++ }
}
console.log(`來源 ${W}×${H},方塊 ${S}px(${minX}–${maxX}, ${minY}–${maxY});漸層誤差 ${Math.sqrt(residual / count).toFixed(2)};圖案最遠 ${reach.toFixed(3)}`)

const N = 1024
// 滿版:畫布剛好是方塊
const full = (X, Y) => [cx + (X / N - 0.5) * S, cy + (Y / N - 0.5) * S]
// maskable:圖案最遠的地方落在畫布半徑的 36%(安全區 40%,留一點餘裕)
const zoom = Math.min(1, 0.72 / reach)
const maskable = (X, Y) => [cx + (X / N - 0.5) * S / zoom, cy + (Y / N - 0.5) * S / zoom]
// 圓角:四周留白和原圖一樣(方塊佔 85%);網頁小圖示留少一點,縮小後比較看得清楚
const padded = (fill) => (X, Y) => [cx + (X / N - 0.5) * S / fill, cy + (Y / N - 0.5) * S / fill]
const anyFill = S / W

const fullPng = await render(N, full, false).png().toBuffer()
const maskablePng = await render(N, maskable, false).png().toBuffer()
const roundedPng = await render(N, padded(anyFill), true).png().toBuffer()
const faviconPng = await render(N, padded(0.94), true).png().toBuffer()

const write = (buf, size, name, flatten) => {
  let s = sharp(buf).resize(size, size, { kernel: 'lanczos3' })
  if (flatten) s = s.removeAlpha()
  return s.png({ compressionLevel: 9 }).toFile(path.join(OUT, name))
}
await write(fullPng, 180, 'apple-touch-icon-180x180.png', true)
await write(maskablePng, 512, 'maskable-icon-512x512.png', true)
for (const size of [64, 192, 512]) await write(roundedPng, size, `pwa-${size}x${size}.png`, false)
await write(faviconPng, 48, 'favicon-48.png', false)
console.log(`maskable 縮放 ${zoom.toFixed(3)};輸出到 ${OUT}`)
