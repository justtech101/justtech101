import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // All test files share one Postgres database, so run them one at a time.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
