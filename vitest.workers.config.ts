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
          },
        },
      },
    },
  }
})
