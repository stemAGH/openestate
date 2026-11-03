import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.test.ts'],
    // Run separately, after every other suite: see vitest.serial.config.ts.
    exclude: ['test/**/*.serial.test.ts', '**/node_modules/**'],
    environment: 'node',
    setupFiles: ['./test/setup-bigint-json.ts'],
    // ~50 concurrently-forked test files (this suite plus packages/db's own)
    // all share ONE IP-keyed default throttle bucket (RedisThrottlerStorage
    // is real, shared state across every forked worker — see its own doc
    // comment). At the production default of 100 req/60s, that shared
    // bucket is exhausted by test VOLUME alone, well before any single
    // test's own logic does anything wrong. Raising it here only affects
    // this test run's environment (see app.module.ts's
    // DEFAULT_THROTTLE_LIMIT read — unset still means 100, unchanged for
    // every real install).
    env: {
      DEFAULT_THROTTLE_LIMIT: '2000',
    },
    // Capped, not left at vitest's default (== CPU count, 16 on this
    // machine's dev box). Instrumentation (see CLAUDE.md's Phase 7
    // CI-reliability decisions) showed the full-suite flakiness was NOT
    // connection-count exhaustion (peak observed 39/100 against
    // max_connections=100) — it was CPU/IO contention slowing individual
    // transactions down past Prisma's maxWait and widening the window for
    // postsales-property.test.ts's abandoned-timeout self-race. Fewer
    // concurrent forks means less contention, which directly shrinks both
    // failure windows. 4 forks x 15 connections/file (connection_limit=10
    // tenant + 5 system, scripts/test-setup.sh) = 60, comfortably under
    // Postgres's max_connections=100 even alongside packages/db's own
    // uncapped test run (peak measured well below the theoretical max).
    poolOptions: {
      forks: {
        // minForks must be set explicitly alongside maxForks — vitest's
        // own default minForks is NOT 1, it's derived from CPU count too,
        // so specifying only maxForks here throws "minThreads and
        // maxThreads must not conflict" (min > max) at collection time.
        minForks: 1,
        maxForks: 4,
      },
    },
  },
});
