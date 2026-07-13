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
            compatibilityDate: '2026-07-01',
            d1Databases: ['DB'],
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  }
})
