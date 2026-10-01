import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // These tests run against a real Postgres. Several of them assert on
    // database constraints and on cross-implementation parity between the SQL
    // and TypeScript pricing paths, neither of which a mock can verify.
    // Running them in a single fork keeps their fixtures from colliding.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
