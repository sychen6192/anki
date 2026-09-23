#!/usr/bin/env bash
# 部署後的煙霧測試:確認線上版本的路由與標頭沒有被設定弄壞。
# 用法:scripts/smoke-test.sh https://anki-pwa.<account>.workers.dev
# CI 的 deploy job 在 wrangler deploy 之後會自動跑;手動部署後也可以自己跑。
set -euo pipefail

base="${1:?用法:scripts/smoke-test.sh <部署網址>}"
base="${base%/}"

# 1) /api/* 必須進 Worker 回 JSON。wrangler.jsonc 的 run_worker_first 漏列 /api/* 時,
#    這裡會拿到 SPA 的 index.html(一樣是 200),同步就炸在 JSON parse —— 以前真的發生過。
#    剛部署完 workers.dev 可能要幾秒才生效,重試幾次。
health=""
for _ in 1 2 3 4 5 6; do
  health=$(curl -sS --max-time 10 "$base/api/health" || true)
  [[ "$health" == *'"ok":true'* ]] && break
  sleep 5
done
if [[ "$health" != *'"ok":true'* ]]; then
  # 只印第一行:拿到 index.html 時第一行就是 <!doctype html>,一眼看出是路由問題
  echo "✗ $base/api/health 應該回 {\"ok\":true},實際拿到:${health%%$'\n'*}" >&2
  exit 1
fi

# 2) 頁面要帶 COOP/COEP:FSRS optimizer 需要 SharedArrayBuffer,少了 public/_headers 就跑不起來
headers=$(curl -sS --max-time 10 -D - -o /dev/null "$base/")
for h in 'cross-origin-opener-policy: same-origin' 'cross-origin-embedder-policy: require-corp'; do
  if ! grep -qi "^$h" <<<"$headers"; then
    echo "✗ $base/ 缺少標頭 $h" >&2
    exit 1
  fi
done

echo "✓ $base:API 路由與跨來源隔離標頭都正常"
