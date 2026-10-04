import type { D1Migration } from 'cloudflare:test'

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database
    TEST_MIGRATIONS: D1Migration[]
    SYNC_LIMITER: RateLimit
    SUMMARY_LIMITER: RateLimit
    LEGACY_KEY_LIMITER: RateLimit
    SHARE_CREATE_LIMITER: RateLimit
    SHARE_READ_LIMITER: RateLimit
    ACCENT_LIMITER: RateLimit
  }
}
