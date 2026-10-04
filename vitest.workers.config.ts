import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations('migrations')
  return {
    test: {
      include: ['worker/**/*.spec.ts'],
      setupFiles: ['worker/apply-migrations.ts'],
      poolOptions: {
        workers: {
          miniflare: {
            // Bundled miniflare in @cloudflare/vitest-pool-workers@0.12.x only knows up to
            // 2026-01-03, so it falls back from this date (2026-07-01) with a benign warning in tests (known, accepted).
            compatibilityDate: '2026-07-01',
            d1Databases: ['DB'],
            bindings: { TEST_MIGRATIONS: migrations },
            // 與 wrangler.jsonc 的 ratelimits 同樣的量。沒帶 cf-connecting-ip 的請求不限(既有測試都沒帶),
            // 限流的測試自己帶一個測試專用的 IP
            ratelimits: {
              SYNC_LIMITER: { simple: { limit: 60, period: 10 } },
              SUMMARY_LIMITER: { simple: { limit: 20, period: 60 } },
              SHARE_CREATE_LIMITER: { simple: { limit: 10, period: 60 } },
              SHARE_READ_LIMITER: { simple: { limit: 60, period: 60 } },
              ACCENT_LIMITER: { simple: { limit: 60, period: 10 } },
            },
          },
        },
      },
    },
  }
})
