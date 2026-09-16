import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Vitest defaults NODE_ENV to 'test', which env.js's own startup
    // validation rejects (it only ever accepts 'development'/'production' —
    // a deliberate strictness this suite shouldn't weaken). Force it back
    // to 'development' for the test run only; server/.env's real MONGODB_URI
    // is still never used, since setup.js connects mongoose to its own
    // mongodb-memory-server instance instead.
    env: { NODE_ENV: 'development' },
    setupFiles: ['./test/setup.js'],
    testTimeout: 20000,
    hookTimeout: 30000,
    // Real regressions almost always hinge on two requests racing the same
    // document — running test files in parallel workers would let unrelated
    // suites interleave their own DB writes unpredictably against the same
    // in-memory MongoDB instance. Sequential keeps every test's timing
    // assumptions (concurrent-request races included) deterministic.
    fileParallelism: false,
  },
});
